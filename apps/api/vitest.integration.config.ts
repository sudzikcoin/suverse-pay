import { defineConfig } from "vitest/config";

/**
 * Integration suite — drives `pnpm test:integration`. Requires a live
 * Postgres + Redis. Per-file isolation so each `tests/integration/*.test.ts`
 * gets its own clean DB+Redis state via the shared `setup.ts` hooks.
 */
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    // Integration tests share Postgres + Redis. Serialize files to
    // avoid TRUNCATE races. Within a file, beforeEach owns cleanup.
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
