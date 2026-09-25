// Parley's data layer on Netlify Blobs.
//
// Keys (store "parley"):
//   users/<uid>               profile + password hash
//   handles/<handle>          { uid }  (unique usernames)
//   d/<handle>~<uid>~…        directory entries for search (fields live in the key)
//   conv/<cid>                conversation: room | dm | group
//   head/<cid>                latest seq, last message preview, typing, read receipts, edit log
//   m/<cid>/<seq>             one message (seq claimed with an only-if-new write)
//   inbox/<uid>               the user's DMs/groups with unread counts, and room read positions
//   presence/<uid>            last seen
//   file/<id>                 uploaded file bytes (+ metadata)
//
// Message numbering can't race: each seq is claimed with onlyIfNew. Other
// shared documents use optimistic concurrency (read with an ETag, write with
// onlyIfMatch, retry on conflict) where the platform returns ETags.

import { getStore } from "@netlify/blobs";
import { ROOMS, ROOM_IDS, SYSTEM_USER, TYPING_TTL } from "../../shared/constants.js";
import { HttpError } from "./http.mjs";

export const store = () => getStore({ name: "parley", consistency: "strong" });

export async function getJSON(key) {
  return store().get(key, { type: "json" });
}

export async function setJSON(key, value) {
  return store().setJSON(key, value);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Atomically update a JSON blob. fn(current|null) returns the next value,
 * or undefined to leave it unchanged. Retries when someone else wrote first.
 */
export async function update(key, fn, { retries = 12 } = {}) {
  const s = store();
  for (let i = 0; i < retries; i++) {
    const cur = await s.getWithMetadata(key, { type: "json" });
    const prev = cur ? cur.data : null;
    const next = await fn(prev ? structuredClone(prev) : null);
    if (next === undefined) return prev;
    const res = cur ? await s.setJSON(key, next, { onlyIfMatch: cur.etag }) : await s.setJSON(key, next, { onlyIfNew: true });
    if (res.modified) return next;
    await sleep(15 + Math.random() * 40 * (i + 1));
  }
  throw new HttpError(503, "The server is busy. Please try again.");
}

// ---------- users ----------

export function publicUser(u) {
  if (!u) return null;
  return { id: u.id, handle: u.handle, name: u.name, hue: u.hue, guest: !!u.guest, about: u.about || "", createdAt: u.createdAt, bot: !!u.bot };
}

export async function getUser(uid) {
  if (uid === SYSTEM_USER.id) return SYSTEM_USER;
  if (uid === "gemini") return { id: "gemini", handle: "gemini", name: "Gemini", hue: 262, bot: true };
  return getJSON(`users/${uid}`);
}

// The directory is one key per user, with the searchable fields encoded in
// the key itself, so listing needs no reads and sign-ups never contend.
const dirKey = (u) => `d/${u.handle}~${u.id}~${u.hue}~${u.guest ? 1 : 0}~${encodeURIComponent(u.name)}`;

export async function addToDirectory(u) {
  const s = store();
  const { blobs } = await s.list({ prefix: `d/${u.handle}~${u.id}~` });
  const key = dirKey(u);
  await Promise.all(blobs.filter((b) => b.key !== key).map((b) => s.delete(b.key)));
  await s.set(key, "1");
}

export async function directory() {
  const { blobs } = await store().list({ prefix: "d/" });
  return blobs.map((b) => {
    const [handle, id, hue, guest, name] = b.key.slice(2).split("~");
    return { handle, id, hue: Number(hue), guest: guest === "1", name: decodeURIComponent(name || "") };
  });
}

// ---------- conversations ----------

export async function ensureRooms() {
  const s = store();
  await Promise.all(ROOMS.map(async (r) => {
    const res = await s.setJSON(`conv/${r.id}`, { id: r.id, type: "room", name: r.name, emoji: r.emoji, topic: r.topic, createdAt: new Date().toISOString() }, { onlyIfNew: true });
    if (res.modified) {
      await appendMessage(r.id, (seq) => ({
        seq, id: `${r.id}-${seq}`, type: "system", senderId: SYSTEM_USER.id, senderName: SYSTEM_USER.name, hue: SYSTEM_USER.hue, at: new Date().toISOString(),
        text: r.id === "lobby" ? "Welcome to Parley! 👋 This room is public. Mention @gemini in any chat and it'll reply." : `This is #${r.name}. ${r.topic}`,
      }));
    }
  }));
}

export async function getConv(cid) {
  if (!/^[A-Za-z0-9_-]{2,80}$/.test(cid)) throw new HttpError(400, "Bad conversation id.");
  const c = await getJSON(`conv/${cid}`);
  if (!c) {
    if (ROOM_IDS.includes(cid)) { await ensureRooms(); return getJSON(`conv/${cid}`); }
    throw new HttpError(410, "This conversation doesn't exist.");
  }
  return c;
}

export function canAccess(conv, uid) {
  return conv.type === "room" || conv.members.includes(uid);
}

export async function requireAccess(cid, uid) {
  const conv = await getConv(cid);
  if (!canAccess(conv, uid)) throw new HttpError(401, "You're not in this conversation.");
  return conv;
}

// ---------- messages ----------

export async function getHead(cid) {
  return (await getJSON(`head/${cid}`)) || { seq: -1, typing: {}, reads: {}, edits: [], rv: 0 };
}

/**
 * Append a message. Every message lives at m/<cid>/<seq>, and a writer claims
 * its seq with an "only if new" write, so two people sending at once can
 * never get the same number. build(seq) returns the message for that seq.
 */
export async function appendMessage(cid, build) {
  const s = store();
  const head = await getHead(cid);
  let seq = await probeForward(cid, head.seq);
  seq += 1;
  const nonce = crypto.randomUUID();
  for (let attempt = 0; attempt < 40; attempt++) {
    const msg = { ...build(seq), nonce };
    const res = await s.setJSON(`m/${cid}/${seq}`, msg, { onlyIfNew: true });
    if (!res.modified) { seq += 1; continue; }
    // Belt and braces: confirm the slot really holds our message before reporting success.
    const check = await s.get(`m/${cid}/${seq}`, { type: "json" });
    if (check?.nonce !== nonce) { seq += 1; continue; }
    await update(`head/${cid}`, (h) => {
      h = h || { seq: -1, typing: {}, reads: {}, edits: [], rv: 0 };
      if (seq > h.seq) {
        h.seq = seq;
        h.lastAt = msg.at;
        h.last = { seq, senderId: msg.senderId, senderName: msg.senderName, type: msg.type, text: preview(msg) };
      }
      if (h.typing) delete h.typing[msg.senderId];
      return h;
    });
    return msg;
  }
  throw new HttpError(503, "Too many messages at once. Please try again.");
}

/** The head can lag behind under heavy concurrency; walk forward to the real latest seq. */
export async function probeForward(cid, seq) {
  const s = store();
  for (let i = 0; i < 50; i++) {
    const next = await s.getMetadata(`m/${cid}/${seq + 1}`);
    if (!next) return seq;
    seq += 1;
  }
  return seq;
}

/** The head with its seq corrected to the latest stored message. */
export async function freshHead(cid) {
  const h = await getHead(cid);
  h.seq = await probeForward(cid, h.seq);
  return h;
}

export function preview(m) {
  if (m.deleted) return "Message deleted";
  if (m.type === "file") return m.file?.mime?.startsWith("image/") ? "📷 Photo" : `📎 ${m.file?.name || "File"}`;
  return String(m.text || "").slice(0, 120);
}

/** Messages with seq in [from, to] (inclusive), oldest first. */
export async function readRange(cid, from, to) {
  if (to < from || to < 0) return [];
  from = Math.max(0, from);
  const s = store();
  const msgs = await Promise.all(Array.from({ length: to - from + 1 }, (_, i) => s.get(`m/${cid}/${from + i}`, { type: "json" })));
  return msgs.filter(Boolean);
}

/** Change one message in place (edit, react, delete). fn returns the new message or undefined. */
export async function updateMessage(cid, seq, fn) {
  let changed = null;
  await update(`m/${cid}/${seq}`, (m) => {
    if (!m) throw new HttpError(410, "Message not found.");
    const next = fn(m);
    if (!next) return undefined;
    changed = next;
    return next;
  });
  if (changed) {
    await update(`head/${cid}`, (h) => {
      h = h || { seq: -1, typing: {}, reads: {}, edits: [], rv: 0 };
      h.rv = (h.rv || 0) + 1;
      h.edits = [...(h.edits || []).filter((e) => e !== seq), seq].slice(-30);
      if (h.last && h.last.seq === seq) h.last.text = preview(changed);
      return h;
    });
  }
  return changed;
}

export async function setTyping(cid, user) {
  await update(`head/${cid}`, (h) => {
    h = h || { seq: -1, typing: {}, reads: {}, edits: [], rv: 0 };
    const now = Date.now();
    const typing = {};
    for (const [k, v] of Object.entries(h.typing || {})) if (now - v.t < TYPING_TTL) typing[k] = v;
    if (typing[user.id] && now - typing[user.id].t < 2000) return undefined; // throttle writes
    typing[user.id] = { t: now, name: user.name };
    h.typing = typing;
    return h;
  });
}

export async function markRead(conv, uid, seq) {
  if (conv.type === "room") {
    await update(`inbox/${uid}`, (b) => {
      b = b || { convs: {}, reads: {} };
      b.reads = b.reads || {};
      if ((b.reads[conv.id] ?? -1) >= seq) return undefined;
      b.reads[conv.id] = seq;
      return b;
    });
    return;
  }
  await Promise.all([
    update(`inbox/${uid}`, (b) => {
      b = b || { convs: {}, reads: {} };
      const e = b.convs[conv.id];
      if (!e || (e.unread === 0 && (e.read ?? -1) >= seq)) return undefined;
      e.unread = 0;
      e.read = Math.max(e.read ?? -1, seq);
      return b;
    }),
    update(`head/${conv.id}`, (h) => {
      h = h || { seq: -1, typing: {}, reads: {}, edits: [], rv: 0 };
      h.reads = h.reads || {};
      if ((h.reads[uid] ?? -1) >= seq) return undefined;
      h.reads[uid] = seq;
      return h;
    }),
  ]);
}

/** Fan out a new DM/group message to every member's inbox. */
export async function fanOut(conv, msg) {
  await Promise.all(conv.members.map((uid) => update(`inbox/${uid}`, (b) => {
    b = b || { convs: {}, reads: {} };
    const e = b.convs[conv.id] || { unread: 0 };
    e.seq = Math.max(e.seq ?? -1, msg.seq);
    e.at = msg.at;
    e.preview = preview(msg);
    e.from = msg.senderName;
    if (uid !== msg.senderId) e.unread = (e.unread || 0) + 1;
    else { e.unread = 0; e.read = msg.seq; }
    b.convs[conv.id] = e;
    b.v = (b.v || 0) + 1;
    return b;
  })));
}

export async function addConvToInboxes(conv) {
  await Promise.all(conv.members.map((uid) => update(`inbox/${uid}`, (b) => {
    b = b || { convs: {}, reads: {} };
    if (b.convs[conv.id]) return undefined;
    b.convs[conv.id] = { unread: 0, seq: -1, at: conv.createdAt, preview: "", from: "" };
    b.v = (b.v || 0) + 1;
    return b;
  })));
}

// ---------- presence ----------

export async function touchPresence(uid) {
  await store().setJSON(`presence/${uid}`, { at: Date.now() });
}

export async function presence(ids) {
  const out = {};
  await Promise.all(ids.slice(0, 100).map(async (id) => {
    const p = await getJSON(`presence/${id}`);
    out[id] = p?.at || null;
  }));
  return out;
}
