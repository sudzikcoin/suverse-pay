"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { HelpTip } from "@/components/ui/help-tip";
import { Input } from "@/components/ui/input";
import { CATALOG_CATEGORIES } from "@/lib/catalog-categories";
import type { NamespaceFamily, NetworkEntry } from "@/lib/networks-catalog";
import { cn } from "@/lib/utils";

interface Props {
  ownedKeys: Array<{ resourceKeyId: string; label: string }>;
  networksCatalog: NetworkEntry[];
  proxyBase: string;
}

interface FormState {
  resourceKeyId: string;
  endpointSlug: string;
  originalUrl: string;
  originalMethod: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  displayName: string;
  description: string;
  priceUsdc: string;
  acceptedNetworks: string[];
  payToEvm: string;
  payToSolana: string;
  payToCosmos: string;
  payToTron: string;
  headers: Array<{ name: string; value: string }>;
  isActive: boolean;
  publishToCatalog: boolean;
  catalogDescription: string;
  catalogCategory: string;
  catalogTags: string;
  catalogSampleRequest: string;
  catalogSampleResponse: string;
}

function initialState(firstKey: string): FormState {
  return {
    resourceKeyId: firstKey,
    endpointSlug: "",
    originalUrl: "https://",
    originalMethod: "POST",
    displayName: "",
    description: "",
    priceUsdc: "0.05",
    acceptedNetworks: ["eip155:8453"],
    payToEvm: "",
    payToSolana: "",
    payToCosmos: "",
    payToTron: "",
    headers: [],
    isActive: true,
    publishToCatalog: true,
    catalogDescription: "",
    catalogCategory: "data",
    catalogTags: "",
    catalogSampleRequest: "",
    catalogSampleResponse: "",
  };
}

function usdcToAtomic(s: string): string | null {
  const trimmed = s.trim();
  if (!/^[0-9]+(\.[0-9]{1,6})?$/.test(trimmed)) return null;
  const [whole, fracRaw = ""] = trimmed.split(".");
  const frac = (fracRaw + "000000").slice(0, 6);
  const combined = BigInt(whole || "0") * 1_000_000n + BigInt(frac);
  return combined.toString();
}

function selectedFamilies(
  selected: string[],
  catalog: NetworkEntry[],
): Set<NamespaceFamily> {
  const out = new Set<NamespaceFamily>();
  for (const c of selected) {
    const entry = catalog.find((n) => n.caip2 === c);
    if (entry) out.add(entry.namespace);
  }
  return out;
}

export function NewProxyForm({
  ownedKeys,
  networksCatalog,
  proxyBase,
}: Props): React.JSX.Element {
  const router = useRouter();
  const [state, setState] = useState<FormState>(() =>
    initialState(ownedKeys[0]!.resourceKeyId),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<
    Array<{ field: string; message: string }>
  >([]);

  const families = useMemo(
    () => selectedFamilies(state.acceptedNetworks, networksCatalog),
    [state.acceptedNetworks, networksCatalog],
  );

  const previewUrl = `${proxyBase}/v1/proxy/${state.resourceKeyId}/${
    state.endpointSlug || "<slug>"
  }`;

  async function submit(): Promise<void> {
    setError(null);
    setFieldErrors([]);
    const atomic = usdcToAtomic(state.priceUsdc);
    if (atomic === null) {
      setFieldErrors([{ field: "priceUsdc", message: "invalid price" }]);
      return;
    }
    const headersMap: Record<string, string> = {};
    for (const h of state.headers) {
      if (h.name.trim() === "") continue;
      headersMap[h.name.trim()] = h.value;
    }
    // Per-field client validation for the optional catalog block —
    // surfaces the same 100..500 char rule the server enforces.
    if (state.publishToCatalog) {
      const len = state.catalogDescription.trim().length;
      if (len < 100 || len > 500) {
        setFieldErrors([
          {
            field: "catalogDescription",
            message: `description must be 100–500 characters (currently ${len})`,
          },
        ]);
        return;
      }
    }
    setSubmitting(true);
    try {
      const catalogBlock = state.publishToCatalog
        ? {
            description: state.catalogDescription.trim(),
            category: state.catalogCategory,
            tags: state.catalogTags
              .split(",")
              .map((t) => t.trim())
              .filter((t) => t.length > 0),
            sampleRequestCurl:
              state.catalogSampleRequest.trim() || undefined,
            sampleResponseJson:
              state.catalogSampleResponse.trim() || undefined,
          }
        : undefined;
      const res = await fetch("/api/proxies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resourceKeyId: state.resourceKeyId,
          config: {
            endpointSlug: state.endpointSlug,
            originalUrl: state.originalUrl,
            originalMethod: state.originalMethod,
            displayName: state.displayName.trim() || null,
            description: state.description.trim() || null,
            priceAtomic: atomic,
            acceptedNetworks: state.acceptedNetworks,
            payToEvm: state.payToEvm.trim() || null,
            payToSolana: state.payToSolana.trim() || null,
            payToCosmos: state.payToCosmos.trim() || null,
            payToTron: state.payToTron.trim() || null,
            forwardHeaders:
              Object.keys(headersMap).length > 0 ? headersMap : undefined,
            isActive: state.isActive,
            catalogListing: catalogBlock,
          },
        }),
      });
      const json = (await res.json()) as {
        proxy?: { id: string };
        error?: string;
        message?: string;
        details?: unknown;
      };
      if (!res.ok || !json.proxy) {
        if (Array.isArray(json.details)) {
          setFieldErrors(
            json.details as Array<{ field: string; message: string }>,
          );
        }
        setError(json.message ?? json.error ?? `error ${res.status}`);
        return;
      }
      router.push(`/dashboard/proxies/${json.proxy.id}?just-created=1`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function errorFor(field: string): string | undefined {
    return fieldErrors.find((f) => f.field === field)?.message;
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="space-y-6"
    >
      <Section title="Resource key">
        <select
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
          value={state.resourceKeyId}
          onChange={(e) =>
            setState((s) => ({ ...s, resourceKeyId: e.target.value }))
          }
        >
          {ownedKeys.map((k) => (
            <option key={k.resourceKeyId} value={k.resourceKeyId}>
              {k.label} ({k.resourceKeyId})
            </option>
          ))}
        </select>
      </Section>

      <Section
        title="Endpoint slug"
        hint="Lowercase letters / digits / hyphens. Combined with the resource key to build the proxy URL."
        error={errorFor("endpointSlug")}
        help={
          <>
            The slug is the public part of your proxy URL. Pick something
            short and memorable like <code>forecast</code> or{" "}
            <code>geocode-v1</code>. You can change it later by deleting
            and re-creating the proxy.
          </>
        }
      >
        <Input
          value={state.endpointSlug}
          onChange={(e) =>
            setState((s) => ({
              ...s,
              endpointSlug: e.target.value.toLowerCase(),
            }))
          }
          placeholder="forecast"
          className="font-mono"
        />
        <p className="mt-2 truncate font-mono text-[11px] text-amber-300">
          {previewUrl}
        </p>
      </Section>

      <Section
        title="Upstream URL"
        hint="The HTTPS URL we forward paid requests to."
        error={errorFor("originalUrl")}
        help={
          <>
            The original API endpoint you already operate. We never
            cache the response — every paid request hits your upstream
            in real time. Must be HTTPS; localhost / private IPs are
            blocked at the gateway.
          </>
        }
      >
        <div className="flex gap-2">
          <select
            className="rounded-md border border-input bg-transparent px-3 py-2 text-sm"
            value={state.originalMethod}
            onChange={(e) =>
              setState((s) => ({
                ...s,
                originalMethod: e.target.value as FormState["originalMethod"],
              }))
            }
          >
            {(["GET", "POST", "PUT", "DELETE", "PATCH"] as const).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <Input
            type="url"
            value={state.originalUrl}
            onChange={(e) =>
              setState((s) => ({ ...s, originalUrl: e.target.value }))
            }
            placeholder="https://api.example.com/v1/forecast"
            className="flex-1 font-mono text-xs"
          />
        </div>
      </Section>

      <Section title="Display name (optional)">
        <Input
          value={state.displayName}
          onChange={(e) =>
            setState((s) => ({ ...s, displayName: e.target.value }))
          }
          placeholder="Weather forecast API"
        />
      </Section>

      <Section
        title="Description (optional)"
        hint="Surfaces in the 402 challenge body and in agent UIs."
      >
        <textarea
          value={state.description}
          onChange={(e) =>
            setState((s) => ({ ...s, description: e.target.value }))
          }
          rows={2}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
          placeholder="Returns the 7-day forecast for a US zip code."
        />
      </Section>

      <Section
        title="Price per call (USDC)"
        hint="$0.001 – $10. Charged on every successful settle."
        error={errorFor("priceUsdc") ?? errorFor("priceAtomic")}
        help={
          <>
            Each successful call costs the buyer this amount in USDC.
            Sweet spot is usually $0.01 – $0.50 for data APIs. We
            charge a small platform fee on top (see the invoice export
            on your dashboard).
          </>
        }
      >
        <Input
          value={state.priceUsdc}
          onChange={(e) =>
            setState((s) => ({ ...s, priceUsdc: e.target.value }))
          }
          inputMode="decimal"
          className="font-mono"
        />
      </Section>

      <Section
        title="Accepted networks"
        hint="Buyers may pay on any of these chains. Each network needs the matching receive address below."
        error={errorFor("acceptedNetworks")}
        help={
          <>
            Pick the chains you have wallets on. Base is the most
            common today for x402 buyers; Solana is gaining traction.
            More chains = more buyers reachable, but each one needs a
            valid receive address below.
          </>
        }
      >
        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {networksCatalog.map((n) => {
            const checked = state.acceptedNetworks.includes(n.caip2);
            return (
              <label
                key={n.caip2}
                className={cn(
                  "flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                  checked
                    ? "border-amber-400/40 bg-amber-400/5"
                    : "border-border hover:bg-secondary/40",
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    setState((s) => ({
                      ...s,
                      acceptedNetworks: checked
                        ? s.acceptedNetworks.filter((c) => c !== n.caip2)
                        : [...s.acceptedNetworks, n.caip2],
                    }))
                  }
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{n.label}</div>
                  <div className="truncate font-mono text-[10px] text-muted-foreground">
                    {n.caip2}
                  </div>
                </div>
              </label>
            );
          })}
        </div>
      </Section>

      <Section
        title="Receive wallets"
        hint="One per network family. We never custody — these are the addresses the buyer transfers USDC to."
        help={
          <>
            We are non-custodial. The buyer signs a transfer straight
            to YOUR address; suverse-pay only verifies and broadcasts.
            Use a wallet you control — e.g. a Coinbase Smart Wallet on
            Base or a Phantom wallet on Solana.
          </>
        }
      >
        <div className="space-y-3">
          {families.has("evm") ? (
            <PayInput
              label="EVM (Base / Polygon / …)"
              value={state.payToEvm}
              placeholder="0x..."
              error={errorFor("payToEvm")}
              onChange={(v) => setState((s) => ({ ...s, payToEvm: v }))}
            />
          ) : null}
          {families.has("solana") ? (
            <PayInput
              label="Solana"
              value={state.payToSolana}
              placeholder="base58 pubkey"
              error={errorFor("payToSolana")}
              onChange={(v) => setState((s) => ({ ...s, payToSolana: v }))}
            />
          ) : null}
          {families.has("cosmos") ? (
            <PayInput
              label="Cosmos · Noble"
              value={state.payToCosmos}
              placeholder="noble1..."
              error={errorFor("payToCosmos")}
              onChange={(v) => setState((s) => ({ ...s, payToCosmos: v }))}
            />
          ) : null}
          {families.has("tron") ? (
            <PayInput
              label="TRON"
              value={state.payToTron}
              placeholder="T..."
              error={errorFor("payToTron")}
              onChange={(v) => setState((s) => ({ ...s, payToTron: v }))}
            />
          ) : null}
        </div>
      </Section>

      <Section
        title="Forwarded headers (optional)"
        hint="Auth keys / tokens we attach to every upstream call. Stored encrypted at rest; never returned to the dashboard after save."
        help={
          <>
            Use this if your upstream needs an <code>Authorization</code>{" "}
            or <code>X-API-Key</code> header. The buyer never sees the
            value — only your upstream API does. Encrypted at rest with
            AES-GCM and never returned via API.
          </>
        }
      >
        <div className="space-y-2">
          {state.headers.map((h, i) => (
            <div key={i} className="flex gap-2">
              <Input
                value={h.name}
                onChange={(e) =>
                  setState((s) => ({
                    ...s,
                    headers: s.headers.map((row, j) =>
                      j === i ? { ...row, name: e.target.value } : row,
                    ),
                  }))
                }
                placeholder="X-API-Key"
                className="font-mono text-xs"
              />
              <Input
                value={h.value}
                onChange={(e) =>
                  setState((s) => ({
                    ...s,
                    headers: s.headers.map((row, j) =>
                      j === i ? { ...row, value: e.target.value } : row,
                    ),
                  }))
                }
                placeholder="secret-upstream-token"
                className="flex-1 font-mono text-xs"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  setState((s) => ({
                    ...s,
                    headers: s.headers.filter((_, j) => j !== i),
                  }))
                }
              >
                ×
              </Button>
            </div>
          ))}
          {state.headers.length < 16 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setState((s) => ({
                  ...s,
                  headers: [...s.headers, { name: "", value: "" }],
                }))
              }
            >
              + Add header
            </Button>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Maximum 16 headers per proxy.
            </p>
          )}
        </div>
      </Section>

      <Section
        title="Publish to public catalog"
        hint="Listed at /catalog after a quick moderator review. Buyers can discover and call your endpoint with one click."
        help={
          <>
            Catalog listings get reviewed within 24h. You can edit or
            unpublish them later from the dashboard. Skip this for
            private/internal proxies — the proxy works either way.
          </>
        }
      >
        <label className="mb-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={state.publishToCatalog}
            onChange={(e) =>
              setState((s) => ({ ...s, publishToCatalog: e.target.checked }))
            }
          />
          <span>Publish this proxy to the public catalog</span>
        </label>
        {state.publishToCatalog ? (
          <div className="space-y-4 rounded-md border border-border bg-card/30 p-4">
            <div>
              <div className="flex items-center justify-between">
                <label className="text-[11px] uppercase tracking-[0.15em] text-muted-foreground">
                  Description (100–500 chars)
                </label>
                <span
                  className={cn(
                    "font-mono text-[11px]",
                    state.catalogDescription.length < 100 ||
                      state.catalogDescription.length > 500
                      ? "text-destructive"
                      : "text-muted-foreground",
                  )}
                >
                  {state.catalogDescription.length}/500
                </span>
              </div>
              <textarea
                value={state.catalogDescription}
                onChange={(e) =>
                  setState((s) => ({
                    ...s,
                    catalogDescription: e.target.value,
                  }))
                }
                rows={4}
                maxLength={500}
                placeholder="What does this endpoint return? Who is it for? What input does it expect?"
                className="mt-1 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
              />
              {errorFor("catalogDescription") ? (
                <p className="mt-1 text-[11px] text-destructive">
                  {errorFor("catalogDescription")}
                </p>
              ) : null}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-[11px] uppercase tracking-[0.15em] text-muted-foreground">
                  Category
                </label>
                <select
                  value={state.catalogCategory}
                  onChange={(e) =>
                    setState((s) => ({
                      ...s,
                      catalogCategory: e.target.value,
                    }))
                  }
                  className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
                >
                  {CATALOG_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[11px] uppercase tracking-[0.15em] text-muted-foreground">
                  Tags (comma separated, optional)
                </label>
                <Input
                  value={state.catalogTags}
                  onChange={(e) =>
                    setState((s) => ({ ...s, catalogTags: e.target.value }))
                  }
                  placeholder="weather, US, hourly"
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-[0.15em] text-muted-foreground">
                Sample request (curl one-liner, optional)
              </label>
              <textarea
                value={state.catalogSampleRequest}
                onChange={(e) =>
                  setState((s) => ({
                    ...s,
                    catalogSampleRequest: e.target.value,
                  }))
                }
                rows={2}
                placeholder={`curl -X ${state.originalMethod} ${previewUrl}`}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-[11px]"
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-[0.15em] text-muted-foreground">
                Sample response (JSON, optional)
              </label>
              <textarea
                value={state.catalogSampleResponse}
                onChange={(e) =>
                  setState((s) => ({
                    ...s,
                    catalogSampleResponse: e.target.value,
                  }))
                }
                rows={4}
                placeholder={`{\n  "temp_f": 72,\n  "summary": "clear"\n}`}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-[11px]"
              />
            </div>
          </div>
        ) : null}
      </Section>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-3">
        <Button asChild variant="ghost" type="button">
          <a href="/dashboard/proxies">Cancel</a>
        </Button>
        <Button
          type="submit"
          variant="accent"
          disabled={submitting || state.endpointSlug.trim() === ""}
        >
          {submitting ? "Creating…" : "Create proxy"}
        </Button>
      </div>
    </form>
  );
}

function Section({
  title,
  hint,
  error,
  help,
  children,
}: {
  title: string;
  hint?: string;
  error?: string;
  help?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {help ? <HelpTip>{help}</HelpTip> : null}
      </div>
      {hint ? (
        <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>
      ) : null}
      <div className="mt-3">{children}</div>
      {error ? (
        <p className="mt-2 text-[11px] text-destructive">{error}</p>
      ) : null}
    </section>
  );
}

function PayInput({
  label,
  value,
  placeholder,
  error,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  error?: string;
  onChange: (v: string) => void;
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-1 text-[11px] uppercase tracking-[0.15em] text-muted-foreground">
        {label}
      </div>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="font-mono text-xs"
      />
      {error ? (
        <p className="mt-1 text-[11px] text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
