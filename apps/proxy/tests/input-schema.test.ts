/**
 * Unit tests for the per-config input-schema classifier (Task 57,
 * migration 037). The decision table mirrors handlers/discovery.ts:
 * empty/placeholder → discovery; present-but-invalid → 400/422;
 * valid → valid; unusable schema → null (validate nothing).
 */

import { describe, expect, it } from "vitest";
import {
  classifyBodyAgainstSchema,
  parseProxyInputSchema,
  type ProxyInputSchema,
} from "../src/input-schema.js";

const TXID_SCHEMA: ProxyInputSchema = {
  type: "object",
  required: ["txid"],
  properties: {
    txid: { type: "string", pattern: "^[0-9a-f]{64}$" },
  },
};

const buf = (v: unknown): Buffer => Buffer.from(JSON.stringify(v));

describe("parseProxyInputSchema", () => {
  it("returns null for null / undefined / scalars / arrays", () => {
    expect(parseProxyInputSchema(null)).toBeNull();
    expect(parseProxyInputSchema(undefined)).toBeNull();
    expect(parseProxyInputSchema("x")).toBeNull();
    expect(parseProxyInputSchema(42)).toBeNull();
    expect(parseProxyInputSchema([])).toBeNull();
  });

  it("returns null when type != object", () => {
    expect(parseProxyInputSchema({ type: "array" })).toBeNull();
  });

  it("returns null when there is nothing to validate", () => {
    expect(parseProxyInputSchema({ type: "object" })).toBeNull();
    expect(
      parseProxyInputSchema({ type: "object", required: [], properties: {} }),
    ).toBeNull();
  });

  it("parses a usable schema and drops junk required entries", () => {
    const parsed = parseProxyInputSchema({
      type: "object",
      required: ["txid", 42, ""],
      properties: { txid: { type: "string" }, junk: null },
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.required).toEqual(["txid"]);
    expect(Object.keys(parsed!.properties!)).toEqual(["txid"]);
  });
});

describe("classifyBodyAgainstSchema", () => {
  const VALID_TXID = "a".repeat(64);

  it("empty / whitespace / null bodies → discovery", () => {
    expect(classifyBodyAgainstSchema(null, TXID_SCHEMA).kind).toBe("discovery");
    expect(classifyBodyAgainstSchema(Buffer.from(""), TXID_SCHEMA).kind).toBe(
      "discovery",
    );
    expect(
      classifyBodyAgainstSchema(Buffer.from("   \n"), TXID_SCHEMA).kind,
    ).toBe("discovery");
    expect(
      classifyBodyAgainstSchema(Buffer.from("null"), TXID_SCHEMA).kind,
    ).toBe("discovery");
  });

  it("empty object / placeholder values → discovery", () => {
    expect(classifyBodyAgainstSchema(buf({}), TXID_SCHEMA).kind).toBe(
      "discovery",
    );
    for (const placeholder of ["string", "<txid>", "YOUR_TX_ID", "example"]) {
      expect(
        classifyBodyAgainstSchema(buf({ txid: placeholder }), TXID_SCHEMA)
          .kind,
      ).toBe("discovery");
    }
    // null-filled probe
    expect(
      classifyBodyAgainstSchema(buf({ txid: null }), TXID_SCHEMA).kind,
    ).toBe("discovery");
  });

  it("unparseable JSON → invalid 400", () => {
    const v = classifyBodyAgainstSchema(Buffer.from("{nope"), TXID_SCHEMA);
    expect(v).toMatchObject({ kind: "invalid", status: 400 });
  });

  it("non-object top level → invalid 422", () => {
    expect(
      classifyBodyAgainstSchema(buf(["a"]), TXID_SCHEMA),
    ).toMatchObject({ kind: "invalid", status: 422 });
    expect(classifyBodyAgainstSchema(buf(7), TXID_SCHEMA)).toMatchObject({
      kind: "invalid",
      status: 422,
    });
  });

  it("real value failing pattern → invalid 422", () => {
    const v = classifyBodyAgainstSchema(
      buf({ txid: "deadbeef-not-64-hex" }),
      TXID_SCHEMA,
    );
    expect(v).toMatchObject({ kind: "invalid", status: 422 });
  });

  it("wrong type for required field → invalid 422", () => {
    const v = classifyBodyAgainstSchema(buf({ txid: 12345 }), TXID_SCHEMA);
    expect(v).toMatchObject({ kind: "invalid", status: 422 });
  });

  it("valid body → valid", () => {
    expect(
      classifyBodyAgainstSchema(buf({ txid: VALID_TXID }), TXID_SCHEMA).kind,
    ).toBe("valid");
  });

  it("partial real attempt (one required real, one missing) → 422", () => {
    const schema: ProxyInputSchema = {
      type: "object",
      required: ["txid", "chain"],
      properties: {
        txid: { type: "string", pattern: "^[0-9a-f]{64}$" },
        chain: { type: "string" },
      },
    };
    const v = classifyBodyAgainstSchema(buf({ txid: VALID_TXID }), schema);
    expect(v).toMatchObject({ kind: "invalid", status: 422 });
    expect((v as { body: { missing: string[] } }).body.missing).toEqual([
      "chain",
    ]);
  });

  it("all required missing/placeholder on multi-field schema → discovery", () => {
    const schema: ProxyInputSchema = {
      type: "object",
      required: ["txid", "chain"],
      properties: {
        txid: { type: "string" },
        chain: { type: "string" },
      },
    };
    expect(classifyBodyAgainstSchema(buf({}), schema).kind).toBe("discovery");
    expect(
      classifyBodyAgainstSchema(
        buf({ txid: "string", chain: "<chain>" }),
        schema,
      ).kind,
    ).toBe("discovery");
  });

  it("optional declared property with wrong type → 422", () => {
    const schema: ProxyInputSchema = {
      type: "object",
      required: ["txid"],
      properties: {
        txid: { type: "string", pattern: "^[0-9a-f]{64}$" },
        limit: { type: "number" },
      },
    };
    const v = classifyBodyAgainstSchema(
      buf({ txid: VALID_TXID, limit: "ten" }),
      schema,
    );
    expect(v).toMatchObject({ kind: "invalid", status: 422 });
  });

  it("enum constraint: rejects off-enum, accepts placeholder words the enum allows", () => {
    const schema: ProxyInputSchema = {
      type: "object",
      required: ["mode"],
      properties: { mode: { type: "string", enum: ["test", "live"] } },
    };
    // "test" is a PLACEHOLDER_WORD but explicitly allowed by the enum.
    expect(classifyBodyAgainstSchema(buf({ mode: "test" }), schema).kind).toBe(
      "valid",
    );
    expect(
      classifyBodyAgainstSchema(buf({ mode: "prod" }), schema),
    ).toMatchObject({ kind: "invalid", status: 422 });
  });

  it("minLength / maxLength enforced for strings", () => {
    const schema: ProxyInputSchema = {
      type: "object",
      required: ["q"],
      properties: { q: { type: "string", minLength: 5, maxLength: 8 } },
    };
    expect(
      classifyBodyAgainstSchema(buf({ q: "1234" }), schema),
    ).toMatchObject({ kind: "invalid", status: 422 });
    expect(
      classifyBodyAgainstSchema(buf({ q: "123456789" }), schema),
    ).toMatchObject({ kind: "invalid", status: 422 });
    expect(classifyBodyAgainstSchema(buf({ q: "12345" }), schema).kind).toBe(
      "valid",
    );
  });

  it("invalid seller regex is skipped (fail-open), not fatal", () => {
    const schema: ProxyInputSchema = {
      type: "object",
      required: ["q"],
      properties: { q: { type: "string", pattern: "([unclosed" } },
    };
    expect(
      classifyBodyAgainstSchema(buf({ q: "anything-real" }), schema).kind,
    ).toBe("valid");
  });
});
