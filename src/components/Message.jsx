import { memo, useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Avatar, I, timeShort } from "./bits.jsx";
import { patchMessage, discardFailed, toast, getState } from "../lib/store.js";
import { api } from "../lib/api.js";
import { REACTIONS } from "../../shared/constants.js";

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)"'\]])/g;

function Rich({ text }) {
  // Links, @mentions and "- " bullet lines (Gemini uses them). No HTML is ever injected.
  return String(text).split("\n").map((line, li, arr) => {
    const bullet = /^\s*[-•]\s+/.test(line);
    const body = bullet ? line.replace(/^\s*[-•]\s+/, "") : line;
    const parts = body.split(URL_RE).flatMap((p, i) => (i % 2 ? [<a key={`u${i}`} href={p} target="_blank" rel="noreferrer noopener">{p}</a>] : p.split(/(@\w+)/g).map((q, j) => (/^@\w+$/.test(q) ? <span key={`m${i}-${j}`} className="mention">{q}</span> : q))));
    return <span key={li} style={bullet ? { display: "block", paddingLeft: 14, textIndent: -10 } : undefined}>{bullet && "• "}{parts}{li < arr.length - 1 && !bullet ? "\n" : ""}</span>;
  });
}

// Only one message shows its hover toolbar at a time (hover, keyboard focus and taps can overlap).
let closeOpen = null;
// Touch screens get the toolbar on tap only (phones fire fake mouse events after a tap).
const canHover = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(hover: hover)").matches : true;

const emojiOnly = (t) => t && t.length <= 12 && /^(\p{Extended_Pictographic}|\s|‍|️)+$/u.test(t);

function Message({ m, cid, first, mine, showAvatar, seen, onReply, onEdit, onImage, canAdmin }) {
  const [tools, setTools] = useState(false);
  const [picker, setPicker] = useState(false);
  const [tr, setTr] = useState(null);
  const me = getState().me;
  const rowRef = useRef(null);
  const close = useCallback(() => { setTools(false); setPicker(false); }, []);
  const open = useCallback(() => {
    if (closeOpen && closeOpen !== close) closeOpen();
    closeOpen = close;
    setTools(true);
  }, [close]);
  useEffect(() => {
    if (!tools || canHover) return;
    const away = (e) => { if (!rowRef.current?.contains(e.target)) close(); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [tools, close]);
  if (m.type === "system") return <div className="sys">{m.text}</div>;
  const ai = m.senderId === "gemini";
  const cls = ["row", first && "first", mine && "mine", ai && "ai", m.deleted && "deleted", m.pending && "pending", m.failed && "failed"].filter(Boolean).join(" ");
  const reactions = Object.entries(m.reactions || {}).filter(([, v]) => v.length);
  const isImg = m.file?.mime?.startsWith("image/");

  const translate = async (to) => {
    setTr({ loading: true });
    try {
      const r = await api("/api/ai/translate", { method: "POST", body: { text: m.text, to } });
      setTr(r);
    } catch (e) { setTr(null); toast(e.message, "error"); }
  };

  return (
    <motion.div className={cls} layout="position" initial={m.pending || m.fresh ? { opacity: 0, y: 14, scale: 0.94 } : false} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: "spring", stiffness: 520, damping: 32 }}
      ref={rowRef}
      onMouseEnter={canHover ? open : undefined} onMouseLeave={canHover ? close : undefined} onFocus={canHover ? open : undefined}
      onBlur={canHover ? (e) => { if (!e.currentTarget.contains(e.relatedTarget)) close(); } : undefined}
      onClick={canHover ? undefined : (e) => { if (!e.target.closest(".tools, a, button, img")) (tools ? close() : open()); }}>
      {!mine && <span className="av-slot">{showAvatar && <Avatar user={{ id: m.senderId, name: m.senderName, hue: m.hue }} size={32} />}</span>}
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", alignItems: mine ? "flex-end" : "flex-start" }}>
        <div className={`bubble ${!m.deleted && !m.replyTo && emojiOnly(m.text) && !m.file ? "big" : ""}`}>
          {first && !mine && <div className="sender" style={{ color: ai ? "#6c47ff" : `hsl(${m.hue ?? 260} 62% 42%)` }}>{m.senderName}{ai && <small>AI · asked by {m.ai?.askedBy}</small>}</div>}
          {m.replyTo && !m.deleted && <span className="reply"><b>{m.replyTo.senderName}</b><span>{m.replyTo.text}</span></span>}
          {m.deleted ? "This message was deleted" : (
            <>
              {m.file && (isImg ? (
                <img className="img" src={m.file.url || `/api/files/${m.file.id}`} alt={m.file.name} loading="lazy" width={m.file.w || undefined} height={m.file.h || undefined}
                  style={m.file.w ? { aspectRatio: `${m.file.w} / ${m.file.h}` } : undefined} onClick={() => onImage(m.file.url || `/api/files/${m.file.id}`)} />
              ) : (
                <a className="file" href={`/api/files/${m.file.id}`} target="_blank" rel="noreferrer"><i>📎</i><span><b>{m.file.name}</b><small>{(m.file.size / 1024).toFixed(0)} KB</small></span></a>
              ))}
              {m.text && <Rich text={m.text} />}
            </>
          )}
          <span className="meta">
            {m.edited && !m.deleted && "edited · "}
            {m.pending ? "sending…" : m.failed ? "not sent" : timeShort(m.at)}
            {mine && !m.pending && !m.failed && (seen ? <span className="seen" title="Seen">✓✓</span> : <span title="Sent">✓</span>)}
          </span>
          {tr && (
            <div className="translation">{tr.loading ? "Translating…" : <><small>✦ translated from {tr.from}</small>{tr.text}</>}</div>
          )}
        </div>
        {reactions.length > 0 && (
          <div className="reacts">
            {reactions.map(([e, who]) => (
              <motion.button key={e} className={`react ${who.includes(me.id) ? "me" : ""}`} onClick={() => patchMessage(cid, m.seq, { react: e })} initial={{ scale: 0.4 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 600, damping: 18 }}>
                {e} <b>{who.length}</b>
              </motion.button>
            ))}
          </div>
        )}
        {m.failed && (
          <div style={{ fontSize: "0.76rem", color: "var(--coral)", marginTop: 4 }}>{m.failed} · <button className="btn btn--ghost btn--sm" style={{ height: 24 }} onClick={() => discardFailed(cid, m.cmid)}>Dismiss</button></div>
        )}
      </div>
      <AnimatePresence>
        {tools && !m.pending && !m.failed && !m.deleted && m.seq != null && (
          <div className="tools-anchor" key="tools">
          <motion.div className="tools" initial={{ opacity: 0, scale: 0.9, y: 4 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9 }} transition={{ duration: 0.12 }}>
            {picker ? (
              <div className="emoji-pop">
                {REACTIONS.map((e) => <button key={e} onClick={() => { patchMessage(cid, m.seq, { react: e }); setPicker(false); }} aria-label={`React ${e}`}>{e}</button>)}
              </div>
            ) : (
              <>
                <button onClick={() => setPicker(true)} title="React" aria-label="React">🙂</button>
                <button onClick={() => onReply(m)} title="Reply" aria-label="Reply">{I.reply}</button>
                {m.text && getState().ai.enabled && <button onClick={() => translate(/[ऀ-ॿ]/.test(m.text) ? "en" : "hi")} title={/[ऀ-ॿ]/.test(m.text) ? "Translate to English" : "Translate to Hindi"} aria-label="Translate">{I.globe}</button>}
                {m.text && <button onClick={() => { navigator.clipboard?.writeText(m.text); toast("Copied"); }} title="Copy" aria-label="Copy">{I.copy}</button>}
                {mine && m.type === "text" && <button onClick={() => onEdit(m)} title="Edit" aria-label="Edit">{I.edit}</button>}
                {(mine || canAdmin) && <button onClick={() => { if (confirm("Delete this message for everyone?")) patchMessage(cid, m.seq, { delete: true }); }} title="Delete" aria-label="Delete">{I.trash}</button>}
              </>
            )}
          </motion.div>
          </div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export default memo(Message);
