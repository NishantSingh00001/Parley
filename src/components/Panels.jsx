import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Avatar, I } from "./bits.jsx";
import { useStore, isOnline, startDm, createGroup, updateMe, signOut, toast, convTitle, getState } from "../lib/store.js";
import { api } from "../lib/api.js";

export function InfoPanel({ onClose, onImage }) {
  const conv = useStore((s) => s.convs[s.active]);
  const me = useStore((s) => s.me);
  const users = useStore((s) => s.users);
  const ai = useStore((s) => s.ai);
  const list = useStore((s) => s.msgs[s.active]?.list || []);
  const presence = useStore((s) => s.presence);
  const [cu, setCu] = useState(null);
  useEffect(() => setCu(null), [conv?.id]);
  if (!conv) return null;
  const images = list.filter((m) => m.file?.mime?.startsWith("image/") && !m.deleted).slice(-9).reverse();
  const people = conv.type === "room" ? [...new Set(list.filter((m) => m.senderId?.startsWith("u")).map((m) => m.senderId))].slice(-12).reverse() : conv.members;
  const catchUp = async () => {
    setCu({ loading: true });
    try { setCu(await api(`/api/convs/${encodeURIComponent(conv.id)}/ai/catch-up`, { method: "POST", body: {} })); }
    catch (e) { setCu(null); toast(e.message, "error"); }
  };
  return (
    <motion.aside className="pane info" initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 30 }} transition={{ type: "spring", stiffness: 380, damping: 34 }} aria-label="Details">
      <div className="info__head"><span>Details</span><button className="ibtn" onClick={onClose} aria-label="Close details">{I.x}</button></div>
      <div className="info__body">
        <div className="card">
          <div style={{ fontFamily: "var(--f-display)", fontSize: "1.2rem", fontWeight: 750 }}>{conv.emoji ? `${conv.emoji} ` : ""}{convTitle(conv, { me, users })}</div>
          <p style={{ margin: "6px 0 0", color: "var(--ink-2)", fontSize: "0.9rem" }}>{conv.type === "room" ? conv.topic : conv.type === "group" ? `Group · ${conv.members.length} members` : "Direct message"}</p>
        </div>
        <div className="card catchup">
          <h4>✦ Gemini</h4>
          {!ai.enabled ? <p style={{ fontSize: "0.88rem", color: "var(--ink-2)" }}>AI features turn on when a Gemini key is added to this deployment.</p> : cu?.summary ? (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <p>{cu.summary}</p>
              {cu.points?.length > 0 && <ul>{cu.points.map((p) => <li key={p}>{p}</li>)}</ul>}
              <button className="btn btn--ghost btn--sm" style={{ marginTop: 10 }} onClick={catchUp}>Refresh</button>
            </motion.div>
          ) : (
            <>
              <p style={{ fontSize: "0.88rem", color: "var(--ink-2)" }}>Get a quick summary of the latest messages here.</p>
              <button className="btn btn--grad btn--sm" onClick={catchUp} disabled={cu?.loading}>{cu?.loading ? <span className="spinner" style={{ borderTopColor: "#fff" }} /> : I.spark} Catch me up</button>
            </>
          )}
        </div>
        <div className="card">
          <h4>{conv.type === "room" ? "Recently active" : "Members"}</h4>
          {people.length === 0 && <p style={{ margin: 0, color: "var(--ink-3)", fontSize: "0.88rem" }}>Nobody's said anything yet.</p>}
          {people.map((id) => {
            const u = users[id] || { id, name: "Someone" };
            const online = presence && isOnline(id, getState());
            return (
              <div key={id} className="member">
                <Avatar user={u} size={34} showOnline />
                <div style={{ flex: 1, minWidth: 0 }}><b>{u.name}{id === me.id ? " (you)" : ""}</b><small>{online ? "online" : u.guest ? "guest" : u.handle ? `@${u.handle}` : ""}</small></div>
                {id !== me.id && id.startsWith("u") && <button className="btn btn--ghost btn--sm" onClick={() => startDm(id).catch((e) => toast(e.message, "error"))}>Message</button>}
              </div>
            );
          })}
        </div>
        {images.length > 0 && (
          <div className="card">
            <h4>Shared photos</h4>
            <div className="thumbs">{images.map((m) => <img key={m.seq} src={`/api/files/${m.file.id}`} alt={m.file.name} onClick={() => onImage(`/api/files/${m.file.id}`)} />)}</div>
          </div>
        )}
      </div>
    </motion.aside>
  );
}

function Modal({ children, onClose }) {
  useEffect(() => {
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <motion.div className="modal" role="dialog" aria-modal="true" initial={{ opacity: 0, y: 30, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 20, scale: 0.97 }} transition={{ type: "spring", stiffness: 420, damping: 34 }}>
        {children}
      </motion.div>
    </motion.div>
  );
}

export function NewChat({ onClose }) {
  const [q, setQ] = useState("");
  const [users, setUsers] = useState(null);
  const [mode, setMode] = useState("dm");
  const [picked, setPicked] = useState([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => api(`/api/users?q=${encodeURIComponent(q)}`).then((r) => setUsers(r.users)).catch(() => setUsers([])), 200);
    return () => clearTimeout(t);
  }, [q]);
  const toggle = (u) => setPicked((p) => (p.some((x) => x.id === u.id) ? p.filter((x) => x.id !== u.id) : [...p, u]));
  const go = async () => {
    setBusy(true);
    try {
      if (mode === "group") await createGroup(name, picked.map((u) => u.id));
      onClose();
    } catch (e) { toast(e.message, "error"); } finally { setBusy(false); }
  };
  return (
    <Modal onClose={onClose}>
      <h3>New conversation</h3>
      <div className="tabs" style={{ margin: "14px 0" }}>
        {[["dm", "Direct message"], ["group", "Group"]].map(([k, l]) => (
          <button key={k} className={mode === k ? "on" : ""} onClick={() => setMode(k)}>
            {mode === k && <motion.span layoutId="nc-tab" className="tab-bg" />}{l}
          </button>
        ))}
      </div>
      {mode === "group" && <label className="field"><span>Group name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Final year squad" /></label>}
      <div className="search" style={{ margin: "0 0 10px" }}>{I.search}<input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people by name or @username" /></div>
      {mode === "group" && picked.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>{picked.map((u) => <button key={u.id} className="chip" onClick={() => toggle(u)}>{u.name} ✕</button>)}</div>
      )}
      <div style={{ maxHeight: 300, overflowY: "auto", display: "grid", gap: 2 }}>
        {users === null && <span className="spinner" />}
        {users?.length === 0 && <p style={{ color: "var(--ink-3)" }}>No one found. Share the link and invite a friend!</p>}
        {users?.map((u) => (
          <button key={u.id} className={`pick ${picked.some((x) => x.id === u.id) ? "on" : ""}`}
            onClick={() => (mode === "dm" ? startDm(u.id).then(onClose).catch((e) => toast(e.message, "error")) : toggle(u))}>
            <Avatar user={u} size={36} showOnline />
            <span style={{ flex: 1, minWidth: 0 }}><b style={{ display: "block" }}>{u.name}</b><small>{u.guest ? "guest" : `@${u.handle}`}</small></span>
            {mode === "group" && <span>{picked.some((x) => x.id === u.id) ? "✓" : "+"}</span>}
          </button>
        ))}
      </div>
      {mode === "group" && <button className="btn btn--grad btn--block" style={{ marginTop: 14 }} disabled={busy || name.trim().length < 2 || !picked.length} onClick={go}>Create group{picked.length ? ` with ${picked.length + 1}` : ""}</button>}
    </Modal>
  );
}

export function Profile({ onClose }) {
  const me = useStore((s) => s.me);
  const [name, setName] = useState(me.name);
  const [about, setAbout] = useState(me.about || "");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await updateMe({ name, about }); toast("Profile saved"); onClose(); } catch (e) { toast(e.message, "error"); } finally { setBusy(false); }
  };
  return (
    <Modal onClose={onClose}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16 }}>
        <Avatar user={{ ...me, name }} size={64} />
        <div><h3>{name || me.name}</h3><div style={{ color: "var(--ink-3)", fontSize: "0.88rem" }}>{me.guest ? "Guest account" : `@${me.handle}`}</div></div>
      </div>
      <label className="field"><span>Display name</span><input className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field"><span>About</span><input className="input" value={about} maxLength={140} onChange={(e) => setAbout(e.target.value)} placeholder="Final year CSE, into ML" /></label>
      {me.guest && <p style={{ fontSize: "0.84rem", color: "var(--ink-2)" }}>You're a guest: your chats live in this browser's sign-in. Signing out loses access to this account.</p>}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button className="btn btn--grad" onClick={save} disabled={busy}>Save</button>
        <button className="btn btn--ghost" onClick={() => { if (!me.guest || confirm("Sign out of this guest account? You won't be able to sign back in to it.")) signOut(); }}>Sign out</button>
      </div>
    </Modal>
  );
}

export function Lightbox({ src, onClose }) {
  return (
    <AnimatePresence>
      {src && (
        <motion.div className="lightbox" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.img src={src} alt="" initial={{ scale: 0.9 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 300, damping: 28 }} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
