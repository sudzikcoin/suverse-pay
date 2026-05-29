"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatRelativeTime } from "@/lib/utils";

const KNOWN_EVENTS = ["settle.succeeded", "settle.failed"] as const;
type WebhookEventType = (typeof KNOWN_EVENTS)[number];

interface WebhookEndpoint {
  id: string;
  url: string;
  description: string;
  events: ReadonlyArray<WebhookEventType>;
  isActive: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

interface CreatedEndpoint extends WebhookEndpoint {
  secret: string;
}

interface WebhookDelivery {
  id: string;
  eventId: string;
  eventType: string;
  status: "pending" | "success" | "failed" | "dead";
  attempts: number;
  maxAttempts: number;
  lastAttemptAt: string | null;
  lastResponseCode: number | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
}

async function fetchEndpoints(): Promise<WebhookEndpoint[]> {
  const res = await fetch("/api/webhooks", { cache: "no-store" });
  if (!res.ok) throw new Error(`webhooks ${res.status}`);
  const body = (await res.json()) as { endpoints: WebhookEndpoint[] };
  return body.endpoints;
}

async function createEndpoint(args: {
  url: string;
  description: string;
  events: ReadonlyArray<WebhookEventType>;
}): Promise<CreatedEndpoint> {
  const res = await fetch("/api/webhooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `create ${res.status}`);
  }
  return (await res.json()) as CreatedEndpoint;
}

async function deleteEndpoint(id: string): Promise<void> {
  const res = await fetch(`/api/webhooks/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `delete ${res.status}`);
  }
}

async function fetchDeliveries(endpointId: string): Promise<WebhookDelivery[]> {
  const res = await fetch(
    `/api/webhooks/${encodeURIComponent(endpointId)}/deliveries?limit=50`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(`deliveries ${res.status}`);
  const body = (await res.json()) as { deliveries: WebhookDelivery[] };
  return body.deliveries;
}

async function retryDelivery(endpointId: string, deliveryId: string): Promise<void> {
  const res = await fetch(
    `/api/webhooks/${encodeURIComponent(endpointId)}/deliveries/${encodeURIComponent(deliveryId)}/retry`,
    { method: "POST" },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `retry ${res.status}`);
  }
}

/**
 * Webhooks management section. Three views on one panel via local
 * state:
 *   - "list"     — default: endpoints table + "+ Add endpoint"
 *   - "create"   — inline form, on success reveals secret ONCE
 *   - "drill"    — selected endpoint's recent deliveries + retry
 *
 * Kept on the main /dashboard page rather than a separate route to
 * match the existing single-page layout (KeysList, InvoiceDownload).
 * If the surface grows past 3 sub-views, split into /dashboard/webhooks.
 */
export function WebhooksSection(): React.JSX.Element {
  const qc = useQueryClient();
  const [view, setView] = useState<"list" | "create" | "drill">("list");
  const [drillEndpointId, setDrillEndpointId] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedEndpoint | null>(null);

  const { data: endpoints, isLoading, isError } = useQuery({
    queryKey: ["webhook-endpoints"],
    queryFn: fetchEndpoints,
    refetchOnWindowFocus: true,
  });

  return (
    <div className="rounded-lg border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Webhooks
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Push settle.succeeded / settle.failed events to your own URLs,
            signed with HMAC-SHA256.
          </p>
        </div>
        {view === "list" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setView("create");
              setCreated(null);
            }}
          >
            + Add endpoint
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setView("list");
              setDrillEndpointId(null);
              setCreated(null);
            }}
          >
            Close
          </Button>
        )}
      </header>

      <div className="p-6">
        {created ? (
          <SecretReveal endpoint={created} onDismiss={() => setCreated(null)} />
        ) : view === "create" ? (
          <CreateEndpointForm
            onCreated={async (e) => {
              setCreated(e);
              await qc.invalidateQueries({ queryKey: ["webhook-endpoints"] });
              setView("list");
            }}
          />
        ) : view === "drill" && drillEndpointId !== null ? (
          <DeliveriesPanel endpointId={drillEndpointId} />
        ) : (
          <EndpointsTable
            endpoints={endpoints ?? []}
            isLoading={isLoading}
            isError={isError}
            onDrill={(id) => {
              setDrillEndpointId(id);
              setView("drill");
            }}
            onDelete={async (id, label) => {
              if (
                !window.confirm(
                  `Delete endpoint "${label}"? Past delivery history is dropped too. This cannot be undone.`,
                )
              ) {
                return;
              }
              await deleteEndpoint(id);
              await qc.invalidateQueries({ queryKey: ["webhook-endpoints"] });
            }}
          />
        )}
      </div>
    </div>
  );
}

function EndpointsTable({
  endpoints,
  isLoading,
  isError,
  onDrill,
  onDelete,
}: {
  endpoints: ReadonlyArray<WebhookEndpoint>;
  isLoading: boolean;
  isError: boolean;
  onDrill: (id: string) => void;
  onDelete: (id: string, label: string) => Promise<void>;
}): React.JSX.Element {
  if (isLoading) {
    return (
      <div className="space-y-2">
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  if (isError) {
    return (
      <p className="text-sm text-muted-foreground">
        Couldn’t load endpoints — try refreshing.
      </p>
    );
  }
  if (endpoints.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No webhook endpoints yet. Click <em>+ Add endpoint</em> to register one.
      </p>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs uppercase tracking-wider text-muted-foreground">
          <th className="py-2 text-left font-medium">URL</th>
          <th className="py-2 text-left font-medium">Events</th>
          <th className="py-2 text-left font-medium">Last used</th>
          <th className="py-2 text-right font-medium">Actions</th>
        </tr>
      </thead>
      <tbody>
        {endpoints.map((e) => (
          <tr
            key={e.id}
            className="border-t border-border/50 transition-colors hover:bg-secondary/40"
          >
            <td className="py-3">
              <div className="font-mono text-xs text-foreground">{e.url}</div>
              {e.description.length > 0 ? (
                <div className="text-xs text-muted-foreground">{e.description}</div>
              ) : null}
            </td>
            <td className="py-3 text-xs text-muted-foreground">
              {e.events.join(", ")}
            </td>
            <td className="py-3 text-xs text-muted-foreground">
              {e.lastUsedAt
                ? formatRelativeTime(new Date(e.lastUsedAt))
                : "never"}
            </td>
            <td className="py-3 text-right">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onDrill(e.id)}
              >
                View deliveries
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="ml-2"
                onClick={() => void onDelete(e.id, e.description || e.url)}
              >
                Delete
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CreateEndpointForm({
  onCreated,
}: {
  onCreated: (endpoint: CreatedEndpoint) => void | Promise<void>;
}): React.JSX.Element {
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<Set<WebhookEventType>>(
    new Set(KNOWN_EVENTS),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (url.trim().length === 0) {
      setError("URL is required.");
      return;
    }
    if (events.size === 0) {
      setError("Subscribe to at least one event.");
      return;
    }
    setSubmitting(true);
    try {
      const created = await createEndpoint({
        url: url.trim(),
        description: description.trim(),
        events: Array.from(events),
      });
      await onCreated(created);
      setUrl("");
      setDescription("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div>
        <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          URL
        </label>
        <Input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://your-app.example.com/webhooks/suverse"
          required
          disabled={submitting}
        />
      </div>
      <div>
        <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Description (optional)
        </label>
        <Input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="production-worker"
          maxLength={200}
          disabled={submitting}
        />
      </div>
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Events
        </p>
        <div className="flex flex-wrap gap-3">
          {KNOWN_EVENTS.map((ev) => (
            <label
              key={ev}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-border bg-secondary/40 px-3 py-1.5 text-sm"
            >
              <input
                type="checkbox"
                checked={events.has(ev)}
                onChange={(e) => {
                  const next = new Set(events);
                  if (e.target.checked) next.add(ev);
                  else next.delete(ev);
                  setEvents(next);
                }}
                disabled={submitting}
              />
              <span className="font-mono text-xs">{ev}</span>
            </label>
          ))}
        </div>
      </div>
      <Button type="submit" variant="accent" disabled={submitting}>
        {submitting ? "Creating…" : "Create endpoint"}
      </Button>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </form>
  );
}

function SecretReveal({
  endpoint,
  onDismiss,
}: {
  endpoint: CreatedEndpoint;
  onDismiss: () => void;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(endpoint.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — input remains selectable */
    }
  }
  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-md border border-amber-400/40 bg-amber-400/5 p-4">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-amber-400">
          Save this signing secret now
        </p>
        <p className="mt-2 text-sm">
          <span className="font-medium text-foreground">
            You cannot see this secret again.
          </span>{" "}
          Paste it into your receiver&rsquo;s env (verify webhooks with
          HMAC-SHA256 — see <code className="font-mono">WEBHOOKS.md</code>).
        </p>
      </div>
      <div className="rounded-md border border-border bg-secondary/40 p-4">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {endpoint.url}
        </p>
        <div className="mt-2 flex items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded bg-background px-3 py-2 font-mono text-sm">
            {endpoint.secret}
          </code>
          <Button
            type="button"
            size="sm"
            variant={copied ? "accent" : "outline"}
            onClick={() => void copy()}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>
      <Button type="button" onClick={onDismiss}>
        I&rsquo;ve saved it
      </Button>
    </div>
  );
}

function DeliveriesPanel({ endpointId }: { endpointId: string }): React.JSX.Element {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["webhook-deliveries", endpointId],
    queryFn: () => fetchDeliveries(endpointId),
    refetchInterval: 10_000,
  });
  const [retrying, setRetrying] = useState<string | null>(null);

  async function onRetry(deliveryId: string): Promise<void> {
    setRetrying(deliveryId);
    try {
      await retryDelivery(endpointId, deliveryId);
      await qc.invalidateQueries({ queryKey: ["webhook-deliveries", endpointId] });
    } finally {
      setRetrying(null);
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }
  if (isError) {
    return (
      <p className="text-sm text-muted-foreground">Couldn’t load deliveries.</p>
    );
  }
  if (!data || data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No deliveries yet. They appear here as soon as a settle event matches
        this endpoint.
      </p>
    );
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs uppercase tracking-wider text-muted-foreground">
          <th className="py-2 text-left font-medium">When</th>
          <th className="py-2 text-left font-medium">Event</th>
          <th className="py-2 text-left font-medium">Status</th>
          <th className="py-2 text-left font-medium">Attempts</th>
          <th className="py-2 text-left font-medium">Last result</th>
          <th className="py-2 text-right font-medium">Actions</th>
        </tr>
      </thead>
      <tbody>
        {data.map((d) => (
          <tr key={d.id} className="border-t border-border/50">
            <td className="py-3 text-muted-foreground">
              {formatRelativeTime(new Date(d.createdAt))}
            </td>
            <td className="py-3 font-mono text-xs">{d.eventType}</td>
            <td className="py-3">
              <DeliveryStatusBadge status={d.status} />
            </td>
            <td className="py-3 font-mono text-xs">
              {d.attempts} / {d.maxAttempts}
            </td>
            <td className="py-3 font-mono text-xs text-muted-foreground">
              {d.lastResponseCode !== null
                ? `HTTP ${d.lastResponseCode}${d.lastError ? ` (${d.lastError})` : ""}`
                : d.lastError ?? "—"}
            </td>
            <td className="py-3 text-right">
              {d.status === "failed" || d.status === "dead" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={retrying === d.id}
                  onClick={() => void onRetry(d.id)}
                >
                  {retrying === d.id ? "Retrying…" : "Retry"}
                </Button>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DeliveryStatusBadge({
  status,
}: {
  status: "pending" | "success" | "failed" | "dead";
}): React.JSX.Element {
  const map = {
    pending: "bg-amber-500/15 text-amber-300",
    success: "bg-emerald-500/15 text-emerald-300",
    failed: "bg-destructive/15 text-destructive",
    dead: "bg-secondary text-muted-foreground",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex rounded-md px-2 py-0.5 text-xs font-medium uppercase tracking-wider",
        map[status],
      )}
    >
      {status}
    </span>
  );
}
