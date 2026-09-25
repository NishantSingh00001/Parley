// The live stream, shared by the edge function (production) and a Node
// function used for local development. See netlify/edge-functions/live.js.

import { verifyJwt } from "./jwt.js";
import { jwtSecret } from "./secret.js";
import { ROOM_IDS } from "./constants.js";

const TICK = 700;
const LIFETIME = 25000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function liveResponse(req, getStore, { lifetime } = {}) {
  const url = new URL(req.url);
  const store = getStore({ name: "parley", consistency: "strong" });
  const payload = await verifyJwt(url.searchParams.get("t") || "", await jwtSecret(store));
  if (!payload || payload.typ !== "live") {
    return new Response(JSON.stringify({ error: "Live ticket expired." }), { status: 401, headers: { "content-type": "application/json" } });
  }
  const uid = payload.sub;
  const active = /^[A-Za-z0-9_-]{2,80}$/.test(url.searchParams.get("c") || "") ? url.searchParams.get("c") : null;
  let since = Number(url.searchParams.get("s"));
  if (!Number.isFinite(since)) since = null;

  // Only stream a DM/group the user is actually in.
  let activeOk = false;
  if (active) {
    if (ROOM_IDS.includes(active)) activeOk = true;
    else {
      const conv = await store.get(`conv/${active}`, { type: "json" });
      activeOk = Boolean(conv && conv.members?.includes(uid));
    }
  }

  const heads = [...new Set([...ROOM_IDS, ...(activeOk ? [active] : [])])];
  const etags = {};
  let lastRv = null;
  let closed = false;
  const enc = new TextEncoder();

  const body = new ReadableStream({
    async start(controller) {
      const send = (event, data) => {
        if (!closed) controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send("hello", { uid, active: activeOk ? active : null, at: Date.now() });
      const end = Date.now() + (lifetime || LIFETIME);
      let lastPing = Date.now();
      try {
        while (!closed && Date.now() < end) {
          const keys = [`inbox/${uid}`, ...heads.map((c) => `head/${c}`)];
          // Small documents, so compare their contents directly (works whether or not ETags are exposed).
          const results = await Promise.all(keys.map((k) => store.get(k, { type: "text" }).catch(() => null)));
          for (let i = 0; i < keys.length; i++) {
            const k = keys[i], raw = results[i];
            if (raw == null || raw === etags[k]) continue;
            const first = etags[k] === undefined;
            etags[k] = raw;
            let data;
            try { data = JSON.parse(raw); } catch { continue; }
            if (k.startsWith("inbox/")) { if (!first) send("inbox", data); continue; }
            const cid = k.slice(5);
            const h = data;
            send("head", { cid, head: { seq: h.seq, lastAt: h.lastAt || null, last: h.last || null, rv: h.rv || 0, reads: h.reads || {}, typing: h.typing || {} } });
            if (activeOk && cid === active) {
              if (since == null) since = h.seq;
              // Edits, reactions and deletions.
              if (lastRv != null && (h.rv || 0) !== lastRv && h.edits?.length) {
                const seqs = h.edits.slice(-10);
                const got = await Promise.all(seqs.map((s) => store.get(`m/${cid}/${s}`, { type: "json" })));
                send("edits", { cid, messages: got.filter(Boolean) });
              }
              lastRv = h.rv || 0;
            }
          }
          // New messages: each seq is claimed in order, so "does since+1 exist?" is the signal.
          if (activeOk && since != null) {
            const batch = [];
            for (let s = since + 1; batch.length < 50; s++) {
              const m = await store.get(`m/${active}/${s}`, { type: "json" });
              if (!m) break;
              batch.push(m);
            }
            if (batch.length) { send("messages", { cid: active, messages: batch }); since = batch[batch.length - 1].seq; }
          }
          if (Date.now() - lastPing > 10000) { controller.enqueue(enc.encode(": ping\n\n")); lastPing = Date.now(); }
          await sleep(TICK);
        }
        send("bye", { reconnect: true, since });
      } catch (e) {
        send("bye", { reconnect: true, since, error: String(e?.message || e) });
      } finally {
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    cancel() { closed = true; },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
