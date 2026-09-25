import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Message from "./Message.jsx";
import { Avatar, I, dayLabel } from "./bits.jsx";
import {
  useStore, convTitle, otherUser, isOnline, loadMessages, sendMessage, patchMessage, typing, upload, openConv, toast, getState,
} from "../lib/store.js";
import { api } from "../lib/api.js";
import { MAX_FILE, TYPING_TTL } from "../../shared/constants.js";

const EMOJI = ["😀", "😂", "🥲", "😍", "🤔", "😎", "🙏", "👍", "🔥", "🎉", "💯", "❤️", "😭", "🤯", "👀", "✅"];

function Composer({ cid, replyTo, setReplyTo, editing, setEditing, apiRef }) {
  const ai = useStore((s) => s.ai.enabled);
  const lastOther = useStore((s) => {
    const list = s.msgs[cid]?.list || [];
    for (let i = list.length - 1; i >= 0; i--) if (list[i].senderId !== s.me.id && list[i].type !== "system") return list[i].seq;
    return null;
  });
  const [text, setText] = useState("");
  const [emoji, setEmoji] = useState(false);
  const [up, setUp] = useState(null); // { name, p }
  const [chips, setChips] = useState(null);
  const [chipsFor, setChipsFor] = useState(null);
  const ta = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => { setText(""); setChips(null); setEmoji(false); }, [cid]);
  useEffect(() => { if (editing) { setText(editing.text); ta.current?.focus(); } }, [editing]);
  useEffect(() => { if (replyTo) ta.current?.focus(); }, [replyTo]);
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  }, [text]);

  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    if (editing) {
      await patchMessage(cid, editing.seq, { text: t });
      setEditing(null);
      setText("");
      return;
    }
    setText("");
    setChips(null);
    const r = replyTo;
    setReplyTo(null);
    await sendMessage(cid, { text: t, replyTo: r });
  };

  const sendFile = async (file) => {
    if (!file) return;
    if (file.size > MAX_FILE) { toast("Files can be up to 4 MB.", "error"); return; }
    setUp({ name: file.name, p: 0 });
    try {
      const meta = await upload(file, (p) => setUp({ name: file.name, p }));
      await sendMessage(cid, { text: text.trim(), file: meta, replyTo });
      setText("");
      setReplyTo(null);
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setUp(null);
    }
  };

  if (apiRef) apiRef.current = { sendFile };

  const suggest = async () => {
    setChips("loading");
    setChipsFor(lastOther);
    try {
      const r = await api(`/api/convs/${encodeURIComponent(cid)}/ai/smart-replies`, { method: "POST", body: {} });
      setChips(r.replies);
    } catch (e) { setChips(null); toast(e.message, "error"); }
  };

  useEffect(() => {
    const onPaste = (e) => {
      const f = [...(e.clipboardData?.files || [])][0];
      if (f && document.activeElement === ta.current) { e.preventDefault(); sendFile(f); }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  return (
    <div className="composer">
      <AnimatePresence>
        {Array.isArray(chips) && chipsFor === lastOther && chips.length > 0 && (
          <motion.div className="chips" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            {chips.map((c, i) => (
              <motion.button key={c} className="chip" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06 }} onClick={() => { setText(c); setChips(null); ta.current?.focus(); }}>{c}</motion.button>
            ))}
          </motion.div>
        )}
        {(replyTo || editing) && (
          <motion.div className="replying" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            {editing ? I.edit : I.reply}
            <div><b>{editing ? "Editing message" : `Replying to ${replyTo.senderName}`}</b><span>{(editing || replyTo).text}</span></div>
            <button className="ibtn" onClick={() => { setReplyTo(null); if (editing) { setEditing(null); setText(""); } }} aria-label="Cancel">{I.x}</button>
          </motion.div>
        )}
        {up && (
          <motion.div className="upload" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <span>📎 {up.name}</span><div className="upload__bar"><span style={{ width: `${Math.round(up.p * 100)}%` }} /></div><span>{Math.round(up.p * 100)}%</span>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="box" style={{ position: "relative" }}>
        <input ref={fileRef} type="file" hidden onChange={(e) => { sendFile(e.target.files?.[0]); e.target.value = ""; }} />
        <button className="ibtn" onClick={() => fileRef.current?.click()} title="Attach a file (4 MB max)" aria-label="Attach">{I.clip}</button>
        <button className={`ibtn ${emoji ? "on" : ""}`} onClick={() => setEmoji((v) => !v)} aria-label="Emoji">{I.smile}</button>
        <textarea ref={ta} rows={1} value={text} placeholder={editing ? "Edit your message" : ai ? "Message… (try @gemini)" : "Message…"} aria-label="Message"
          onChange={(e) => { setText(e.target.value); if (!editing && e.target.value) typing(cid); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
            if (e.key === "Escape") { setReplyTo(null); setEditing(null); }
          }} />
        {ai && lastOther != null && !text && (
          <button className="ibtn" onClick={suggest} title="Suggest replies with Gemini" aria-label="Suggest replies" disabled={chips === "loading"}>
            {chips === "loading" ? <span className="spinner" /> : I.spark}
          </button>
        )}
        <button className="send" onClick={submit} disabled={!text.trim()} aria-label="Send">{I.send}</button>
        <AnimatePresence>
          {emoji && (
            <motion.div initial={{ opacity: 0, y: 10, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 6 }}
              style={{ position: "absolute", bottom: "calc(100% + 8px)", left: 44, display: "grid", gridTemplateColumns: "repeat(8, 34px)", gap: 2, padding: 8, background: "#fff", borderRadius: 16, boxShadow: "0 16px 36px -16px rgba(23,19,43,.5)", zIndex: 10 }}>
              {EMOJI.map((e) => <button key={e} className="ibtn" style={{ width: 34, height: 34, fontSize: "1.2rem" }} onClick={() => { setText((t) => t + e); ta.current?.focus(); }}>{e}</button>)}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {ai && <div className="hint">Enter to send · Shift+Enter for a new line · <b>@gemini</b> to ask the AI</div>}
    </div>
  );
}

export default function Chat({ onInfo, infoOpen, onImage }) {
  const cid = useStore((s) => s.active);
  const conv = useStore((s) => s.convs[s.active]);
  const me = useStore((s) => s.me);
  const users = useStore((s) => s.users);
  const box = useStore((s) => s.msgs[s.active]);
  const thinking = useStore((s) => s.aiThinking[s.active]);
  const admin = useStore((s) => s.admin);
  const other = useStore((s) => otherUser(s.convs[s.active], s));
  const otherOnline = useStore((s) => (other ? isOnline(other.id, s) : false));
  const [replyTo, setReplyTo] = useState(null);
  const [editing, setEditing] = useState(null);
  const [atBottom, setAtBottom] = useState(true);
  const [drag, setDrag] = useState(false);
  const listRef = useRef(null);
  const innerRef = useRef(null);
  const pinned = useRef(true);
  const composerApi = useRef(null);
  const prevLen = useRef(0);
  const prevHeight = useRef(0);

  useEffect(() => { setReplyTo(null); setEditing(null); setAtBottom(true); pinned.current = true; prevLen.current = 0; }, [cid]);

  const list = box?.list || [];
  // Keep pinned to the bottom when new messages arrive (unless the user scrolled up); keep position when loading older ones.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (prevLen.current && list.length > prevLen.current && list[0]?.seq !== undefined && prevHeight.current && el.scrollTop < 40 && !atBottom) {
      el.scrollTop = el.scrollHeight - prevHeight.current;
    } else if (atBottom || prevLen.current === 0) {
      el.scrollTop = el.scrollHeight;
    }
    prevLen.current = list.length;
    prevHeight.current = el.scrollHeight;
  }, [list, atBottom, thinking]);

  // Stay pinned to the latest message while content grows (images loading, translations, reactions).
  useEffect(() => {
    const el = listRef.current, inner = innerRef.current;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { if (pinned.current) el.scrollTop = el.scrollHeight; });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [cid, Boolean(conv)]);

  const typingNames = useMemo(() => {
    const t = conv?.head?.typing || {};
    return Object.entries(t).filter(([uid, v]) => uid !== me.id && Date.now() - v.t < TYPING_TTL).map(([, v]) => v.name.split(" ")[0]);
  }, [conv?.head?.typing, me.id]);

  const onReply = useCallback((msg) => { setEditing(null); setReplyTo({ seq: msg.seq, senderName: msg.senderName, text: msg.text || msg.file?.name || "" }); }, []);
  const onEdit = useCallback((msg) => { setReplyTo(null); setEditing(msg); }, []);

  if (!cid || !conv) {
    return (
      <main className="pane chat">
        <div className="empty-chat"><div><div style={{ fontSize: "3rem" }}>💬</div><h3>Pick a conversation</h3><p>Say hi in #lobby, or start a DM from the + button.</p></div></div>
      </main>
    );
  }

  const readsByOthers = Object.entries(conv.head?.reads || {}).filter(([uid]) => uid !== me.id).map(([, s]) => s);
  const seenUpTo = conv.type === "room" ? -1 : readsByOthers.length ? Math.min(...readsByOthers) : -1;
  const onScroll = (e) => {
    const el = e.currentTarget;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    pinned.current = bottom;
    setAtBottom(bottom);
    if (el.scrollTop < 60 && box?.hasMore && !box.loading) { prevHeight.current = el.scrollHeight; loadMessages(cid, { older: true }); }
  };
  const subtitle = typingNames.length
    ? `${typingNames.slice(0, 2).join(", ")} ${typingNames.length > 1 ? "are" : "is"} typing…`
    : conv.type === "room" ? conv.topic
      : conv.type === "dm" ? (otherOnline ? "Online" : other?.guest ? "Guest" : `@${other?.handle || ""}`)
        : `${conv.members.length} members`;

  let lastDay = null;
  const items = [];
  list.forEach((m, i) => {
    const d = dayLabel(m.at);
    if (d !== lastDay) { items.push(<div key={`d-${d}`} className="day">{d}</div>); lastDay = d; }
    const prev = list[i - 1];
    const next = list[i + 1];
    const first = !prev || prev.senderId !== m.senderId || prev.type === "system" || Date.parse(m.at) - Date.parse(prev.at) > 5 * 60000 || dayLabel(prev.at) !== d;
    const lastOfRun = !next || next.senderId !== m.senderId || next.type === "system" || Date.parse(next.at) - Date.parse(m.at) > 5 * 60000;
    items.push(
      <Message key={m.cmid ?? m.seq} m={m} cid={cid} first={first} mine={m.senderId === me.id} showAvatar={lastOfRun} seen={m.seq != null && m.seq <= seenUpTo}
        onReply={onReply} onEdit={onEdit} onImage={onImage} canAdmin={admin && conv.type === "room"} />,
    );
  });

  return (
    <main className="pane chat" style={{ position: "relative" }}
      onDragOver={(e) => { if (e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDrag(false); }}
      onDrop={(e) => {
        e.preventDefault(); setDrag(false);
        const f = e.dataTransfer.files?.[0];
        if (f) composerApi.current?.sendFile(f);
      }}>
      <header className="chat__head">
        <button className="ibtn back" onClick={() => openConv(null)} aria-label="Back">{I.back}</button>
        {conv.type === "dm" ? <Avatar user={other} size={40} showOnline /> : <span className="room-ico">{conv.emoji || "💬"}</span>}
        <div className="chat__title">
          <b>{convTitle(conv, { me, users })}</b>
          <small className={typingNames.length ? "typing" : ""}>{subtitle}</small>
        </div>
        <button className={`ibtn ${infoOpen ? "on" : ""}`} onClick={onInfo} aria-label="Details and AI tools" title="Details and AI tools">{I.info}</button>
      </header>
      <div className="msgs" ref={listRef} onScroll={onScroll}>
        <div className="msgs__in" ref={innerRef}>
        <div className="msgs__top">{box?.loading ? <span className="spinner" style={{ display: "inline-block" }} /> : box?.hasMore ? "Scroll up for older messages" : conv.type === "room" ? `This is the start of #${conv.name}` : "This is the start of your conversation"}</div>
        {items}
        <div className="typing-slot">
          <AnimatePresence>
            {(thinking || typingNames.length > 0) && (
              <motion.div className="typing-row" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }}>
                {thinking && <Avatar user={{ id: "gemini" }} size={26} />}
                <span className="dots"><i /><i /><i /></span>
                <span>{thinking ? "Gemini is thinking…" : `${typingNames.join(", ")} typing…`}</span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        </div>
      </div>
      <AnimatePresence>
        {!atBottom && (
          <motion.button className="btn btn--ghost btn--sm jump" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }}
            onClick={() => { const el = listRef.current; el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); }}>↓ Latest</motion.button>
        )}
      </AnimatePresence>
      <Composer cid={cid} replyTo={replyTo} setReplyTo={setReplyTo} editing={editing} setEditing={setEditing} apiRef={composerApi} />
      {drag && <div className="drop-over">Drop to share</div>}
    </main>
  );
}
