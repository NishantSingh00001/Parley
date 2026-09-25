// The JWT signing secret: JWT_SECRET if set, otherwise a random secret that
// is generated once and kept in Netlify Blobs (so the app needs no setup).
import { env } from "./constants.js";

let cached = null;

export async function jwtSecret(store) {
  if (cached) return cached;
  const fromEnv = env("JWT_SECRET");
  if (fromEnv && fromEnv.length >= 16) return (cached = fromEnv);
  let s = await store.get("cfg/jwt", { consistency: "strong" });
  if (!s) {
    const bytes = crypto.getRandomValues(new Uint8Array(48));
    const fresh = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    await store.set("cfg/jwt", fresh, { onlyIfNew: true });
    s = await store.get("cfg/jwt", { consistency: "strong" });
  }
  return (cached = s);
}
