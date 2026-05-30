/**
 * Shared types for the seller-onboarding snippet generator.
 *
 * The same input shape feeds the Express, FastAPI, and Fastify
 * templates. Each template returns a `RenderedSnippet` the API
 * route can ship straight to the dashboard UI.
 */

export type Framework = "express" | "fastapi" | "fastify";

export interface AcceptedPaymentForSnippet {
  readonly scheme: "exact";
  readonly network: string;
  readonly asset: string;
  readonly payTo: string;
  readonly maxAmountRequired: string;
  /** Human label of the network (e.g. "Base"). Used in comments. */
  readonly networkLabel: string;
}

export interface TemplateInput {
  readonly keyId: string; // reskey_xxxx, used in header comment
  readonly facilitatorUrl: string;
  readonly acceptedPayments: readonly AcceptedPaymentForSnippet[];
  readonly description: string | null;
  readonly timestamp: string; // ISO
}

export interface RenderedSnippet {
  readonly framework: Framework;
  readonly language: "javascript" | "typescript" | "python";
  readonly code: string;
  /** One env var per line, format `NAME=value`. Always at least one row. */
  readonly envVars: readonly string[];
  /** Install command (`npm i ...` or `pip install ...`). */
  readonly install: string;
  /**
   * `published` once the package is in npm/PyPI; `placeholder` while
   * we're still using a local-only middleware. The UI surfaces this
   * to set expectations.
   */
  readonly middlewareStatus: "placeholder" | "published";
}
