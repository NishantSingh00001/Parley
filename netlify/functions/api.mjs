// Parley's REST API: one function with a small router, so every route
// shares a warm instance. The live stream is a separate edge function.

import { json, fail, readJson, HttpError, handler } from "../lib/http.mjs";
import {
  store, getJSON, update, getConv, requireAccess, getHead, freshHead, appendMessage, readRange,
  updateMessage, setTyping, markRead, fanOut, addConvToInboxes, ensureRooms, directory, addToDirectory,
  touchPresence, presence, publicUser, getUser,
} from "../lib/db.mjs";
import { requireUser, createUser, checkPassword, issueToken, liveTicket, guestName, validHandle, rateLimit, ipHash, newId } from "../lib/auth.mjs";
import { clean } from "../lib/moderation.mjs";
import { aiConfigured, modelChain } from "../lib/gemini.mjs";
import { mentionReply, smartReplies, catchUp, translate } from "../lib/ai.mjs";
import { ROOMS, ROOM_IDS, GEMINI_USER, PAGE, MAX_TEXT, MAX_FILE, REACTIONS, dmId, env } from "../../shared/constants.js";

const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`), fn });

const now = () => new Date().toISOString();
const isAdmin = (u) => (env("ADMIN_HANDLES") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).includes(u.handle);

async function session(user) {
  return { token: await issueToken(user), user: publicUser(user) };
}

// ---------- auth ----------

route("POST", "/api/auth/signup", async (req, ctx) => {
  const b = await readJson(req);
  const handle = String(b.handle || "").trim().toLowerCase();
  const name = String(b.name || "").trim().replace(/\s+/g, " ").slice(0, 40);
  const password = String(b.password || "");
  if (!validHandle(handle)) throw new HttpError(400, "Usernames are 3–20 characters: lowercase letters, numbers and _.");
  if (handle === "gemini" || handle === "parley" || handle.startsWith("guest")) throw new HttpError(400, "That username is reserved.");
  if (name.length < 2) throw new HttpError(400, "Add a display name (at least 2 characters).");
  if (password.length < 8) throw new HttpError(400, "Passwords need at least 8 characters.");
  await rateLimit(`signup:${ipHash(ctx.ip)}`, 10, 3600);
  const user = await createUser({ handle, name: clean(name), password });
  return json(await session(user), 201);
});

route("POST", "/api/auth/login", async (req, ctx) => {
  const b = await readJson(req);
  const handle = String(b.handle || "").trim().toLowerCase().replace(/^@/, "");
  await rateLimit(`login:${ipHash(ctx.ip)}`, 30, 900);
  const h = validHandle(handle) ? await getJSON(`handles/${handle}`) : null;
  const user = h ? await getJSON(`users/${h.uid}`) : null;
  if (!user || !user.pass || !(await checkPassword(String(b.password || ""), user.pass))) throw new HttpError(401, "Wrong username or password.");
  return json(await session(user));
});

route("POST", "/api/auth/guest", async (req, ctx) => {
  await rateLimit(`guest:${ipHash(ctx.ip)}`, 20, 3600);
  const name = guestName();
  const handle = `guest_${newId("").slice(0, 8)}`;
  const user = await createUser({ handle, name, guest: true });
  return json(await session(user), 201);
});

// ---------- me / bootstrap ----------

route("GET", "/api/bootstrap", async (req) => {
  const me = await requireUser(req);
  await ensureRooms();
  const inbox = (await getJSON(`inbox/${me.id}`)) || { convs: {}, reads: {} };
  const ids = [...ROOM_IDS, ...Object.keys(inbox.convs)];
  const convs = (await Promise.all(ids.map(async (cid) => {
    const [conv, head] = await Promise.all([getJSON(`conv/${cid}`), getHead(cid)]);
    return conv ? { ...conv, head: slimHead(head) } : null;
  }))).filter(Boolean);
  const memberIds = new Set(convs.flatMap((c) => c.members || []));
  const users = await usersById([...memberIds]);
  touchPresence(me.id).catch(() => {});
  return json({ me: publicUser(me), convs, inbox, users, ai: aiConfigured() ? { enabled: true, model: modelChain()[0] } : { enabled: false }, admin: isAdmin(me) });
});

route("PATCH", "/api/me", async (req) => {
  const me = await requireUser(req);
  const b = await readJson(req);
  const next = await update(`users/${me.id}`, (u) => {
    if (b.name != null) {
      const name = clean(String(b.name).trim().replace(/\s+/g, " ").slice(0, 40));
      if (name.length < 2) throw new HttpError(400, "Display names need at least 2 characters.");
      u.name = name;
    }
    if (b.about != null) u.about = clean(String(b.about).slice(0, 140));
    return u;
  });
  await addToDirectory(next);
  return json({ user: publicUser(next) });
});

function slimHead(h) {
  return { seq: h.seq, lastAt: h.lastAt || null, last: h.last || null, rv: h.rv || 0, reads: h.reads || {}, typing: h.typing || {} };
}

async function usersById(ids) {
  const out = {};
  await Promise.all(ids.map(async (id) => { const u = await getUser(id); if (u) out[id] = publicUser(u); }));
  return out;
}

route("GET", "/api/users", async (req) => {
  const me = await requireUser(req);
  const q = (new URL(req.url).searchParams.get("q") || "").trim().toLowerCase();
  const list = (await directory()).filter((u) => u.id !== me.id);
  const hits = q ? list.filter((u) => u.handle.includes(q) || u.name.toLowerCase().includes(q)) : list.slice(-30).reverse();
  return json({ users: hits.slice(0, 30) });
});

// ---------- conversations ----------

route("POST", "/api/convs", async (req) => {
  const me = await requireUser(req);
  const b = await readJson(req);
  if (b.type === "dm") {
    const withId = String(b.with || "");
    const other = /^u[a-f0-9]{16}$/.test(withId) ? await getJSON(`users/${withId}`) : null;
    if (!other || other.id === me.id) throw new HttpError(400, "Pick someone to message.");
    const cid = dmId(me.id, other.id);
    const conv = { id: cid, type: "dm", members: [me.id, other.id], createdBy: me.id, createdAt: now() };
    await store().setJSON(`conv/${cid}`, conv, { onlyIfNew: true });
    const saved = await getJSON(`conv/${cid}`);
    await addConvToInboxes(saved);
    return json({ conv: { ...saved, head: slimHead(await getHead(cid)) }, users: await usersById(saved.members) }, 201);
  }
  if (b.type === "group") {
    const name = clean(String(b.name || "").trim().slice(0, 40));
    if (name.length < 2) throw new HttpError(400, "Give the group a name.");
    const members = [...new Set([me.id, ...(Array.isArray(b.members) ? b.members.map(String) : [])])].slice(0, 30);
    if (members.some((id) => !/^u[a-f0-9]{16}$/.test(id))) throw new HttpError(400, "One of those people doesn't exist.");
    const found = await Promise.all(members.map((id) => getJSON(`users/${id}`)));
    if (found.some((u) => !u)) throw new HttpError(400, "One of those people doesn't exist.");
    if (members.length < 2) throw new HttpError(400, "Add at least one other person.");
    await rateLimit(`group:${me.id}`, 10, 3600);
    const conv = { id: newId("g"), type: "group", name, emoji: String(b.emoji || "💬").slice(0, 4), members, createdBy: me.id, createdAt: now() };
    await store().setJSON(`conv/${conv.id}`, conv);
    await appendMessage(conv.id, (seq) => ({ seq, id: `${conv.id}-${seq}`, type: "system", senderId: "system", senderName: "Parley", hue: 330, at: now(), text: `${me.name} created ${name}` }));
    await addConvToInboxes(conv);
    return json({ conv: { ...conv, head: slimHead(await getHead(conv.id)) }, users: await usersById(members) }, 201);
  }
  throw new HttpError(400, 'type must be "dm" or "group".');
});

route("GET", "/api/convs/:cid", async (req, ctx, p) => {
  const me = await requireUser(req);
  const conv = await requireAccess(p.cid, me.id);
  return json({ conv: { ...conv, head: slimHead(await getHead(conv.id)) }, users: await usersById(conv.members || []) });
});

route("GET", "/api/convs/:cid/messages", async (req, ctx, p) => {
  const me = await requireUser(req);
  await requireAccess(p.cid, me.id);
  const sp = new URL(req.url).searchParams;
  const head = await freshHead(p.cid);
  let msgs;
  if (sp.has("after")) {
    const after = Number(sp.get("after"));
    msgs = await readRange(p.cid, after + 1, Math.min(head.seq, after + PAGE));
  } else {
    const before = sp.has("before") ? Number(sp.get("before")) : head.seq + 1;
    msgs = await readRange(p.cid, before - PAGE, before - 1);
  }
  const senders = [...new Set(msgs.map((m) => m.senderId))];
  return json({ messages: msgs, head: slimHead(head), users: await usersById(senders), hasMore: msgs.length > 0 && msgs[0].seq > 0 });
});

route("POST", "/api/convs/:cid/messages", async (req, ctx, p) => {
  const me = await requireUser(req);
  const conv = await requireAccess(p.cid, me.id);
  const b = await readJson(req);
  let text = String(b.text || "").replace(/\r/g, "").trim();
  if (text.length > MAX_TEXT) throw new HttpError(400, `Messages can be up to ${MAX_TEXT} characters.`);
  let file = null;
  if (b.fileId) {
    const meta = (await store().getMetadata(`file/${String(b.fileId)}`))?.metadata;
    if (!meta || meta.uid !== me.id) throw new HttpError(400, "That upload wasn't found.");
    file = { id: String(b.fileId), name: meta.name, size: meta.size, mime: meta.mime, w: meta.w || null, h: meta.h || null };
  }
  if (!text && !file) throw new HttpError(400, "Write something first.");
  await rateLimit(`msg:${me.id}`, 20, 60);
  if (conv.type === "room") text = clean(text);
  let replyTo = null;
  if (Number.isInteger(b.replyTo)) {
    const [orig] = await readRange(conv.id, b.replyTo, b.replyTo);
    if (orig) replyTo = { seq: orig.seq, senderName: orig.senderName, text: orig.deleted ? "Message deleted" : String(orig.text || (orig.file ? `📎 ${orig.file.name}` : "")).slice(0, 140) };
  }
  const msg = await appendMessage(conv.id, (seq) => ({
    seq, id: `${conv.id}-${seq}`, type: file ? "file" : "text", senderId: me.id, senderName: me.name, hue: me.hue,
    text, file, replyTo, at: now(), mentionsGemini: /(^|\s)@gemini\b/i.test(text),
    cmid: typeof b.cmid === "string" ? b.cmid.slice(0, 40) : undefined,
  }));
  if (conv.type !== "room") await fanOut(conv, msg);
  touchPresence(me.id).catch(() => {});
  return json({ message: msg }, 201);
});

route("PATCH", "/api/convs/:cid/messages/:seq", async (req, ctx, p) => {
  const me = await requireUser(req);
  const conv = await requireAccess(p.cid, me.id);
  const seq = Number(p.seq);
  const b = await readJson(req);
  const admin = isAdmin(me);
  const msg = await updateMessage(conv.id, seq, (m) => {
    if (b.react) {
      if (!REACTIONS.includes(b.react)) throw new HttpError(400, "Unsupported reaction.");
      const r = { ...(m.reactions || {}) };
      const list = new Set(r[b.react] || []);
      list.has(me.id) ? list.delete(me.id) : list.add(me.id);
      if (list.size) r[b.react] = [...list]; else delete r[b.react];
      return { ...m, reactions: r };
    }
    if (m.senderId !== me.id && !(admin && b.delete)) throw new HttpError(401, "You can only change your own messages.");
    if (b.delete) return { ...m, deleted: true, text: "", file: null, reactions: {}, deletedBy: m.senderId === me.id ? undefined : "admin" };
    if (typeof b.text === "string") {
      const text = (conv.type === "room" ? clean(b.text) : b.text).trim().slice(0, MAX_TEXT);
      if (!text || m.deleted || m.type !== "text") return undefined;
      return { ...m, text, edited: now() };
    }
    return undefined;
  });
  return json({ message: msg });
});

route("POST", "/api/convs/:cid/typing", async (req, ctx, p) => {
  const me = await requireUser(req);
  await requireAccess(p.cid, me.id);
  await setTyping(p.cid, me);
  return json({ ok: true });
});

route("POST", "/api/convs/:cid/read", async (req, ctx, p) => {
  const me = await requireUser(req);
  const conv = await requireAccess(p.cid, me.id);
  const b = await readJson(req);
  const seq = Number(b.seq);
  if (!Number.isInteger(seq) || seq < 0) throw new HttpError(400, "Bad seq.");
  await markRead(conv, me.id, seq);
  return json({ ok: true });
});

// ---------- AI ----------

function requireAi() {
  if (!aiConfigured()) throw new HttpError(503, "Gemini isn't set up on this deployment yet.");
}

async function aiLimits(me) {
  await rateLimit(`ai:${me.id}`, 20, 3600);
  await rateLimit("ai:all", 500, 86400);
}

route("POST", "/api/convs/:cid/ai/reply", async (req, ctx, p) => {
  const me = await requireUser(req);
  const conv = await requireAccess(p.cid, me.id);
  requireAi();
  const b = await readJson(req);
  const seq = Number(b.seq);
  const [asked] = await readRange(conv.id, seq, seq);
  if (!asked || asked.senderId !== me.id || !asked.mentionsGemini) throw new HttpError(400, "That message didn't mention @gemini.");
  if (asked.answered) return json({ skipped: true });
  // Claim the question first so double-clicks can't trigger two answers.
  let claimed = false;
  await updateMessage(conv.id, seq, (m) => { if (m.answered) return undefined; claimed = true; return { ...m, answered: true }; });
  if (!claimed) return json({ skipped: true });
  await aiLimits(me);
  const head = await freshHead(conv.id);
  const history = await readRange(conv.id, Math.max(0, head.seq - 29), head.seq);
  let reply;
  try {
    reply = await mentionReply({ convName: conv.type === "room" ? `#${conv.name}` : conv.name || "a direct message", msgs: history, asker: me.name, question: asked.text.replace(/@gemini/gi, "").trim() || "hi" });
  } catch (e) {
    await updateMessage(conv.id, seq, (m) => ({ ...m, answered: false }));
    throw e;
  }
  const msg = await appendMessage(conv.id, (s) => ({
    seq: s, id: `${conv.id}-${s}`, type: "ai", senderId: GEMINI_USER.id, senderName: GEMINI_USER.name, hue: GEMINI_USER.hue,
    text: conv.type === "room" ? clean(reply.text) : reply.text, at: now(), ai: { model: reply.model, askedBy: me.name },
    replyTo: { seq: asked.seq, senderName: asked.senderName, text: asked.text.slice(0, 140) },
  }));
  if (conv.type !== "room") await fanOut(conv, msg);
  return json({ message: msg }, 201);
});

route("POST", "/api/convs/:cid/ai/smart-replies", async (req, ctx, p) => {
  const me = await requireUser(req);
  const conv = await requireAccess(p.cid, me.id);
  requireAi();
  await aiLimits(me);
  const head = await freshHead(conv.id);
  const history = await readRange(conv.id, Math.max(0, head.seq - 11), head.seq);
  return json(await smartReplies({ msgs: history, me: me.name }));
});

route("POST", "/api/convs/:cid/ai/catch-up", async (req, ctx, p) => {
  const me = await requireUser(req);
  const conv = await requireAccess(p.cid, me.id);
  requireAi();
  const b = await readJson(req).catch(() => ({}));
  await aiLimits(me);
  const head = await freshHead(conv.id);
  const from = Number.isInteger(b.from) ? Math.max(b.from, head.seq - 79) : Math.max(0, head.seq - 79);
  const history = await readRange(conv.id, from, head.seq);
  if (history.filter((m) => m.type !== "system").length < 2) return json({ summary: "Not much has happened here yet.", points: [], model: null });
  return json(await catchUp({ convName: conv.type === "room" ? `#${conv.name}` : conv.name || "a direct message", msgs: history }));
});

route("POST", "/api/ai/translate", async (req) => {
  const me = await requireUser(req);
  requireAi();
  const b = await readJson(req);
  const text = String(b.text || "").slice(0, 1500);
  if (!text.trim()) throw new HttpError(400, "Nothing to translate.");
  await aiLimits(me);
  return json(await translate({ text, to: ["en", "hi", "hinglish"].includes(b.to) ? b.to : "en" }));
});

// ---------- files ----------

route("POST", "/api/files", async (req) => {
  const me = await requireUser(req);
  await rateLimit(`file:${me.id}`, 20, 3600);
  const form = await req.formData();
  const f = form.get("file");
  if (!f || typeof f.arrayBuffer !== "function") throw new HttpError(400, "No file received.");
  const buf = new Uint8Array(await f.arrayBuffer());
  if (buf.length > MAX_FILE) throw new HttpError(413, "Files can be up to 4 MB.");
  const mime = String(f.type || "application/octet-stream").slice(0, 100);
  const blocked = /html|javascript|svg|xml/i.test(mime);
  const id = newId("f");
  const meta = { uid: me.id, name: String(f.name || "file").slice(0, 120), size: buf.length, mime: blocked ? "application/octet-stream" : mime, w: Number(form.get("w")) || null, h: Number(form.get("h")) || null, at: now() };
  await store().set(`file/${id}`, new Blob([buf], { type: meta.mime }), { metadata: meta });
  return json({ file: { id, ...meta } }, 201);
});

route("GET", "/api/files/:id", async (req, ctx, p) => {
  if (!/^f[a-f0-9]{16}$/.test(p.id)) throw new HttpError(400, "Bad file id.");
  const res = await store().getWithMetadata(`file/${p.id}`, { type: "arrayBuffer" });
  if (!res) throw new HttpError(410, "File not found.");
  const m = res.metadata || {};
  const inline = /^image\/(png|jpe?g|gif|webp|avif)$/.test(m.mime);
  return new Response(res.data, {
    headers: {
      "content-type": m.mime || "application/octet-stream",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${String(m.name || "file").replace(/["\\]/g, "")}"`,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
});

// ---------- presence / live / health ----------

route("POST", "/api/presence", async (req) => {
  const me = await requireUser(req);
  await touchPresence(me.id);
  return json({ ok: true });
});

route("GET", "/api/presence", async (req) => {
  await requireUser(req);
  const ids = (new URL(req.url).searchParams.get("ids") || "").split(",").filter((x) => /^u[a-f0-9]{16}$/.test(x));
  return json({ presence: await presence(ids), now: Date.now() });
});

// Polling fallback for browsers or networks where the live stream fails.
route("GET", "/api/sync", async (req) => {
  const me = await requireUser(req);
  const sp = new URL(req.url).searchParams;
  let active = sp.get("c") || null;
  const since = Number(sp.get("s"));
  // Only follow a DM or group the caller belongs to (checked before anything about it is read).
  if (active && !ROOM_IDS.includes(active)) {
    try { await requireAccess(active, me.id); } catch { active = null; }
  }
  const inbox = (await getJSON(`inbox/${me.id}`)) || { convs: {}, reads: {} };
  const ids = [...new Set([...ROOM_IDS, ...(active ? [active] : [])])];
  const heads = {};
  await Promise.all(ids.map(async (cid) => { heads[cid] = slimHead(cid === active ? await freshHead(cid) : await getHead(cid)); }));
  let messages = [];
  if (active && heads[active] && Number.isInteger(since)) {
    messages = await readRange(active, since + 1, Math.min(heads[active].seq, since + PAGE));
  }
  let edits = [];
  if (active && sp.has("rv") && Number(sp.get("rv")) !== heads[active]?.rv) {
    const h = await getHead(active);
    const seqs = (h.edits || []).slice(-10);
    edits = (await Promise.all(seqs.map((q) => readRange(active, q, q)))).flat();
  }
  return json({ inbox, heads, messages, edits });
});

route("POST", "/api/live-ticket", async (req) => {
  const me = await requireUser(req);
  return json({ ticket: await liveTicket(me) });
});

route("GET", "/api/health", async () => {
  let storage = "ok";
  try { await store().get("cfg/health-probe"); } catch { storage = "unavailable"; }
  return json({ ok: storage === "ok", storage, ai: aiConfigured() ? { enabled: true, model: modelChain()[0] } : { enabled: false }, rooms: ROOMS.map((r) => r.id), time: now() });
});

export default handler(async (req, context) => {
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  for (const r of routes) {
    const m = r.re.exec(path);
    if (m && r.method === req.method) return r.fn(req, context, m.groups || {});
  }
  const pathMatches = routes.some((r) => r.re.test(path));
  return pathMatches ? fail(405, "Method not allowed") : fail(400, `Unknown API route: ${path}`);
});

export const config = { path: "/api/*", excludedPath: ["/api/live", "/api/live-node"] };
