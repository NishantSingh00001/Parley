import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { api, setToken } from "../lib/api.js";
import { Mark, Avatar } from "./bits.jsx";

const DEMO = [
  { who: { id: "a", name: "Riya Kapoor", hue: 330 }, text: "anyone cracked the Razorpay OA? 😅" },
  { who: { id: "b", name: "Arjun M", hue: 190 }, text: "yes! 2 DSA + 1 SQL. Revise window functions" },
  { who: { id: "me", name: "You", hue: 262 }, mine: true, text: "@gemini explain window functions in one line?" },
  { who: { id: "gemini", name: "Gemini" }, ai: true, text: "They compute a value across related rows (like a running total) without collapsing them into one row." },
  { who: { id: "a", name: "Riya Kapoor", hue: 330 }, text: "saving this 🙏" },
];

function Demo() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((x) => (x >= DEMO.length + 3 ? 0 : x + 1)), 1300);
    return () => clearInterval(id);
  }, []);
  const shown = DEMO.slice(0, Math.min(n, DEMO.length));
  const typing = n < DEMO.length ? DEMO[n] : null;
  return (
    <div className="landing__demo" aria-hidden="true">
      <AnimatePresence initial={false}>
        {shown.map((m, i) => (
          <motion.div key={`${i}-${m.text}`} className={`row ${m.mine ? "mine" : ""} ${m.ai ? "ai" : ""}`} style={{ maxWidth: "88%" }}
            initial={{ opacity: 0, y: 16, scale: 0.9 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0 }} transition={{ type: "spring", stiffness: 420, damping: 28 }}>
            {!m.mine && <Avatar user={m.who} size={30} />}
            <div className="bubble">
              {!m.mine && <div className="sender" style={{ color: m.ai ? "#6c47ff" : `hsl(${m.who.hue} 60% 42%)` }}>{m.who.name}{m.ai && <small>AI</small>}</div>}
              {m.text.split(/(@gemini)/).map((p, j) => (p === "@gemini" ? <span key={j} className="mention">{p}</span> : p))}
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
      {typing && n > 0 && (
        <div className="typing-row"><Avatar user={typing.who} size={22} /><span className="dots"><i /><i /><i /></span></div>
      )}
    </div>
  );
}

export default function Landing({ onSignedIn }) {
  const [tab, setTab] = useState("guest");
  const [form, setForm] = useState({ handle: "", name: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const go = async (path, body) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api(path, { method: "POST", body });
      setToken(r.token);
      onSignedIn();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const f = (k) => ({ value: form[k], onChange: (e) => setForm((s) => ({ ...s, [k]: e.target.value })) });

  return (
    <div className="landing">
      <div className="landing__in">
        <div>
          <motion.div className="brand" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}><span className="brand__mark"><Mark /></span>Parley</motion.div>
          <motion.h1 className="hero-title" initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}>
            Chat that feels <span>alive.</span>
          </motion.h1>
          <motion.p className="hero-sub" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15, duration: 0.7 }}>
            Public rooms, DMs and group chats with live typing, read receipts, reactions and file sharing. Mention <b>@gemini</b> and an AI joins the conversation.
          </motion.p>
          <motion.div className="pills" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }}>
            {["⚡ Live in under a second", "✦ Gemini built in", "🔒 JWT auth", "📎 Files & images", "🌐 Translate any message"].map((p) => <span key={p} className="pill">{p}</span>)}
          </motion.div>
          <Demo />
        </div>

        <motion.div className="auth" initial={{ opacity: 0, y: 30, rotate: 1 }} animate={{ opacity: 1, y: 0, rotate: 0 }} transition={{ duration: 0.8, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}>
          <h2>Jump in</h2>
          <p style={{ margin: "4px 0 0", color: "var(--ink-2)" }}>Try it as a guest in one click, or make an account to keep your chats.</p>
          <div className="tabs" role="tablist">
            {[["guest", "Guest"], ["login", "Log in"], ["signup", "Sign up"]].map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => { setTab(k); setErr(null); }}>
                {tab === k && <motion.span layoutId="tab-bg" className="tab-bg" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
                {label}
              </button>
            ))}
          </div>
          {err && <div className="err" role="alert">{err}</div>}
          <AnimatePresence mode="wait">
            <motion.div key={tab} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.2 }}>
              {tab === "guest" && (
                <>
                  <p style={{ marginTop: 0, color: "var(--ink-2)", fontSize: "0.92rem" }}>You'll get a fun random name like <b>Curious Otter</b>. You can rename yourself any time.</p>
                  <button className="btn btn--grad btn--block" style={{ height: 52, fontSize: "1.02rem" }} disabled={busy} onClick={() => go("/api/auth/guest")}>
                    {busy ? <span className="spinner" style={{ borderTopColor: "#fff" }} /> : "Continue as a guest →"}
                  </button>
                </>
              )}
              {tab === "login" && (
                <form onSubmit={(e) => { e.preventDefault(); go("/api/auth/login", { handle: form.handle, password: form.password }); }}>
                  <label className="field"><span>Username</span><input className="input" autoComplete="username" placeholder="yourname" {...f("handle")} /></label>
                  <label className="field"><span>Password</span><input className="input" type="password" autoComplete="current-password" {...f("password")} /></label>
                  <button className="btn btn--block" disabled={busy}>{busy ? <span className="spinner" /> : "Log in"}</button>
                </form>
              )}
              {tab === "signup" && (
                <form onSubmit={(e) => { e.preventDefault(); go("/api/auth/signup", form); }}>
                  <label className="field"><span>Display name</span><input className="input" autoComplete="name" placeholder="Nishant Singh" {...f("name")} /></label>
                  <label className="field"><span>Username</span><input className="input" autoComplete="username" placeholder="lowercase, numbers, _" {...f("handle")} /></label>
                  <label className="field"><span>Password</span><input className="input" type="password" autoComplete="new-password" placeholder="at least 8 characters" {...f("password")} /></label>
                  <button className="btn btn--grad btn--block" disabled={busy}>{busy ? <span className="spinner" style={{ borderTopColor: "#fff" }} /> : "Create account"}</button>
                </form>
              )}
            </motion.div>
          </AnimatePresence>
          <p className="fine">Public rooms are visible to everyone who joins. Be kind. Built by <a href="https://nishant-singhaa0240274.netlify.app" target="_blank" rel="noreferrer">Nishant Singh</a> · <a href="https://github.com/NishantSingh00001/parley" target="_blank" rel="noreferrer">source</a></p>
        </motion.div>
      </div>
    </div>
  );
}
