// Local-development twin of the live edge function (netlify dev can't always
// start the edge runtime offline). Disabled on deployed sites, where
// /api/live runs at the edge.

import { getStore } from "@netlify/blobs";
import { liveResponse } from "../../shared/live-core.js";

export default async (req) => {
  if (process.env.NETLIFY_DEV !== "true") {
    return new Response(JSON.stringify({ error: "Use /api/live." }), { status: 410, headers: { "content-type": "application/json" } });
  }
  return liveResponse(req, getStore);
};

export const config = { path: "/api/live-node" };
