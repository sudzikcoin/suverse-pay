import type { Session, SessionStore } from "../session.js";

export type ToolError = { code: string; message: string };
export type ToolResult<T> = { ok: true; result: T } | { ok: false; error: ToolError };

/**
 * Resolve a session from the store, applying expiry semantics. Returns
 * a tool-shaped error if the session is missing or has expired. Does
 * NOT touch() — the calling tool should touch() on its own success.
 */
export function loadSession(
  store: SessionStore,
  sessionId: string,
): { ok: true; session: Session } | { ok: false; error: ToolError } {
  const session = store.get(sessionId);
  if (!session) {
    return {
      ok: false,
      error: {
        code: "session_not_found",
        message: `session ${sessionId} not found or has expired`,
      },
    };
  }
  if (session.destroyed) {
    return {
      ok: false,
      error: {
        code: "session_destroyed",
        message: `session ${sessionId} has been destroyed`,
      },
    };
  }
  return { ok: true, session };
}

/**
 * Strip any field that could leak the agent's secret from a value
 * before surfacing it in an error message or log. Defensive: tool
 * handlers should not be passing secret-bearing structures here in
 * the first place, but if they do, this catches the leak.
 */
const SECRET_KEYS = new Set([
  "secret",
  "mnemonic",
  "privateKey",
  "secretBytes",
  "private_key",
]);

export function sanitize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sanitize);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.has(k)) {
      out[k] = "[redacted]";
      continue;
    }
    out[k] = sanitize(v);
  }
  return out;
}

/**
 * Stringify an error without leaking secrets. Always returns a safe
 * string suitable for the agent. Falls back to "unknown error".
 */
export function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown error";
}
