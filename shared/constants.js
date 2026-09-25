// Shared by the browser, the API function and the live edge function.

export const ROOMS = [
  { id: "lobby", name: "lobby", emoji: "👋", topic: "Say hi. Everyone who joins Parley lands here." },
  { id: "ai-ml", name: "ai-ml", emoji: "🧠", topic: "Models, papers, Kaggle, and whatever broke in training today." },
  { id: "placements", name: "placements", emoji: "💼", topic: "Interviews, offers, referrals and resume reviews." },
  { id: "random", name: "random", emoji: "🎲", topic: "Anything else. Memes welcome." },
];
export const ROOM_IDS = ROOMS.map((r) => r.id);

export const GEMINI_USER = { id: "gemini", name: "Gemini", handle: "gemini", hue: 262, bot: true };
export const SYSTEM_USER = { id: "system", name: "Parley", handle: "parley", hue: 330, bot: true };

export const CHUNK = 100; // messages per storage chunk
export const PAGE = 50; // messages per API page
export const MAX_TEXT = 2000;
export const MAX_FILE = 4 * 1024 * 1024; // Netlify's request limit is 6 MB (4.5 MB for binary)
export const TYPING_TTL = 6000;
export const ONLINE_TTL = 75000;
export const REACTIONS = ["👍", "❤️", "😂", "😮", "🔥", "🙏"];

export function env(name) {
  // Netlify.env works in both functions and edge functions; process.env is the
  // fallback for Node. Deno may refuse env access, so every read is guarded.
  try {
    if (globalThis.Netlify?.env?.get) return globalThis.Netlify.env.get(name) || undefined;
  } catch { /* fall through */ }
  try {
    return globalThis.process?.env?.[name];
  } catch {
    return undefined;
  }
}

export function dmId(a, b) {
  return `dm-${[a, b].sort().join("-")}`;
}
