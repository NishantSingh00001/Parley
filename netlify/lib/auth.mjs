// Accounts: scrypt password hashes, HS256 JWTs, guest accounts, rate limits.

import { scrypt, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import { signJwt, verifyJwt } from "../../shared/jwt.js";
import { jwtSecret } from "../../shared/secret.js";
import { store, getJSON, update, addToDirectory, publicUser } from "./db.mjs";
import { HttpError } from "./http.mjs";

const scryptAsync = promisify(scrypt);

export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function checkPassword(pw, stored) {
  const [, saltHex, keyHex] = String(stored).split("$");
  if (!saltHex || !keyHex) return false;
  const key = await scryptAsync(pw, Buffer.from(saltHex, "hex"), 64);
  const want = Buffer.from(keyHex, "hex");
  return want.length === key.length && timingSafeEqual(want, key);
}

export function newId(prefix = "u") {
  return `${prefix}${randomBytes(8).toString("hex")}`;
}

export async function issueToken(user) {
  return signJwt({ sub: user.id, name: user.name }, await jwtSecret(store()));
}

export async function liveTicket(user) {
  return signJwt({ sub: user.id, typ: "live" }, await jwtSecret(store()), { expiresIn: 60 * 10 });
}

/** The signed-in user from `Authorization: Bearer <jwt>`, or a 401. */
export async function requireUser(req) {
  const h = req.headers.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  const payload = token ? await verifyJwt(token, await jwtSecret(store())) : null;
  if (!payload || payload.typ === "live") throw new HttpError(401, "Please sign in again.");
  const user = await getJSON(`users/${payload.sub}`);
  if (!user) throw new HttpError(401, "This account no longer exists. Please sign in again.");
  return user;
}

const ADJ = ["Curious", "Sunny", "Brave", "Quiet", "Witty", "Cosmic", "Lucky", "Swift", "Gentle", "Bold", "Clever", "Chill", "Zesty", "Mellow", "Nimble", "Jolly"];
const ANIMALS = ["Otter", "Koala", "Falcon", "Panda", "Tiger", "Dolphin", "Fox", "Owl", "Lemur", "Heron", "Yak", "Gecko", "Bison", "Peacock", "Mongoose", "Hornbill"];

export function guestName() {
  const r = randomBytes(2);
  return `${ADJ[r[0] % ADJ.length]} ${ANIMALS[r[1] % ANIMALS.length]}`;
}

export function hueFor(seed) {
  return parseInt(createHash("sha1").update(seed).digest("hex").slice(0, 4), 16) % 360;
}

export function validHandle(h) {
  return /^[a-z0-9_]{3,20}$/.test(h);
}

export async function createUser({ handle, name, password, guest = false }) {
  const id = newId();
  const claimed = await store().setJSON(`handles/${handle}`, { uid: id }, { onlyIfNew: true });
  if (!claimed.modified) throw new HttpError(409, "That username is taken. Try another.");
  const user = {
    id, handle, name, guest, hue: hueFor(handle), about: "",
    pass: password ? await hashPassword(password) : null,
    createdAt: new Date().toISOString(),
  };
  await store().setJSON(`users/${id}`, user);
  await addToDirectory(user);
  return user;
}

const ipHash = (ip) => createHash("sha256").update(String(ip || "unknown")).digest("hex").slice(0, 16);

/** Fixed-window rate limit on a key such as "msg:<uid>" or "signup:<ip>". */
export async function rateLimit(key, limit, windowSec) {
  const bucket = Math.floor(Date.now() / 1000 / windowSec);
  const k = `limit/${key.replace(/[^a-zA-Z0-9:_-]/g, "")}/${bucket}`;
  let over = false;
  await update(k, (n) => {
    n = n || 0;
    if (n >= limit) { over = true; return undefined; }
    return n + 1;
  });
  if (over) throw new HttpError(429, "Slow down a little and try again in a moment.");
}

export { ipHash, publicUser };
