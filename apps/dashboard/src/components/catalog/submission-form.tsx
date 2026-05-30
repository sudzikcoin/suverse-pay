"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NETWORKS_CATALOG } from "@/lib/networks-catalog";
import { cn } from "@/lib/utils";
import { RegionSelector } from "./region-selector";

export interface SubmissionFormValues {
  title: string;
  description: string;
  endpointUrl: string;
  category: string;
  tags: string; // comma-separated; the server parses
  priceAtomicMin: string;
  priceAtomicMax: string;
  priceUnit: string;
  networks: string[];
  regions: string[];
  regionRestrictions: string[];
  facilitatorUrl: string;
  homepageUrl: string;
  documentationUrl: string;
  /** Only present in the public-submit flow. */
  email?: string;
  /** Only present in the authenticated /dashboard/catalog/new flow. */
  linkResourceKey?: string;
}

export interface SubmissionFormProps {
  /**
   * 'public'    = POSTs to /api/catalog/public-submit (anon flow,
   *               email field required, console-logged verify link)
   * 'authenticated' = POSTs to /api/catalog (auth + optional
   *               resource-key autoselect, no email)
   * 'edit'      = PUT to /api/catalog/[id] (edit existing listing)
   */
  mode: "public" | "authenticated" | "edit";
  initial?: Partial<SubmissionFormValues>;
  /** Required when mode='edit'. */
  listingId?: string;
  /**
   * Optional ownable resource keys to render as a selector — only
   * used in 'authenticated' mode. Picking one signals the API to
   * auto-verify the listing.
   */
  ownedKeys?: ReadonlyArray<{ resourceKeyId: string; label: string }>;
  onSuccess?: (result: unknown) => void;
}

const EMPTY: SubmissionFormValues = {
  title: "",
  description: "",
  endpointUrl: "",
  category: "",
  tags: "",
  priceAtomicMin: "",
  priceAtomicMax: "",
  priceUnit: "per-call",
  networks: [],
  regions: ["global"],
  regionRestrictions: [],
  facilitatorUrl: "",
  homepageUrl: "",
  documentationUrl: "",
  email: "",
  linkResourceKey: "",
};

/**
 * Shared catalog submission form. No <form> tag (project convention
 * — see CLAUDE.md). Submit lives on a button onClick.
 */
export function SubmissionForm({
  mode,
  initial,
  listingId,
  ownedKeys,
  onSuccess,
}: SubmissionFormProps): React.JSX.Element {
  const router = useRouter();
  const [v, setV] = useState<SubmissionFormValues>({
    ...EMPTY,
    ...initial,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function patch<K extends keyof SubmissionFormValues>(
    key: K,
    val: SubmissionFormValues[K],
  ): void {
    setV((prev) => ({ ...prev, [key]: val }));
  }

  function toggleNetwork(caip2: string): void {
    setV((prev) => {
      const next = prev.networks.includes(caip2)
        ? prev.networks.filter((n) => n !== caip2)
        : [...prev.networks, caip2];
      return { ...prev, networks: next };
    });
  }

  async function submit(): Promise<void> {
    setError(null);
    setSuccess(null);
    if (v.title.trim().length < 3) {
      setError("Title must be at least 3 characters.");
      return;
    }
    if (!v.endpointUrl.startsWith("https://")) {
      setError("Endpoint URL must start with https://");
      return;
    }
    if (v.networks.length === 0) {
      setError("Pick at least one network.");
      return;
    }
    if (mode === "public" && (!v.email || !v.email.includes("@"))) {
      setError("Email is required for anonymous submissions.");
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        title: v.title.trim(),
        endpointUrl: v.endpointUrl.trim(),
        networks: v.networks,
        regions: v.regions,
        regionRestrictions: v.regionRestrictions,
        priceUnit: v.priceUnit,
      };
      if (v.description.trim().length > 0) body.description = v.description.trim();
      if (v.category.trim().length > 0) body.category = v.category.trim();
      if (v.tags.trim().length > 0) {
        body.tags = v.tags.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
      }
      if (v.priceAtomicMin.trim().length > 0) body.priceAtomicMin = v.priceAtomicMin.trim();
      if (v.priceAtomicMax.trim().length > 0) body.priceAtomicMax = v.priceAtomicMax.trim();
      if (v.facilitatorUrl.trim().length > 0) body.facilitatorUrl = v.facilitatorUrl.trim();
      if (v.homepageUrl.trim().length > 0) body.homepageUrl = v.homepageUrl.trim();
      if (v.documentationUrl.trim().length > 0)
        body.documentationUrl = v.documentationUrl.trim();
      if (mode === "public" && v.email && v.email.length > 0) {
        body.email = v.email.trim();
      }
      if (
        mode === "authenticated"
        && v.linkResourceKey !== undefined
        && v.linkResourceKey.length > 0
      ) {
        body.linkResourceKey = v.linkResourceKey;
      }

      const endpoint =
        mode === "public"
          ? "/api/catalog/public-submit"
          : mode === "edit"
          ? `/api/catalog/${listingId}`
          : "/api/catalog";
      const method = mode === "edit" ? "PUT" : "POST";
      const res = await fetch(endpoint, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        listing?: { id: string };
        verification?: { email: string; expiresAt: string };
      };
      if (!res.ok) {
        setError(data.error ?? `request failed (${res.status})`);
        return;
      }
      if (mode === "public") {
        setSuccess(
          `Submitted. We sent a verification link to ${data.verification?.email}. The listing stays unpublished until both the link is clicked AND an admin approves it.`,
        );
      } else if (mode === "edit") {
        setSuccess("Saved.");
      } else if (data.listing) {
        router.push(`/dashboard/catalog`);
      }
      onSuccess?.(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-8">
      <FormField label="Title" required>
        <Input
          value={v.title}
          onChange={(e) => patch("title", e.target.value)}
          placeholder="Weather Forecast API"
          maxLength={200}
        />
      </FormField>

      <FormField label="Description">
        <textarea
          value={v.description}
          onChange={(e) => patch("description", e.target.value)}
          placeholder="What does this endpoint do? Who is it for?"
          rows={4}
          maxLength={2000}
          className="block w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        />
      </FormField>

      <FormField label="Endpoint URL" required hint="Must start with https://">
        <Input
          value={v.endpointUrl}
          onChange={(e) => patch("endpointUrl", e.target.value)}
          placeholder="https://api.example.com/v1/weather"
          type="url"
        />
      </FormField>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Category">
          <Input
            value={v.category}
            onChange={(e) => patch("category", e.target.value)}
            placeholder="weather"
            maxLength={80}
          />
        </FormField>
        <FormField label="Tags" hint="Comma-separated">
          <Input
            value={v.tags}
            onChange={(e) => patch("tags", e.target.value)}
            placeholder="weather, geo, climate"
          />
        </FormField>
      </div>

      <FormField
        label="Networks accepted"
        required
        hint="Pick every chain this endpoint accepts payment on (any facilitator)."
      >
        <div className="flex flex-wrap gap-1.5">
          {NETWORKS_CATALOG.filter((n) => n.testnet !== true).map((n) => {
            const isSel = v.networks.includes(n.caip2);
            return (
              <button
                key={n.caip2}
                type="button"
                onClick={() => toggleNetwork(n.caip2)}
                className={cn(
                  "rounded-sm border px-2 py-1 font-mono text-[11px] transition-colors",
                  isSel
                    ? "border-amber-400/60 bg-amber-400/10 text-amber-200"
                    : "border-border bg-secondary/30 text-foreground/70 hover:border-foreground/40",
                )}
                title={n.caip2}
              >
                {n.label}
              </button>
            );
          })}
        </div>
      </FormField>

      <FormField label="Regions served" hint="Picking 'Global' clears specifics.">
        <RegionSelector
          selected={v.regions}
          onChange={(next) => patch("regions", next)}
          mode="available"
        />
      </FormField>

      <FormField label="Region restrictions" hint="Block specific regions (e.g. for legal reasons).">
        <RegionSelector
          selected={v.regionRestrictions}
          onChange={(next) => patch("regionRestrictions", next)}
          mode="restricted"
        />
      </FormField>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <FormField label="Min price (atomic USDC)">
          <Input
            value={v.priceAtomicMin}
            onChange={(e) => patch("priceAtomicMin", e.target.value)}
            placeholder="1000"
            inputMode="numeric"
            pattern="[0-9]*"
          />
        </FormField>
        <FormField label="Max price (atomic USDC)">
          <Input
            value={v.priceAtomicMax}
            onChange={(e) => patch("priceAtomicMax", e.target.value)}
            placeholder="100000"
            inputMode="numeric"
            pattern="[0-9]*"
          />
        </FormField>
        <FormField label="Price unit">
          <Input
            value={v.priceUnit}
            onChange={(e) => patch("priceUnit", e.target.value)}
            placeholder="per-call"
          />
        </FormField>
      </div>

      <FormField
        label="Facilitator URL"
        hint="Optional. If you're using your own facilitator (PayAI, CDP, …), name it here."
      >
        <Input
          value={v.facilitatorUrl}
          onChange={(e) => patch("facilitatorUrl", e.target.value)}
          placeholder="https://x402.payai.network"
          type="url"
        />
      </FormField>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Homepage">
          <Input
            value={v.homepageUrl}
            onChange={(e) => patch("homepageUrl", e.target.value)}
            placeholder="https://example.com"
            type="url"
          />
        </FormField>
        <FormField label="Documentation">
          <Input
            value={v.documentationUrl}
            onChange={(e) => patch("documentationUrl", e.target.value)}
            placeholder="https://example.com/docs"
            type="url"
          />
        </FormField>
      </div>

      {mode === "public" && (
        <FormField
          label="Your email"
          required
          hint="We'll send a verification link. (For v1 it's also printed to the server log so you can self-verify in dev.)"
        >
          <Input
            value={v.email ?? ""}
            onChange={(e) => patch("email", e.target.value)}
            placeholder="you@company.com"
            type="email"
          />
        </FormField>
      )}

      {mode === "authenticated" && ownedKeys && ownedKeys.length > 0 && (
        <FormField
          label="Link a resource key (auto-verifies)"
          hint="Picking one of your suverse-pay keys auto-publishes the listing as Verified."
        >
          <select
            value={v.linkResourceKey ?? ""}
            onChange={(e) => patch("linkResourceKey", e.target.value)}
            className="h-10 w-full rounded-md border border-input bg-transparent px-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <option value="">— External (no link) —</option>
            {ownedKeys.map((k) => (
              <option key={k.resourceKeyId} value={k.resourceKeyId}>
                {k.label} ({k.resourceKeyId})
              </option>
            ))}
          </select>
        </FormField>
      )}

      {error !== null && (
        <p className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">
          {error}
        </p>
      )}
      {success !== null && (
        <p className="rounded-sm border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 font-mono text-xs text-emerald-300">
          {success}
        </p>
      )}

      <div className="flex items-center justify-end gap-3 border-t border-border pt-6">
        <Button
          onClick={submit}
          disabled={submitting}
          variant="accent"
        >
          {submitting
            ? "Submitting…"
            : mode === "edit"
              ? "Save changes"
              : "Submit listing"}
        </Button>
      </div>
    </div>
  );
}

function FormField({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          {label}
          {required && <span className="text-amber-400"> *</span>}
        </label>
        {hint !== undefined && (
          <span className="text-[10px] text-muted-foreground/80">{hint}</span>
        )}
      </div>
      {children}
    </div>
  );
}
