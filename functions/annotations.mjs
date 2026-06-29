// /api/annotations — the monitor-side inbox drain (User-intent §6).
//
// GET    → { intents: [...] }  every queued intent (the monitor drains each cycle
//          and idempotently applies them; reads are NON-destructive so a crash
//          before apply+save loses nothing).
// DELETE → { ids: [...] }      lazy GC: drop intents the monitor has already
//          applied (correctness does not depend on this — the monitor's
//          applied_intents ledger is the real at-least-once guarantee).
//
// Both are gated by the READ SECRET, which lives only in the monitor's .env and is
// never shipped to the browser. Tokenless Blobs access via the implicit site context.
import { getStore } from "@netlify/blobs";
import { INBOX_STORE, json, secretOk } from "./_intent.mjs";

export default async (req) => {
  if (!secretOk(req.headers.get("x-read-secret"), process.env.ANNOTATE_READ_SECRET))
    return json(401, { error: "unauthorized" });

  const store = getStore(INBOX_STORE);

  if (req.method === "GET") {
    const { blobs } = await store.list();
    const intents = [];
    for (const b of blobs) {
      const v = await store.get(b.key, { type: "json" });
      if (v) intents.push(v);
    }
    return json(200, { intents });
  }

  if (req.method === "DELETE") {
    let ids = [];
    try {
      ({ ids = [] } = await req.json());
    } catch {
      ids = [];
    }
    let deleted = 0;
    for (const id of ids) {
      if (typeof id === "string" && id) {
        await store.delete(id);
        deleted += 1;
      }
    }
    return json(200, { deleted });
  }

  return json(405, { error: "method not allowed" });
};

export const config = { path: "/api/annotations" };
