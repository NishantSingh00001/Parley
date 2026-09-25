// Minimal Gemini API client (REST, no SDK) with a model fallback chain.
// Set GEMINI_API_KEY in Netlify > Site configuration > Environment variables.
// GEMINI_MODEL is optional and is tried first.

import { env, HttpError } from "./http.mjs";

// GEMINI_ENDPOINT is optional (e.g. an API gateway); the default is Google's public endpoint.
const endpoint = () => (env("GEMINI_ENDPOINT") || "https://generativelanguage.googleapis.com/v1beta/models").replace(/\/+$/, "");
const DEFAULT_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3-flash-preview", "gemini-2.5-flash"];

export function aiConfigured() {
  return Boolean(env("GEMINI_API_KEY"));
}

// Models that answered "not found" are skipped for a while by this function instance.
const missing = new Map();

export function modelChain() {
  const preferred = env("GEMINI_MODEL");
  const all = [...new Set([preferred, ...DEFAULT_MODELS].filter(Boolean))];
  const live = all.filter((m) => !(missing.get(m) > Date.now()));
  return live.length ? live : all;
}

async function call(model, body, key, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpoint()}/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* non-JSON error body */ }
    if (!res.ok) {
      const err = new Error(data?.error?.message || `Gemini returned ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const cand = data?.candidates?.[0];
    const out = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
    if (!out) {
      const err = new Error(`Empty response (${cand?.finishReason || data?.promptFeedback?.blockReason || "unknown"})`);
      err.status = 502;
      throw err;
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generate text (or JSON when a schema is given).
 * Tries each model in the chain; moves on for missing models, quota errors
 * and server errors. Returns { text | data, model }.
 */
export async function generate({ system, prompt, schema, image, temperature = 0.6, maxOutputTokens = 4096, deadlineMs = 50000 }) {
  const key = env("GEMINI_API_KEY");
  if (!key) throw new HttpError(503, "AI is not configured on this deployment. Add GEMINI_API_KEY in Netlify.");
  const started = Date.now();
  let lastErr;
  for (const model of modelChain()) {
    const left = deadlineMs - (Date.now() - started);
    if (left < 4000) break;
    const generationConfig = { temperature, maxOutputTokens };
    if (schema) Object.assign(generationConfig, { responseMimeType: "application/json", responseSchema: schema });
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [...(image ? [{ inlineData: { mimeType: image.mimeType, data: image.data } }] : []), { text: prompt }] }],
      generationConfig,
    };
    try {
      let text;
      try {
        text = await call(model, body, key, Math.min(left, 30000));
      } catch (err) {
        // Some models reject a schema feature: retry once with JSON mode only.
        if (schema && err.status === 400 && /schema|responseSchema|response_schema/i.test(err.message)) {
          delete body.generationConfig.responseSchema;
          body.contents[0].parts[body.contents[0].parts.length - 1].text += `\n\nReply with JSON only, matching this schema:\n${JSON.stringify(schema)}`;
          text = await call(model, body, key, Math.min(deadlineMs - (Date.now() - started), 30000));
        } else throw err;
      }
      if (!schema) return { text: text.trim(), model };
      return { data: parseJson(text), model };
    } catch (err) {
      lastErr = err;
      const retryable = [404, 429, 500, 502, 503, 504].includes(err.status) || err.name === "AbortError" || err instanceof SyntaxError ||
        (err.status === 400 && /not found|not supported|unsupported|invalid model/i.test(err.message));
      console.warn(`Gemini ${model} failed: ${err.status || ""} ${err.message}`);
      if (err.status === 404 || (err.status === 400 && /not found|not supported|invalid model/i.test(err.message))) missing.set(model, Date.now() + 30 * 60 * 1000);
      if (err.status === 400 && !retryable) break;
      if ((err.status === 401 || err.status === 403) && !/model/i.test(err.message)) break;
      if (!retryable && err.status) break;
    }
  }
  const status = lastErr?.status === 429 ? 429 : 502;
  const msg = lastErr?.status === 429
    ? "The Gemini API quota is used up for now. Try again later."
    : lastErr?.status === 400 || lastErr?.status === 403
      ? "The Gemini API key was rejected. Check GEMINI_API_KEY in Netlify."
      : "The AI service didn't respond. Try again in a moment.";
  throw new HttpError(status, msg);
}

export function parseJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = cleaned.search(/[[{]/);
  return JSON.parse(start > 0 ? cleaned.slice(start) : cleaned);
}
