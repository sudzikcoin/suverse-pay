import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { name, version } from "../src/meta.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("meta", () => {
  it("name + version stay in sync with package.json", async () => {
    const pkgPath = resolve(__dirname, "..", "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
      name: string;
      version: string;
    };
    expect(name).toBe(pkg.name);
    expect(version).toBe(pkg.version);
  });
});
