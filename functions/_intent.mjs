// Shared helpers for the intent inbox Functions (User-intent track §6).
// Pure, dependency-free; mirrors core/user_state.validate_intent so the inbox
// never accepts garbage the monitor would just reject anyway.
import { timingSafeEqual } from "node:crypto";

export const INBOX_STORE = "annotations-inbox";

export function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Constant-time secret compare that is also safe on length mismatch.
export function secretOk(provided, expected) {
  if (!expected) return false;            // misconfigured env → deny, never allow-all
  const a = Buffer.from(String(provided || ""));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const KINDS = new Set(["rate", "star", "same", "distinct", "dismiss", "revoke",
  "view_save", "view_delete"]);

// The ordinal triage ratings (#23). Mirrors core.user_state.RATING_RANK keys.
// null/absent = clear back to unspecified. Extend here (e.g. "love") in lockstep
// with the Python enum when an intensity tier ships.
const RATINGS = new Set(["up", "down"]);

function isPair(x) {
  return Array.isArray(x) && x.length === 2 &&
    typeof x[0] === "string" && x[0] &&
    typeof x[1] === "string" && x[1] && x[0] !== x[1];
}

// Returns an error string if the intent is malformed, else null.
export function validateIntent(intent) {
  if (!intent || typeof intent !== "object") return "not an object";
  if (typeof intent.id !== "string" || !intent.id) return "missing/empty id";
  if (!KINDS.has(intent.kind)) return `unknown kind ${intent.kind}`;
  if (intent.kind === "rate") {
    if (typeof intent.unit !== "string" || !intent.unit) return "rate: missing unit";
    if (intent.rating != null && !RATINGS.has(intent.rating))
      return "rate: rating must be up|down|null";
  } else if (intent.kind === "star") {
    // legacy positive-only kind — back-compat for in-flight intents (#23).
    if (typeof intent.unit !== "string" || !intent.unit) return "star: missing unit";
    if ("starred" in intent && typeof intent.starred !== "boolean")
      return "star: starred must be bool";
  } else if (intent.kind === "same" || intent.kind === "distinct") {
    if (!isPair(intent.units)) return `${intent.kind}: units must be two distinct ids`;
  } else if (intent.kind === "dismiss") {
    if (!isPair(intent.pair)) return "dismiss: pair must be two distinct ids";
  } else if (intent.kind === "revoke") {
    if (typeof intent.target !== "string" || !intent.target) return "revoke: missing target";
  } else if (intent.kind === "view_save") {
    if (typeof intent.view !== "string" || !intent.view) return "view_save: missing view id";
    if (typeof intent.name !== "string" || !intent.name) return "view_save: missing name";
    if (!intent.spec || typeof intent.spec !== "object") return "view_save: spec must be an object";
  } else if (intent.kind === "view_delete") {
    if (typeof intent.view !== "string" || !intent.view) return "view_delete: missing view id";
  }
  return null;
}
