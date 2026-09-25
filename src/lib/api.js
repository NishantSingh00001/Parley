const KEY = "parley.token";

let token = null;
try { token = localStorage.getItem(KEY); } catch { /* storage unavailable */ }
const listeners = new Set();

export function getToken() { return token; }
export function setToken(t) {
  token = t;
  try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch { /* ignore */ }
}
export function onSignedOut(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export async function api(path, { method = "GET", body, signal } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new ApiError("You seem to be offline. Check your connection.", 0);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (res.status === 401 && token && /sign in again|no longer exists/i.test(data?.error || "")) {
    setToken(null);
    listeners.forEach((fn) => fn());
  }
  if (!res.ok) throw new ApiError(data?.error || `Something went wrong (${res.status}).`, res.status);
  return data;
}

/** Upload with progress (fetch can't report upload progress). */
export function uploadFile(file, extra, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file, file.name);
    for (const [k, v] of Object.entries(extra || {})) if (v != null) form.append(k, String(v));
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/files");
    if (token) xhr.setRequestHeader("authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onerror = () => reject(new ApiError("Upload failed. Check your connection.", 0));
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data.file);
      else reject(new ApiError(data?.error || (xhr.status === 413 ? "Files can be up to 4 MB." : "Upload failed."), xhr.status));
    };
    xhr.send(form);
  });
}
