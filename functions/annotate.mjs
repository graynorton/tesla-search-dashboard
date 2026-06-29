// POST /api/annotate — the low-privilege client write endpoint (User-intent §6).
//
// The dashboard mints an intent ({id, kind, ...}) and POSTs it here with the APP
// SECRET. We validate the envelope and store it in the Blobs inbox keyed by its
// intent_id — so a re-POST (optimistic retry, double-tap) is idempotent. The app
// secret's entire blast radius is "append a star or a merge hint"; the real
// credential (the read secret) never reaches the browser. Blobs runs tokenless in
// the implicit site context — there is no Blobs token anywhere.
import { getStore } from "@netlify/blobs";
import { INBOX_STORE, json, secretOk, validateIntent } from "./_intent.mjs";

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "method not allowed" });
  if (!secretOk(req.headers.get("x-app-secret"), process.env.ANNOTATE_APP_SECRET))
    return json(401, { error: "unauthorized" });

  let intent;
  try {
    intent = await req.json();
  } catch {
    return json(400, { error: "body must be JSON" });
  }
  const err = validateIntent(intent);
  if (err) return json(422, { error: err });

  const store = getStore(INBOX_STORE);
  await store.setJSON(intent.id, intent);   // idempotent: same id overwrites identically
  return json(200, { ok: true, id: intent.id });
};

export const config = { path: "/api/annotate" };
