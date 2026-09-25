// App state in one small external store (read with useStore(selector)).
import { useSyncExternalStore } from "react";
import { api, uploadFile, setToken } from "./api.js";
import { ROOM_IDS, ONLINE_TTL } from "../../shared/constants.js";

let state = {
  status: "boot", // boot | ready | error
  me: null, ai: { enabled: false }, admin: false,
  convs: {}, // cid -> conv (with head)
  inbox: { convs: {}, reads: {} },
  users: {},
  msgs: {}, // cid -> { list, hasMore, loading }
  active: null,
  presence: {},
  now: Date.now(),
  conn: "connecting", // live | poll | offline | connecting
  aiThinking: {}, // cid -> true while Gemini answers
  toasts: [],
};
const subs = new Set();
function set(patch) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  subs.forEach((f) => f());
}
export const getState = () => state;
export function useStore(sel) {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => sel(state));
}

// ---------- toasts ----------
export function toast(text, kind = "info") {
  const id = Math.random().toString(36).slice(2);
  set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === "error" ? 5000 : 2800);
}

// ---------- boot ----------
let hashBound = false;
export async function boot() {
  try {
    const b = await api("/api/bootstrap");
    const convs = Object.fromEntries(b.convs.map((c) => [c.id, c]));
    set({ status: "ready", me: b.me, ai: b.ai, admin: b.admin, convs, inbox: b.inbox, users: { ...b.users, [b.me.id]: b.me } });
    const hash = decodeURIComponent(location.hash.slice(1));
    const start = convs[hash] ? hash : window.innerWidth > 860 ? "lobby" : null;
    if (start) openConv(start);
    if (!hashBound) {
      hashBound = true;
      // Links like /#placements (and the browser's back/forward buttons) open that conversation.
      window.addEventListener("hashchange", () => {
        const h = decodeURIComponent(location.hash.slice(1));
        if (h && state.convs[h] && h !== state.active) openConv(h);
      });
    }
    heartbeat();
    return true;
  } catch (e) {
    set({ status: e.status === 401 ? "signed-out" : "error", bootError: e.message });
    return false;
  }
}

export function signOut() {
  setToken(null);
  location.hash = "";
  location.reload();
}

// ---------- conversations ----------
export function convTitle(c, s = state) {
  if (!c) return "";
  if (c.type === "room") return `#${c.name}`;
  if (c.type === "group") return c.name;
  const other = c.members.find((m) => m !== s.me?.id);
  return s.users[other]?.name || "Direct message";
}

export function otherUser(c, s = state) {
  if (!c || c.type !== "dm") return null;
  return s.users[c.members.find((m) => m !== s.me?.id)] || null;
}

export function unreadFor(c, s = state) {
  if (!c) return 0;
  if (c.type === "room") {
    const r = s.inbox.reads?.[c.id];
    return r == null ? 0 : Math.max(0, (c.head?.seq ?? -1) - r);
  }
  return s.inbox.convs?.[c.id]?.unread || 0;
}

export function sortedConvs(s = state) {
  const all = Object.values(s.convs);
  const rooms = ROOM_IDS.map((id) => s.convs[id]).filter(Boolean);
  const others = all.filter((c) => c.type !== "room").sort((a, b) => String(b.head?.lastAt || b.createdAt).localeCompare(String(a.head?.lastAt || a.createdAt)));
  return { rooms, others };
}

let liveHooks = null;
export function registerLive(hooks) { liveHooks = hooks; }

export async function openConv(cid) {
  if (!cid) { set({ active: null }); location.hash = ""; liveHooks?.setActive(null); return; }
  set({ active: cid });
  history.replaceState(null, "", `#${encodeURIComponent(cid)}`);
  if (!state.msgs[cid]) { await loadMessages(cid); refreshPresence(); }
  liveHooks?.setActive(cid);
  markReadSoon(cid);
}

export async function loadMessages(cid, { older = false } = {}) {
  const cur = state.msgs[cid];
  if (cur?.loading) return;
  set((s) => ({ msgs: { ...s.msgs, [cid]: { list: cur?.list || [], hasMore: cur?.hasMore ?? true, loading: true } } }));
  try {
    const before = older && cur?.list?.length ? cur.list.find((m) => m.seq != null)?.seq : null;
    const r = await api(`/api/convs/${encodeURIComponent(cid)}/messages${before != null ? `?before=${before}` : ""}`);
    set((s) => {
      const existing = s.msgs[cid]?.list || [];
      const merged = mergeMsgs(older ? [...r.messages, ...existing] : [...existing, ...r.messages]);
      return {
        msgs: { ...s.msgs, [cid]: { list: merged, hasMore: r.hasMore, loading: false } },
        users: { ...s.users, ...r.users },
        convs: s.convs[cid] ? { ...s.convs, [cid]: { ...s.convs[cid], head: { ...s.convs[cid].head, ...r.head } } } : s.convs,
      };
    });
  } catch (e) {
    set((s) => ({ msgs: { ...s.msgs, [cid]: { ...(s.msgs[cid] || { list: [] }), loading: false } } }));
    toast(e.message, "error");
  }
}

function mergeMsgs(list) {
  const bySeq = new Map();
  const pending = [];
  for (const m of list) {
    if (m.seq == null) { pending.push(m); continue; }
    bySeq.set(m.seq, { ...(bySeq.get(m.seq) || {}), ...m });
  }
  const confirmed = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  const cmids = new Set(confirmed.map((m) => m.cmid).filter(Boolean));
  return [...confirmed, ...pending.filter((p) => !cmids.has(p.cmid))];
}

export function lastSeq(cid, s = state) {
  const list = s.msgs[cid]?.list || [];
  for (let i = list.length - 1; i >= 0; i--) if (list[i].seq != null) return list[i].seq;
  return s.convs[cid]?.head?.seq ?? -1;
}

// ---------- live events ----------
export function applyMessages(cid, messages) {
  if (!messages.length) return;
  set((s) => {
    const cur = s.msgs[cid];
    const users = { ...s.users };
    for (const m of messages) if (m.senderId && !users[m.senderId]) users[m.senderId] = { id: m.senderId, name: m.senderName, hue: m.hue };
    const thinking = { ...s.aiThinking };
    if (messages.some((m) => m.senderId === "gemini")) delete thinking[cid];
    // New arrivals animate in; messages already on screen (or our own confirmed sends) don't re-animate.
    const have = new Set((cur?.list || []).map((m) => m.seq ?? m.cmid));
    const incoming = messages.map((m) => (have.has(m.seq) || have.has(m.cmid) ? m : { ...m, fresh: true }));
    return {
      users,
      aiThinking: thinking,
      msgs: cur ? { ...s.msgs, [cid]: { ...cur, list: mergeMsgs([...cur.list, ...incoming]) } } : s.msgs,
    };
  });
  const now = Date.now();
  for (const m of messages) {
    const at = Date.parse(m.at);
    if (at && now - at < 60000) seen(m.senderId, Math.min(at, now));
  }
  if (cid === state.active) markReadSoon(cid);
}

export function applyEdits(cid, messages) {
  set((s) => {
    const cur = s.msgs[cid];
    if (!cur) return {};
    const by = new Map(messages.map((m) => [m.seq, m]));
    return { msgs: { ...s.msgs, [cid]: { ...cur, list: cur.list.map((m) => (by.has(m.seq) ? { ...m, ...by.get(m.seq) } : m)) } } };
  });
}

export function applyHead(cid, head) {
  set((s) => (s.convs[cid] ? { convs: { ...s.convs, [cid]: { ...s.convs[cid], head: { ...s.convs[cid].head, ...head } } } } : {}));
  for (const [uid, v] of Object.entries(head?.typing || {})) if (v?.t && Date.now() - v.t < 10000) seen(uid, v.t);
}

export async function applyInbox(inbox) {
  const known = new Set(Object.keys(state.convs));
  set({ inbox });
  const fresh = Object.keys(inbox.convs || {}).filter((cid) => !known.has(cid));
  for (const cid of fresh) {
    try {
      const r = await api(`/api/convs/${encodeURIComponent(cid)}`);
      set((s) => ({ convs: { ...s.convs, [cid]: r.conv }, users: { ...s.users, ...r.users } }));
    } catch { /* ignore */ }
  }
}

export function setConn(conn) { if (state.conn !== conn) set({ conn }); }

// ---------- actions ----------
let readTimer = null;
export function markReadSoon(cid) {
  clearTimeout(readTimer);
  readTimer = setTimeout(async () => {
    if (document.hidden || state.active !== cid) return;
    const seq = lastSeq(cid);
    if (seq < 0) return;
    const c = state.convs[cid];
    const already = c?.type === "room" ? state.inbox.reads?.[cid] : state.inbox.convs?.[cid]?.read;
    const unread = unreadFor(c);
    if (already != null && already >= seq && !unread) return;
    // Optimistic: clear the badge now.
    set((s) => {
      const inbox = { ...s.inbox, reads: { ...s.inbox.reads }, convs: { ...s.inbox.convs } };
      if (c?.type === "room") inbox.reads[cid] = seq;
      else if (inbox.convs[cid]) inbox.convs[cid] = { ...inbox.convs[cid], unread: 0, read: seq };
      return { inbox };
    });
    api(`/api/convs/${encodeURIComponent(cid)}/read`, { method: "POST", body: { seq } }).catch(() => {});
  }, 600);
}

export async function sendMessage(cid, { text, replyTo, file }) {
  const cmid = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const me = state.me;
  const temp = { cmid, seq: null, pending: true, senderId: me.id, senderName: me.name, hue: me.hue, text, type: file ? "file" : "text", file, at: new Date().toISOString(),
    replyTo: replyTo ? { seq: replyTo.seq, senderName: replyTo.senderName, text: replyTo.text } : null, mentionsGemini: /(^|\s)@gemini\b/i.test(text || "") };
  set((s) => ({ msgs: { ...s.msgs, [cid]: { ...(s.msgs[cid] || { list: [], hasMore: false }), list: [...(s.msgs[cid]?.list || []), temp] } } }));
  try {
    const r = await api(`/api/convs/${encodeURIComponent(cid)}/messages`, { method: "POST", body: { text, replyTo: replyTo?.seq, fileId: file?.id, cmid } });
    applyMessages(cid, [r.message]);
    if (r.message.mentionsGemini && state.ai.enabled) askGemini(cid, r.message.seq);
    return r.message;
  } catch (e) {
    set((s) => ({ msgs: { ...s.msgs, [cid]: { ...s.msgs[cid], list: s.msgs[cid].list.map((m) => (m.cmid === cmid ? { ...m, pending: false, failed: e.message } : m)) } } }));
    toast(e.message, "error");
    return null;
  }
}

export function discardFailed(cid, cmid) {
  set((s) => ({ msgs: { ...s.msgs, [cid]: { ...s.msgs[cid], list: s.msgs[cid].list.filter((m) => m.cmid !== cmid) } } }));
}

async function askGemini(cid, seq) {
  set((s) => ({ aiThinking: { ...s.aiThinking, [cid]: true } }));
  try {
    const r = await api(`/api/convs/${encodeURIComponent(cid)}/ai/reply`, { method: "POST", body: { seq } });
    if (r.message) applyMessages(cid, [r.message]);
  } catch (e) {
    toast(`Gemini: ${e.message}`, "error");
  } finally {
    set((s) => { const t = { ...s.aiThinking }; delete t[cid]; return { aiThinking: t }; });
  }
}

export async function patchMessage(cid, seq, body) {
  try {
    const r = await api(`/api/convs/${encodeURIComponent(cid)}/messages/${seq}`, { method: "PATCH", body });
    if (r.message) applyEdits(cid, [r.message]);
  } catch (e) { toast(e.message, "error"); }
}

let typingAt = 0;
export function typing(cid) {
  if (Date.now() - typingAt < 2500) return;
  typingAt = Date.now();
  api(`/api/convs/${encodeURIComponent(cid)}/typing`, { method: "POST", body: {} }).catch(() => {});
}

export async function upload(file, onProgress) {
  let w = null, h = null;
  if (file.type.startsWith("image/")) {
    try { const bmp = await createImageBitmap(file); w = bmp.width; h = bmp.height; bmp.close?.(); } catch { /* not decodable */ }
  }
  return uploadFile(file, { w, h }, onProgress);
}

export async function startDm(uid) {
  const r = await api("/api/convs", { method: "POST", body: { type: "dm", with: uid } });
  set((s) => ({ convs: { ...s.convs, [r.conv.id]: r.conv }, users: { ...s.users, ...r.users }, inbox: { ...s.inbox, convs: { ...s.inbox.convs, [r.conv.id]: s.inbox.convs[r.conv.id] || { unread: 0 } } } }));
  await openConv(r.conv.id);
}

export async function createGroup(name, members, emoji) {
  const r = await api("/api/convs", { method: "POST", body: { type: "group", name, members, emoji } });
  set((s) => ({ convs: { ...s.convs, [r.conv.id]: r.conv }, users: { ...s.users, ...r.users }, inbox: { ...s.inbox, convs: { ...s.inbox.convs, [r.conv.id]: { unread: 0 } } } }));
  await openConv(r.conv.id);
}

export async function updateMe(patch) {
  const r = await api("/api/me", { method: "PATCH", body: patch });
  set((s) => ({ me: r.user, users: { ...s.users, [r.user.id]: r.user } }));
}

// ---------- presence ----------
let hb = null;
let clock = null;
export async function refreshPresence() {
  const ids = new Set();
  for (const c of Object.values(state.convs)) (c.members || []).forEach((m) => ids.add(m));
  for (const m of (state.msgs[state.active]?.list || []).slice(-40)) if (m.senderId?.startsWith("u")) ids.add(m.senderId);
  ids.delete(state.me?.id);
  if (!ids.size) return;
  try {
    const r = await api(`/api/presence?ids=${[...ids].slice(0, 100).join(",")}`);
    set((s) => ({ presence: { ...s.presence, ...r.presence }, now: r.now }));
  } catch { /* ignore */ }
}
// Anyone who just sent a message or is typing is online; no need to wait for the next poll.
function seen(uid, at) {
  if (!uid?.startsWith("u") || uid === state.me?.id || !at) return;
  if ((state.presence[uid] || 0) >= at) return;
  set((s) => ({ presence: { ...s.presence, [uid]: at }, now: Math.max(s.now || 0, Date.now()) }));
}
function heartbeat() {
  clearInterval(hb);
  clearInterval(clock);
  const beat = () => {
    if (document.hidden) return;
    api("/api/presence", { method: "POST", body: {} }).catch(() => {});
    refreshPresence();
  };
  beat();
  hb = setInterval(beat, 40000);
  clock = setInterval(() => set({ now: Date.now() }), 30000);
}

export function isOnline(uid, s = state) {
  if (uid === s.me?.id) return true;
  const at = s.presence[uid];
  return Boolean(at && s.now - at < ONLINE_TTL);
}
