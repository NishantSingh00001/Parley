// Response helpers shared by the API functions.
//
// Status codes: 401 = not the owner of a run, 410 = run expired or deleted.
// We avoid 403/404 on purpose: the Netlify dev server treats those as "static
// file missing" and silently retries the URL with ".html" appended.

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function fail(status, message, extra = {}) {
  return json({ error: message, ...extra }, status);
}

export function env(name) {
  try {
    // eslint-disable-next-line no-undef
    if (typeof Netlify !== "undefined" && Netlify.env) return Netlify.env.get(name);
  } catch {
    /* fall through */
  }
  return process.env[name];
}

/** Wrap a handler so thrown errors become clean JSON responses. */
export function handler(fn) {
  return async (req, context) => {
    try {
      return await fn(req, context);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      return fail(status, status >= 500 ? "Something went wrong on the server. Please try again." : err.message);
    }
  };
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function readJson(req) {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, "Request body must be JSON.");
  }
}
