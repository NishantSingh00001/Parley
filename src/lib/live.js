// Live updates: an EventSource on the edge function, reconnected every ~25 s,
// with an automatic fallback to polling /api/sync if streaming keeps failing.
import { api } from "./api.js";
import { getState, applyMessages, applyEdits, applyHead, applyInbox, setConn, lastSeq, registerLive } from "./store.js";

const LIVE_PATH = import.meta.env.DEV ? "/api/live-node" : "/api/live";

let es = null;
let active = null;
let failures = 0;
let mode = "live";
let pollTimer = null;
let retryTimer = null;
let generation = 0;

function close() {
  if (es) { es.close(); es = null; }
  clearTimeout(retryTimer);
}

// Tickets last 10 minutes; reuse one across the ~25 s reconnects instead of asking every time.
let cachedTicket = null;
async function getTicket() {
  if (cachedTicket && cachedTicket.until > Date.now()) return cachedTicket.value;
  const value = (await api("/api/live-ticket", { method: "POST", body: {} })).ticket;
  cachedTicket = { value, until: Date.now() + 8 * 60 * 1000 };
  return value;
}

async function connect() {
  close();
  const gen = ++generation;
  if (mode === "poll") return poll();
  let ticket;
  try {
    ticket = await getTicket();
  } catch {
    return scheduleRetry(gen);
  }
  if (gen !== generation) return;
  const params = new URLSearchParams({ t: ticket });
  if (active) { params.set("c", active); params.set("s", String(lastSeq(active))); }
  const src = new EventSource(`${LIVE_PATH}?${params}`);
  es = src;
  let opened = false;
  src.addEventListener("hello", () => { opened = true; failures = 0; setConn("live"); });
  src.addEventListener("head", (e) => { const d = JSON.parse(e.data); applyHead(d.cid, d.head); });
  src.addEventListener("messages", (e) => { const d = JSON.parse(e.data); applyMessages(d.cid, d.messages); });
  src.addEventListener("edits", (e) => { const d = JSON.parse(e.data); applyEdits(d.cid, d.messages); });
  src.addEventListener("inbox", (e) => applyInbox(JSON.parse(e.data)));
  src.addEventListener("bye", () => { src.close(); if (gen === generation) connect(); });
  src.onerror = () => {
    src.close();
    cachedTicket = null; // might have been rejected
    if (gen !== generation) return;
    if (!opened) failures += 1;
    if (failures >= 3) { mode = "poll"; setConn("poll"); poll(); return; }
    setConn(navigator.onLine ? "connecting" : "offline");
    scheduleRetry(gen);
  };
}

function scheduleRetry(gen) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => gen === generation && connect(), Math.min(8000, 800 * 2 ** failures));
}

async function poll() {
  clearTimeout(pollTimer);
  const gen = generation;
  try {
    const params = new URLSearchParams();
    if (active) {
      params.set("c", active);
      params.set("s", String(lastSeq(active)));
      params.set("rv", String(getState().convs[active]?.head?.rv ?? 0));
    }
    const r = await api(`/api/sync?${params}`);
    if (gen !== generation) return;
    setConn("poll");
    for (const [cid, head] of Object.entries(r.heads)) applyHead(cid, head);
    if (active && r.messages.length) applyMessages(active, r.messages);
    if (active && r.edits.length) applyEdits(active, r.edits);
    if (JSON.stringify(r.inbox) !== JSON.stringify(getState().inbox)) applyInbox(r.inbox);
  } catch {
    setConn("offline");
  }
  pollTimer = setTimeout(poll, document.hidden ? 8000 : 2000);
}

export function startLive() {
  active = getState().active;
  registerLive({
    setActive(cid) {
      if (cid === active && (es || mode === "poll")) return; // already streaming this conversation
      active = cid;
      connect();
    },
  });
  // A background tab doesn't need a live stream: pause after a minute hidden, resume (and catch up) on return.
  let pauseTimer = null;
  document.addEventListener("visibilitychange", () => {
    clearTimeout(pauseTimer);
    if (document.hidden) {
      pauseTimer = setTimeout(() => { if (document.hidden && mode === "live") { generation++; close(); setConn("paused"); } }, 60000);
    } else if (!es && mode === "live") connect();
  });
  window.addEventListener("online", () => connect());
  connect();
}
