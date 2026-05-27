import { z } from "zod";
import type { SessionStore } from "../session.js";

export const EndSessionInputShape = {
  sessionId: z.string().uuid(),
} as const;
export const EndSessionInput = z.object(EndSessionInputShape);
export type EndSessionInput = z.infer<typeof EndSessionInput>;

export interface EndSessionResult {
  removed: boolean;
}

export function handleEndSession(
  input: EndSessionInput,
  deps: { store: SessionStore },
): EndSessionResult {
  return { removed: deps.store.remove(input.sessionId) };
}
