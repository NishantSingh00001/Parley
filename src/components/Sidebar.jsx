import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useStore, sortedConvs, convTitle, otherUser, unreadFor, openConv } from "../lib/store.js";
import { Avatar, I, Mark, ago } from "./bits.jsx";

function ConvItem({ c, active }) {
  const s = useStore((st) => st);
  const unread = unreadFor(c, s);
  const other = otherUser(c, s);
  const last = c.head?.last;
  const typing = Object.entries(c.head?.typing || {}).filter(([uid, v]) => uid !== s.me.id && Date.now() - v.t < 6000);
  const preview = typing.length ? `${typing[0][1].name.split(" ")[0]} is typing…` : last ? `${last.senderId === s.me.id ? "You: " : c.type === "dm" ? "" : `${(last.senderName || "").split(" ")[0]}: `}${last.text}` : c.type === "room" ? c.topic : "No messages yet";
  return (
    <motion.button layout="position" className={`ci ${active ? "on" : ""} ${unread ? "unread" : ""}`} onClick={() => openConv(c.id)} transition={{ type: "spring", stiffness: 500, damping: 40 }}>
      {c.type === "room" ? <span className="room-ico">{c.emoji}</span> : c.type === "dm" ? <Avatar user={other} size={42} showOnline /> : <span className="room-ico">{c.emoji || "💬"}</span>}
      <span style={{ minWidth: 0 }}>
        <span className="ci__name">{convTitle(c, s)}{other?.guest && <small style={{ color: "var(--ink-3)", fontWeight: 500 }}>guest</small>}</span>
        <span className="ci__prev" style={typing.length ? { color: "var(--violet)", fontWeight: 600 } : undefined}>{preview}</span>
      </span>
      <span className="ci__meta">
        <span>{ago(c.head?.lastAt)}</span>
        {unread > 0 && <motion.span className="badge" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 600, damping: 20 }}>{unread > 99 ? "99+" : unread}</motion.span>}
      </span>
    </motion.button>
  );
}

export default function Sidebar({ onNew, onProfile }) {
  const me = useStore((s) => s.me);
  const active = useStore((s) => s.active);
  const conn = useStore((s) => s.conn);
  const convsState = useStore((s) => s.convs);
  const users = useStore((s) => s.users);
  const [q, setQ] = useState("");
  const { rooms, others } = useMemo(() => sortedConvs({ convs: convsState, me, users }), [convsState, me, users]);
  const match = (c) => !q || convTitle(c, { me, users }).toLowerCase().includes(q.toLowerCase());
  return (
    <aside className="pane sidebar" aria-label="Conversations">
      <div className="sidebar__top">
        <button className="sidebar__me" onClick={onProfile} title="Your profile">
          <Avatar user={me} size={40} />
          <span style={{ minWidth: 0 }}>
            <b>{me.name}</b>
            <small className={`conn ${conn === "live" ? "" : conn === "poll" ? "poll" : "off"}`}><i />{conn === "live" ? "Live" : conn === "poll" ? "Syncing every 2 s" : conn === "offline" ? "Offline" : "Connecting…"}</small>
          </span>
        </button>
        <button className="ibtn" onClick={onNew} title="New chat" aria-label="New chat">{I.plus}</button>
      </div>
      <div className="search">
        {I.search}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats" aria-label="Search chats" />
      </div>
      <div className="convlist">
        <div className="sec"><span>Rooms</span></div>
        {rooms.filter(match).map((c) => <ConvItem key={c.id} c={c} active={c.id === active} />)}
        <div className="sec"><span>Messages</span><button className="ibtn" style={{ width: 26, height: 26 }} onClick={onNew} aria-label="New message">{I.plus}</button></div>
        {others.filter(match).map((c) => <ConvItem key={c.id} c={c} active={c.id === active} />)}
        {others.length === 0 && (
          <button className="ci" onClick={onNew} style={{ border: "1.5px dashed var(--line-2)" }}>
            <span className="room-ico">✉️</span>
            <span><span className="ci__name">Start a conversation</span><span className="ci__prev">DM someone or make a group</span></span>
            <span />
          </button>
        )}
      </div>
      <div style={{ padding: "8px 16px 12px", fontSize: "0.72rem", color: "var(--ink-3)", display: "flex", alignItems: "center", gap: 8 }}>
        <span className="brand__mark" style={{ width: 22, height: 22, borderRadius: 8 }}><Mark size={13} /></span>
        Parley · by <a href="https://nishant-singhaa0240274.netlify.app" target="_blank" rel="noreferrer">Nishant Singh</a>
      </div>
    </aside>
  );
}
