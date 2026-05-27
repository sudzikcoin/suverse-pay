import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Session, SessionStore } from "./session.js";

const TEST_SECRET = "twelve word seed that the test pretends is valid for tests purposes only ok ok";

function makeSession(timeoutMs = 60_000): Session {
  return new Session({
    secretBytes: Buffer.from(TEST_SECRET, "utf8"),
    networks: ["cosmos:grand-1"],
    addresses: { "cosmos:grand-1": "noble1example" },
    timeoutMs,
  });
}

describe("Session", () => {
  it("constructor produces a uuid id", () => {
    const s = makeSession();
    expect(s.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("useSecret() yields the secret only inside its callback", () => {
    const s = makeSession();
    let observed: string | null = null;
    s.useSecret((buf) => {
      observed = buf.toString("utf8");
    });
    expect(observed).toBe(TEST_SECRET);
  });

  it("useSecret() throws after destroy()", () => {
    const s = makeSession();
    s.destroy();
    expect(() => s.useSecret(() => 1)).toThrow(/destroyed/);
    expect(s.destroyed).toBe(true);
  });

  it("destroy() zeroes the secret buffer", () => {
    const buf = Buffer.from(TEST_SECRET, "utf8");
    const s = new Session({
      secretBytes: buf,
      networks: ["cosmos:grand-1"],
      addresses: { "cosmos:grand-1": "noble1example" },
      timeoutMs: 60_000,
    });
    expect(buf.includes("twelve")).toBe(true);
    s.destroy();
    // The buffer the caller handed in is zeroed in place.
    expect(buf.every((b) => b === 0)).toBe(true);
  });

  it("destroy() is idempotent", () => {
    const s = makeSession();
    s.destroy();
    expect(() => s.destroy()).not.toThrow();
  });

  it("toJSON() excludes the secret", () => {
    const s = makeSession();
    const serialized = JSON.stringify(s);
    expect(serialized).not.toContain("twelve");
    expect(serialized).not.toContain("seed");
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    expect(parsed["secret"]).toBeUndefined();
    expect(parsed["secretBytes"]).toBeUndefined();
    expect(parsed["_secret"]).toBeUndefined();
    expect(parsed["sessionId"]).toBe(s.id);
    expect(parsed["addresses"]).toEqual({ "cosmos:grand-1": "noble1example" });
  });

  it("touch() updates lastUsedAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const s = makeSession();
    expect(s.lastUsedAt).toBe(1_000_000);
    vi.setSystemTime(1_000_500);
    s.touch();
    expect(s.lastUsedAt).toBe(1_000_500);
    vi.useRealTimers();
  });

  it("isExpired() returns true past the timeout", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const s = makeSession(1000);
    expect(s.isExpired()).toBe(false);
    vi.setSystemTime(1001);
    expect(s.isExpired()).toBe(true);
    vi.useRealTimers();
  });
});

describe("SessionStore", () => {
  let store: SessionStore;
  beforeEach(() => {
    store = new SessionStore();
  });
  afterEach(() => {
    store.stopSweepLoop();
    store.destroyAll();
  });

  it("put + get round-trips a live session", () => {
    const s = makeSession();
    store.put(s);
    expect(store.get(s.id)).toBe(s);
    expect(store.size()).toBe(1);
  });

  it("get() returns undefined for an expired session and removes it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const s = makeSession(1000);
    store.put(s);
    vi.setSystemTime(2000);
    expect(store.get(s.id)).toBeUndefined();
    expect(store.size()).toBe(0);
    vi.useRealTimers();
  });

  it("remove() destroys and deletes", () => {
    const s = makeSession();
    store.put(s);
    expect(store.remove(s.id)).toBe(true);
    expect(s.destroyed).toBe(true);
    expect(store.remove(s.id)).toBe(false);
  });

  it("sweep() drops expired sessions only", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const short = makeSession(1000);
    const long = makeSession(60_000);
    store.put(short);
    store.put(long);
    vi.setSystemTime(2000);
    const removed = store.sweep();
    expect(removed).toBe(1);
    expect(store.size()).toBe(1);
    expect(short.destroyed).toBe(true);
    expect(long.destroyed).toBe(false);
    vi.useRealTimers();
  });

  it("startSweepLoop()/stopSweepLoop() is idempotent and tickable", () => {
    vi.useFakeTimers();
    const sweepSpy = vi.spyOn(store, "sweep");
    store.startSweepLoop();
    store.startSweepLoop(); // double start is a no-op
    vi.advanceTimersByTime(60_000);
    expect(sweepSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(sweepSpy).toHaveBeenCalledTimes(2);
    store.stopSweepLoop();
    vi.advanceTimersByTime(60_000);
    expect(sweepSpy).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
