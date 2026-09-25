import { useEffect, useState } from "react";
import { AnimatePresence } from "framer-motion";
import Landing from "./components/Landing.jsx";
import Sidebar from "./components/Sidebar.jsx";
import Chat from "./components/Chat.jsx";
import { InfoPanel, NewChat, Profile, Lightbox } from "./components/Panels.jsx";
import { Toasts } from "./components/bits.jsx";
import { useStore, boot, convTitle, unreadFor, getState } from "./lib/store.js";
import { getToken, onSignedOut } from "./lib/api.js";
import { startLive } from "./lib/live.js";

function Mesh() {
  return <div className="mesh" aria-hidden="true"><i /><i /><i /><i /></div>;
}

export default function App() {
  const status = useStore((s) => s.status);
  const active = useStore((s) => s.active);
  const [signedIn, setSignedIn] = useState(Boolean(getToken()));
  const [info, setInfo] = useState(false);
  const [modal, setModal] = useState(null);
  const [img, setImg] = useState(null);

  useEffect(() => onSignedOut(() => setSignedIn(false)), []);
  useEffect(() => {
    if (!signedIn) return;
    boot().then((ok) => { if (ok) startLive(); else if (!getToken()) setSignedIn(false); });
  }, [signedIn]);

  // Unread count in the tab title.
  const unread = useStore((s) => Object.values(s.convs).reduce((n, c) => n + (c.type === "room" ? 0 : unreadFor(c, s)), 0));
  const title = useStore((s) => (s.active ? convTitle(s.convs[s.active], s) : ""));
  useEffect(() => { document.title = `${unread ? `(${unread}) ` : ""}${title ? `${title} · ` : ""}Parley`; }, [unread, title]);

  if (!signedIn || status === "signed-out") return <><Mesh /><Landing onSignedIn={() => setSignedIn(true)} /><Toasts /></>;
  if (status === "boot") return <><Mesh /><div style={{ height: "100%", display: "grid", placeItems: "center" }}><span className="spinner" style={{ width: 28, height: 28 }} /></div></>;
  if (status === "error") {
    return (
      <><Mesh /><div style={{ height: "100%", display: "grid", placeItems: "center", textAlign: "center", padding: 24 }}>
        <div><h2 style={{ fontFamily: "var(--f-display)" }}>Couldn't reach Parley</h2><p>{getState().bootError}</p><button className="btn" onClick={() => location.reload()}>Try again</button></div>
      </div></>
    );
  }
  return (
    <>
      <Mesh />
      <div className={`shell ${active ? "show-chat" : ""}`}>
        <Sidebar onNew={() => setModal("new")} onProfile={() => setModal("profile")} />
        <Chat onInfo={() => setInfo((v) => !v)} infoOpen={info} onImage={setImg} />
        <AnimatePresence>{info && active && <InfoPanel key="info" onClose={() => setInfo(false)} onImage={setImg} />}</AnimatePresence>
      </div>
      <AnimatePresence>
        {modal === "new" && <NewChat key="new" onClose={() => setModal(null)} />}
        {modal === "profile" && <Profile key="profile" onClose={() => setModal(null)} />}
      </AnimatePresence>
      <Lightbox src={img} onClose={() => setImg(null)} />
      <Toasts />
    </>
  );
}
