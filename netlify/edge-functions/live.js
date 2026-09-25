// GET /api/live?t=<ticket>&c=<active conversation>&s=<last seq the client has>
//
// A Server-Sent Events stream that runs on Netlify's edge for up to ~25 s,
// then asks the browser to reconnect. Every 700 ms it re-reads the user's
// inbox and the open conversations' heads in Netlify Blobs, checks whether
// the next message exists, and pushes only what changed: inbox updates, typing/read receipts, new messages and edits.
// Edge functions are billed per request, not per second, so one open stream
// costs the same as a single page view.

import { getStore } from "@netlify/blobs";
import { liveResponse } from "../../shared/live-core.js";

export default (req) => liveResponse(req, getStore);

export const config = { path: "/api/live" };
