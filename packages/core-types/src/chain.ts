import { z } from "zod";

const CAIP2_REGEX = /^([-a-z0-9]{3,8}):([-_a-zA-Z0-9]{1,32})$/;

export const Caip2Schema = z
  .string()
  .regex(CAIP2_REGEX, "Invalid CAIP-2 identifier");

export type Caip2 = z.infer<typeof Caip2Schema>;

export interface ParsedCaip2 {
  namespace: string;
  reference: string;
}

export function parseCaip2(value: string): ParsedCaip2 {
  const m = CAIP2_REGEX.exec(value);
  if (!m) {
    throw new Error(`Invalid CAIP-2 identifier: ${value}`);
  }
  return { namespace: m[1]!, reference: m[2]! };
}

export function stringifyCaip2(parsed: ParsedCaip2): Caip2 {
  const joined = `${parsed.namespace}:${parsed.reference}`;
  if (!CAIP2_REGEX.test(joined)) {
    throw new Error(`Invalid CAIP-2 components: ${joined}`);
  }
  return joined;
}

export function isCaip2(value: unknown): value is Caip2 {
  return typeof value === "string" && CAIP2_REGEX.test(value);
}

export const CAIP2_NAMESPACE = {
  EIP155: "eip155",
  COSMOS: "cosmos",
  SOLANA: "solana",
} as const;

export type Caip2Namespace = (typeof CAIP2_NAMESPACE)[keyof typeof CAIP2_NAMESPACE];

export function isEvm(network: Caip2): boolean {
  return parseCaip2(network).namespace === CAIP2_NAMESPACE.EIP155;
}

export function isCosmos(network: Caip2): boolean {
  return parseCaip2(network).namespace === CAIP2_NAMESPACE.COSMOS;
}

export function isSolana(network: Caip2): boolean {
  return parseCaip2(network).namespace === CAIP2_NAMESPACE.SOLANA;
}
