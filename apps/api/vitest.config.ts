import { defineConfig } from "vitest/config";

/**
 * Default config — drives `pnpm test`. Covers the in-memory unit
 * suite in `src/__tests__/` and explicitly excludes `tests/integration/`
 * (which needs a live Postgres + Redis and is driven by
 * `pnpm test:integration` against the docker-compose stack).
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["tests/integration/**", "node_modules/**", "dist/**"],
  },
});
