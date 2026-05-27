import { z } from "zod";

export const ListProvidersInputShape = {} as const;
export const ListProvidersInput = z.object(ListProvidersInputShape);
export type ListProvidersInput = z.infer<typeof ListProvidersInput>;

export interface ListProvidersResult {
  status: "stub";
  todo: string;
}

export function handleListProviders(): ListProvidersResult {
  return {
    status: "stub",
    todo: "Phase 2 Sub-task 5 — wrap GET /providers from the suverse-pay REST API.",
  };
}
