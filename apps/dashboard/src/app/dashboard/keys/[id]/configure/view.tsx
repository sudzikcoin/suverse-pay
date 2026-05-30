"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DashboardHeader } from "@/components/layout/dashboard-header";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { Input } from "@/components/ui/input";
import type {
  NamespaceFamily,
  NetworkEntry,
} from "@/lib/networks-catalog";
import type { ResourceServerConfig } from "@/lib/seller-config";
import { cn } from "@/lib/utils";

interface SnippetPayload {
  framework: "express" | "fastify" | "fastapi";
  language: "javascript" | "typescript" | "python";
  code: string;
  envVars: string[];
  install: string;
  middlewareStatus: "placeholder" | "published";
}

interface ProbeCheck {
  name: string;
  passed: boolean;
  detail: string;
}
interface ProbeResult {
  ok: boolean;
  checks: ProbeCheck[];
  rawResponse: string | null;
  status: number | null;
}

interface Props {
  keyId: string;
  keyLabel: string;
  initialConfig: ResourceServerConfig | null;
  networksCatalog: NetworkEntry[];
  facilitatorUrl: string;
}

interface FormState {
  defaultPriceUsdc: string; // user-edited string, converted on submit
  acceptedNetworks: string[];
  payToEvm: string;
  payToSolana: string;
  payToCosmos: string;
  payToTron: string;
  description: string;
}

/**
 * Initialise form state from an existing config (or sensible defaults
 * if the seller has never configured). Price is shown to the human
 * in USDC; atomic conversion lives in `formStateToBody`.
 */
function initialFormState(config: ResourceServerConfig | null): FormState {
  if (!config) {
    return {
      defaultPriceUsdc: "0.07",
      acceptedNetworks: [],
      payToEvm: "",
      payToSolana: "",
      payToCosmos: "",
      payToTron: "",
      description: "",
    };
  }
  return {
    defaultPriceUsdc: atomicToUsdc(config.defaultPriceAtomic),
    acceptedNetworks: [...config.acceptedNetworks],
    payToEvm: config.payToEvm ?? "",
    payToSolana: config.payToSolana ?? "",
    payToCosmos: config.payToCosmos ?? "",
    payToTron: config.payToTron ?? "",
    description: config.description ?? "",
  };
}

function atomicToUsdc(atomic: string): string {
  try {
    const n = BigInt(atomic);
    const whole = n / 1_000_000n;
    const frac = n % 1_000_000n;
    if (frac === 0n) return whole.toString();
    const padded = frac.toString().padStart(6, "0").replace(/0+$/, "");
    return `${whole}.${padded}`;
  } catch {
    return "0";
  }
}

function usdcToAtomic(usdc: string): string | null {
  const trimmed = usdc.trim();
  if (!/^[0-9]+(\.[0-9]{1,6})?$/.test(trimmed)) return null;
  const [whole, fracRaw = ""] = trimmed.split(".");
  const frac = (fracRaw + "000000").slice(0, 6);
  const combined = BigInt(whole || "0") * 1_000_000n + BigInt(frac);
  return combined.toString();
}

function namespaceFor(family: NamespaceFamily, state: FormState): string {
  switch (family) {
    case "evm":
      return state.payToEvm;
    case "solana":
      return state.payToSolana;
    case "cosmos":
      return state.payToCosmos;
    case "tron":
      return state.payToTron;
  }
}

function selectedFamilies(
  state: FormState,
  catalog: NetworkEntry[],
): Set<NamespaceFamily> {
  const set = new Set<NamespaceFamily>();
  for (const id of state.acceptedNetworks) {
    const entry = catalog.find((n) => n.caip2 === id);
    if (entry) set.add(entry.namespace);
  }
  return set;
}

interface SubmitBody {
  defaultPriceAtomic: string;
  acceptedNetworks: string[];
  payToEvm: string | null;
  payToSolana: string | null;
  payToCosmos: string | null;
  payToTron: string | null;
  description: string | null;
}

function formStateToBody(
  state: FormState,
  families: Set<NamespaceFamily>,
): SubmitBody | { error: string } {
  const atomic = usdcToAtomic(state.defaultPriceUsdc);
  if (!atomic) {
    return { error: "Price must look like 0.07 (up to 6 decimals)" };
  }
  return {
    defaultPriceAtomic: atomic,
    acceptedNetworks: state.acceptedNetworks,
    payToEvm: families.has("evm") ? state.payToEvm.trim() : null,
    payToSolana: families.has("solana") ? state.payToSolana.trim() : null,
    payToCosmos: families.has("cosmos") ? state.payToCosmos.trim() : null,
    payToTron: families.has("tron") ? state.payToTron.trim() : null,
    description:
      state.description.trim() === "" ? null : state.description.trim(),
  };
}

// ---------------------------------------------------------------
// Root component
// ---------------------------------------------------------------

export function ConfigureView({
  keyId,
  keyLabel,
  initialConfig,
  networksCatalog,
  facilitatorUrl,
}: Props): React.JSX.Element {
  const qc = useQueryClient();
  const [state, setState] = useState<FormState>(() =>
    initialFormState(initialConfig),
  );
  const [hasSavedOnce, setHasSavedOnce] = useState(initialConfig !== null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">(
    "idle",
  );

  const families = useMemo(
    () => selectedFamilies(state, networksCatalog),
    [state, networksCatalog],
  );

  const saveMut = useMutation({
    mutationFn: async () => {
      setSaveError(null);
      const body = formStateToBody(state, families);
      if ("error" in body) throw new Error(body.error);
      const res = await fetch(
        `/api/keys/${encodeURIComponent(keyId)}/config`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const json = (await res.json()) as { error?: string; config?: unknown };
      if (!res.ok) throw new Error(json.error ?? `save ${res.status}`);
      return json.config;
    },
    onMutate: () => setSaveStatus("saving"),
    onError: (err) => {
      setSaveStatus("idle");
      setSaveError(err instanceof Error ? err.message : String(err));
    },
    onSuccess: () => {
      setHasSavedOnce(true);
      setSaveStatus("saved");
      void qc.invalidateQueries({ queryKey: ["snippet", keyId] });
    },
  });

  return (
    <>
      <DashboardHeader
        sticky
        breadcrumb={[
          { label: "Dashboard", href: "/dashboard" },
          { label: "Keys" },
          { label: keyLabel },
          { label: "Configure" },
        ]}
        right={
          <Link
            href="/dashboard/docs/configure-resource-server"
            className="hidden text-xs text-muted-foreground hover:text-foreground sm:inline"
          >
            5-min setup guide →
          </Link>
        }
      />

      <div className="container grid grid-cols-1 gap-8 py-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
        <div className="space-y-8">
          <KeyHeaderCard
            keyId={keyId}
            keyLabel={keyLabel}
            hasSaved={hasSavedOnce}
          />

          <Section
            n={1}
            title="Accepted networks"
            description="Which chains will you accept payments on? Toggle one or more. Base is recommended for first integrations."
          >
            <NetworksPicker
              catalog={networksCatalog}
              selected={state.acceptedNetworks}
              onChange={(next) =>
                setState((s) => ({ ...s, acceptedNetworks: next }))
              }
            />
          </Section>

          <Section
            n={2}
            title="Receive wallets"
            description="One per network family. We never custody — these are the addresses your snippet hands clients in the 402 challenge."
          >
            <PayToInputs
              state={state}
              families={families}
              setState={setState}
            />
          </Section>

          <Section
            n={3}
            title="Default price"
            description="Charged per call. Stored as atomic USDC ($0.07 = 70 000 atomic units). Per-endpoint pricing coming in a follow-up."
          >
            <PriceInput
              value={state.defaultPriceUsdc}
              onChange={(v) =>
                setState((s) => ({ ...s, defaultPriceUsdc: v }))
              }
            />
          </Section>

          <Section
            n={4}
            title="Description"
            description="Optional. Surfaces in agent UIs that list paid endpoints and in our future discovery catalog."
          >
            <DescriptionInput
              value={state.description}
              onChange={(v) =>
                setState((s) => ({ ...s, description: v }))
              }
            />
          </Section>

          <Section n={5} title="Save configuration" description="">
            <SaveBar
              status={saveStatus}
              error={saveError}
              onClick={() => saveMut.mutate()}
              hasNetworks={state.acceptedNetworks.length > 0}
            />
          </Section>

          <Section
            n={6}
            title="Integration snippet"
            description="Drop into your project, install the deps, set the env var, and you're live."
            disabled={!hasSavedOnce}
            disabledHint="Save your configuration first."
          >
            <SnippetTabs keyId={keyId} enabled={hasSavedOnce} />
          </Section>

          <Section
            n={7}
            title="Verify setup"
            description="Once your resource server is live, paste its URL — we'll hit it (no payment) and check the 402 challenge looks right."
            disabled={!hasSavedOnce}
            disabledHint="Save your configuration first."
          >
            <ProbePanel keyId={keyId} enabled={hasSavedOnce} />
          </Section>
        </div>

        <aside className="hidden lg:block">
          <PreviewCard
            state={state}
            catalog={networksCatalog}
            facilitatorUrl={facilitatorUrl}
          />
        </aside>
      </div>
    </>
  );
}

// ---------------------------------------------------------------
// Helper components
// ---------------------------------------------------------------

function KeyHeaderCard({
  keyId,
  keyLabel,
  hasSaved,
}: {
  keyId: string;
  keyLabel: string;
  hasSaved: boolean;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
            Resource key
          </div>
          <div className="mt-1 truncate text-2xl font-semibold">
            {keyLabel}
          </div>
          <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
            {keyId} ·{" "}
            <span className="opacity-80">sup_live_</span>
            <span className="opacity-40">••••••••••••••••••••••••••••••••</span>
          </div>
        </div>
        <div
          className={cn(
            "rounded-md border px-3 py-1 text-[10px] font-medium uppercase tracking-[0.15em]",
            hasSaved
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
              : "border-amber-500/40 bg-amber-500/10 text-amber-300",
          )}
        >
          {hasSaved ? "Configured" : "Setup needed"}
        </div>
      </div>
    </div>
  );
}

function Section({
  n,
  title,
  description,
  children,
  disabled = false,
  disabledHint,
}: {
  n: number;
  title: string;
  description: string;
  children: React.ReactNode;
  disabled?: boolean;
  disabledHint?: string;
}): React.JSX.Element {
  return (
    <section
      className={cn(
        "rounded-lg border border-border bg-card p-6 transition-opacity",
        disabled && "opacity-50",
      )}
      aria-disabled={disabled}
    >
      <div className="mb-4 flex items-start gap-4">
        <div className="font-mono text-xs text-amber-400">0{n}</div>
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          {description ? (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          ) : null}
          {disabled && disabledHint ? (
            <p className="mt-1 text-xs text-amber-400">{disabledHint}</p>
          ) : null}
        </div>
      </div>
      <div className={disabled ? "pointer-events-none" : undefined}>
        {children}
      </div>
    </section>
  );
}

function NetworksPicker({
  catalog,
  selected,
  onChange,
}: {
  catalog: NetworkEntry[];
  selected: string[];
  onChange: (next: string[]) => void;
}): React.JSX.Element {
  const families: Array<{
    name: NamespaceFamily;
    label: string;
    entries: NetworkEntry[];
  }> = [
    {
      name: "evm",
      label: "EVM networks",
      entries: catalog.filter((c) => c.namespace === "evm" && !c.testnet),
    },
    {
      name: "solana",
      label: "Solana",
      entries: catalog.filter((c) => c.namespace === "solana"),
    },
    {
      name: "cosmos",
      label: "Cosmos",
      entries: catalog.filter((c) => c.namespace === "cosmos"),
    },
    {
      name: "tron",
      label: "TRON",
      entries: catalog.filter((c) => c.namespace === "tron"),
    },
  ];
  const testnets = catalog.filter((c) => c.testnet);
  const toggle = (caip2: string) => {
    if (selected.includes(caip2)) {
      onChange(selected.filter((s) => s !== caip2));
    } else {
      onChange([...selected, caip2]);
    }
  };
  return (
    <div className="space-y-6">
      {families.map((f) => (
        <div key={f.name}>
          <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
            {f.label}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {f.entries.map((n) => (
              <NetworkRow
                key={n.caip2}
                entry={n}
                checked={selected.includes(n.caip2)}
                onToggle={() => toggle(n.caip2)}
              />
            ))}
          </div>
        </div>
      ))}
      {testnets.length > 0 ? (
        <details className="rounded-md border border-border/60 px-4 py-3">
          <summary className="cursor-pointer text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
            Testnets
          </summary>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {testnets.map((n) => (
              <NetworkRow
                key={n.caip2}
                entry={n}
                checked={selected.includes(n.caip2)}
                onToggle={() => toggle(n.caip2)}
              />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function NetworkRow({
  entry,
  checked,
  onToggle,
}: {
  entry: NetworkEntry;
  checked: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-md border border-border bg-background/40 px-3 py-2 text-sm transition-colors hover:border-amber-500/40",
        checked && "border-amber-500/50 bg-amber-500/5",
      )}
    >
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 accent-amber-500"
        checked={checked}
        onChange={onToggle}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{entry.label}</span>
          {entry.recommended ? (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-amber-300">
              Recommended
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
          {entry.caip2}
        </div>
        {entry.hint ? (
          <div className="mt-1 text-[11px] text-muted-foreground">
            {entry.hint}
          </div>
        ) : null}
      </div>
    </label>
  );
}

function PayToInputs({
  state,
  families,
  setState,
}: {
  state: FormState;
  families: Set<NamespaceFamily>;
  setState: React.Dispatch<React.SetStateAction<FormState>>;
}): React.JSX.Element {
  const rows: Array<{
    family: NamespaceFamily;
    label: string;
    hint: string;
    value: string;
    setValue: (v: string) => void;
  }> = [
    {
      family: "evm",
      label: "EVM wallet (Base, Polygon, Arbitrum, …)",
      hint: "format: 0x + 40 hex chars",
      value: state.payToEvm,
      setValue: (v) => setState((s) => ({ ...s, payToEvm: v })),
    },
    {
      family: "solana",
      label: "Solana wallet",
      hint: "base58, 32-44 chars (no 0/O/I/l)",
      value: state.payToSolana,
      setValue: (v) => setState((s) => ({ ...s, payToSolana: v })),
    },
    {
      family: "cosmos",
      label: "Cosmos · Noble wallet",
      hint: "noble1… (bech32, 44 chars)",
      value: state.payToCosmos,
      setValue: (v) => setState((s) => ({ ...s, payToCosmos: v })),
    },
    {
      family: "tron",
      label: "TRON wallet",
      hint: "T… (base58, 34 chars)",
      value: state.payToTron,
      setValue: (v) => setState((s) => ({ ...s, payToTron: v })),
    },
  ];
  const visible = rows.filter((r) => families.has(r.family));
  if (visible.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Pick at least one network above to reveal the matching address
        input.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {visible.map((r) => (
        <div key={r.family}>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {r.label}
          </label>
          <Input
            type="text"
            value={r.value}
            placeholder={
              r.family === "evm"
                ? "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0"
                : r.family === "solana"
                  ? "CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM"
                  : r.family === "cosmos"
                    ? "noble1…"
                    : "T…"
            }
            onChange={(e) => r.setValue(e.target.value)}
          />
          <div className="mt-1 text-[11px] text-muted-foreground">
            {r.hint}
          </div>
        </div>
      ))}
    </div>
  );
}

function PriceInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}): React.JSX.Element {
  return (
    <div className="max-w-xs">
      <label className="mb-1 block text-xs font-medium text-muted-foreground">
        Default price per call (USDC)
      </label>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
          $
        </span>
        <Input
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="pl-7 font-mono"
        />
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        min $0.001, max $10 (atomic stored as integer)
      </div>
    </div>
  );
}

function DescriptionInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}): React.JSX.Element {
  return (
    <div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        maxLength={500}
        placeholder="What does your resource server do? (optional)"
        className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      />
      <div className="mt-1 text-right text-[11px] text-muted-foreground">
        {value.length} / 500
      </div>
    </div>
  );
}

function SaveBar({
  status,
  error,
  onClick,
  hasNetworks,
}: {
  status: "idle" | "saving" | "saved";
  error: string | null;
  onClick: () => void;
  hasNetworks: boolean;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <Button
        type="button"
        variant="accent"
        onClick={onClick}
        disabled={status === "saving" || !hasNetworks}
      >
        {status === "saving"
          ? "Saving…"
          : status === "saved"
            ? "Save again"
            : "Save configuration"}
      </Button>
      {!hasNetworks ? (
        <span className="text-xs text-amber-400">
          Pick at least one accepted network to enable Save.
        </span>
      ) : status === "saved" ? (
        <span className="text-xs text-emerald-300">
          Saved · sections 06 + 07 unlocked
        </span>
      ) : error ? (
        <span className="text-xs text-destructive">{error}</span>
      ) : null}
    </div>
  );
}

function SnippetTabs({
  keyId,
  enabled,
}: {
  keyId: string;
  enabled: boolean;
}): React.JSX.Element {
  const [framework, setFramework] = useState<
    "express" | "fastify" | "fastapi"
  >("express");
  const [snippet, setSnippet] = useState<SnippetPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(fw: "express" | "fastify" | "fastapi") {
    if (!enabled) return;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(
        `/api/keys/${encodeURIComponent(keyId)}/snippet?framework=${fw}`,
      );
      const data = (await res.json()) as {
        snippet?: SnippetPayload;
        error?: string;
      };
      if (!res.ok || !data.snippet) {
        throw new Error(data.error ?? `snippet ${res.status}`);
      }
      setSnippet(data.snippet);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSnippet(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1 border-b border-border">
        {(
          ["express", "fastify", "fastapi"] as const
        ).map((fw) => (
          <button
            key={fw}
            type="button"
            onClick={() => {
              setFramework(fw);
              void load(fw);
            }}
            className={cn(
              "px-3 py-2 text-xs font-medium uppercase tracking-wider",
              framework === fw
                ? "border-b-2 border-amber-400 text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {fw === "fastapi" ? "FastAPI" : fw[0]!.toUpperCase() + fw.slice(1)}
          </button>
        ))}
      </div>

      {!snippet && !loading ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => void load(framework)}
          disabled={!enabled}
        >
          Generate {framework} snippet
        </Button>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted-foreground">Generating…</p>
      ) : null}

      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : null}

      {snippet ? (
        <div className="space-y-3">
          <div className="text-xs text-muted-foreground">
            Install:{" "}
            <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">
              {snippet.install}
            </code>
          </div>
          {snippet.middlewareStatus === "placeholder" ? (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200">
              Python middleware package coming in the next sub-task. For
              now the snippet inlines a working manual implementation
              against the same facilitator.
            </div>
          ) : null}
          <CodeBlock
            value={snippet.code}
            maxHeightClass="max-h-[28rem]"
          />
          <div className="rounded-md border border-border bg-background/40 p-4">
            <CodeBlock
              value={snippet.envVars.join("\n")}
              label=".env"
              tone="inline"
            />
            <p className="mt-2 text-[11px] text-muted-foreground">
              The plaintext API key shown to you at creation time goes
              after <code>sup_live_</code>. We do NOT store the
              plaintext — if you lost it, create a new key.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ProbePanel({
  keyId,
  enabled,
}: {
  keyId: string;
  enabled: boolean;
}): React.JSX.Element {
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    if (!enabled) return;
    setError(null);
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(
        `/api/keys/${encodeURIComponent(keyId)}/probe`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        },
      );
      const data = (await res.json()) as ProbeResult & { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? `probe ${res.status}`);
      }
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://your-server.example/paid"
          disabled={!enabled}
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => void run()}
          disabled={!enabled || loading || url.trim() === ""}
        >
          {loading ? "Probing…" : "Run probe"}
        </Button>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {result ? (
        <div className="rounded-md border border-border bg-background/40 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm">
            <span
              className={cn(
                "inline-block h-2.5 w-2.5 rounded-full",
                result.ok ? "bg-emerald-400" : "bg-rose-400",
              )}
            />
            {result.ok ? "All checks passed" : "Checks failed"}
          </div>
          <ul className="space-y-1">
            {result.checks.map((c) => (
              <li
                key={c.name}
                className="flex items-start gap-2 text-xs"
              >
                <span
                  className={cn(
                    "mt-0.5 inline-block h-1.5 w-1.5 rounded-full",
                    c.passed ? "bg-emerald-400" : "bg-rose-400",
                  )}
                />
                <span className="font-mono text-muted-foreground">
                  {c.name}
                </span>
                <span>{c.detail}</span>
              </li>
            ))}
          </ul>
          {result.rawResponse ? (
            <details className="mt-3 text-[11px] text-muted-foreground">
              <summary className="cursor-pointer">
                Show raw response body
              </summary>
              <div className="mt-2">
                <CodeBlock value={result.rawResponse} />
              </div>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PreviewCard({
  state,
  catalog,
  facilitatorUrl,
}: {
  state: FormState;
  catalog: NetworkEntry[];
  facilitatorUrl: string;
}): React.JSX.Element {
  const families = selectedFamilies(state, catalog);
  const accepts = state.acceptedNetworks
    .map((id) => {
      const entry = catalog.find((c) => c.caip2 === id);
      if (!entry) return null;
      const payTo = namespaceFor(entry.namespace, state).trim();
      const atomic = usdcToAtomic(state.defaultPriceUsdc) ?? "0";
      return {
        scheme: "exact",
        network: entry.caip2,
        asset: entry.usdcAsset,
        payTo: payTo === "" ? "(unset)" : payTo,
        maxAmountRequired: atomic,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const challenge = {
    x402Version: 2,
    accepts,
    facilitator: facilitatorUrl,
    ...(state.description.trim() !== "" && { description: state.description }),
  };

  return (
    <div className="sticky top-24 rounded-lg border border-border bg-card p-5">
      <div className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
        Preview · 402 challenge body
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        This is what your server will return on an unpaid request.
        Updates as you edit.
      </p>
      <div className="mt-3">
        <CodeBlock
          value={JSON.stringify(challenge, null, 2)}
          maxHeightClass="max-h-[60vh]"
        />
      </div>
      <div className="mt-3 text-[10px] text-muted-foreground">
        Families: {families.size === 0 ? "—" : [...families].join(", ")}
      </div>
    </div>
  );
}
