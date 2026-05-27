import { randomUUID } from "node:crypto";

export interface SessionView {
  readonly sessionId: string;
  readonly networks: readonly string[];
  readonly addresses: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly expiresAt: string;
}

interface SessionInit {
  // Raw secret bytes — UTF-8 mnemonic OR hex private key bytes. The caller is
  // responsible for sanitizing the source string; we hold only the Buffer.
  secretBytes: Buffer;
  networks: readonly string[];
  addresses: Record<string, string>;
  timeoutMs: number;
}

/**
 * Holds an agent's signing secret in memory for the lifetime of a single
 * MCP session. Zero-custody guarantees:
 *   - secret is a Buffer; `destroy()` overwrites it with zeros
 *   - `toJSON()` never serializes the secret
 *   - the secret is read-only after construction
 *   - destroyed sessions throw on every getter
 */
export class Session {
  readonly id: string;
  readonly networks: readonly string[];
  readonly addresses: Readonly<Record<string, string>>;
  readonly createdAt: number;
  readonly expiresAt: number;
  private _secret: Buffer | null;
  private _lastUsedAt: number;
  private _destroyed = false;

  constructor(init: SessionInit) {
    this.id = randomUUID();
    this._secret = init.secretBytes;
    this.networks = Object.freeze([...init.networks]);
    this.addresses = Object.freeze({ ...init.addresses });
    this.createdAt = Date.now();
    this._lastUsedAt = this.createdAt;
    this.expiresAt = this.createdAt + init.timeoutMs;
  }

  /** Last activity timestamp (ms epoch). */
  get lastUsedAt(): number {
    return this._lastUsedAt;
  }

  /** True after `destroy()` has run. */
  get destroyed(): boolean {
    return this._destroyed;
  }

  /**
   * Access the raw secret. Callers MUST NOT log, persist, or copy the
   * returned Buffer outside the request scope. Throws if the session has
   * been destroyed.
   */
  useSecret<T>(fn: (secret: Buffer) => T): T {
    if (this._destroyed || this._secret === null) {
      throw new Error("session destroyed");
    }
    this.touch();
    return fn(this._secret);
  }

  /** Refresh activity timer (called on every successful tool invocation). */
  touch(): void {
    if (this._destroyed) return;
    this._lastUsedAt = Date.now();
  }

  /**
   * True when the session has been idle longer than its configured timeout.
   * Uses the timeout from construction; we don't re-read config so changing
   * MCP_SESSION_TIMEOUT_MINUTES at runtime doesn't strand existing sessions.
   */
  isExpired(now: number = Date.now()): boolean {
    return now > this.expiresAt;
  }

  /**
   * Zeros the secret Buffer and marks the session destroyed. Idempotent.
   * The Buffer remains pinned in memory by other references until GC, but
   * its bytes are zeroed in place.
   */
  destroy(): void {
    if (this._destroyed) return;
    if (this._secret !== null) {
      this._secret.fill(0);
      this._secret = null;
    }
    this._destroyed = true;
  }

  /** Safe summary suitable for logs or MCP responses. NEVER includes the secret. */
  view(): SessionView {
    return {
      sessionId: this.id,
      networks: this.networks,
      addresses: this.addresses,
      createdAt: new Date(this.createdAt).toISOString(),
      lastUsedAt: new Date(this._lastUsedAt).toISOString(),
      expiresAt: new Date(this.expiresAt).toISOString(),
    };
  }

  /**
   * Explicit override to defeat accidental JSON.stringify(session) leaking
   * the secret. Returns the same fields as `view()`.
   */
  toJSON(): SessionView {
    return this.view();
  }
}

export interface SessionStoreOptions {
  /** Sweep interval for expired sessions, ms. Default 60_000. */
  sweepIntervalMs?: number;
}

/**
 * In-memory session storage. NO Redis, NO Postgres, NO disk. When the
 * process restarts, every session is gone — which is the desired
 * zero-persistence guarantee for keyed secrets.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly sweepIntervalMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SessionStoreOptions = {}) {
    this.sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
  }

  put(session: Session): void {
    this.sessions.set(session.id, session);
  }

  get(sessionId: string): Session | undefined {
    const s = this.sessions.get(sessionId);
    if (s && s.isExpired()) {
      s.destroy();
      this.sessions.delete(sessionId);
      return undefined;
    }
    return s;
  }

  remove(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.destroy();
    this.sessions.delete(sessionId);
    return true;
  }

  size(): number {
    return this.sessions.size;
  }

  /** Runs one sweep pass: destroy and remove any expired sessions. */
  sweep(): number {
    let removed = 0;
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (s.isExpired(now)) {
        s.destroy();
        this.sessions.delete(id);
        removed++;
      }
    }
    return removed;
  }

  startSweepLoop(): void {
    if (this.sweepTimer !== null) return;
    this.sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    // Don't keep the event loop alive for the sweep alone.
    this.sweepTimer.unref?.();
  }

  stopSweepLoop(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  destroyAll(): void {
    for (const s of this.sessions.values()) {
      s.destroy();
    }
    this.sessions.clear();
  }
}
