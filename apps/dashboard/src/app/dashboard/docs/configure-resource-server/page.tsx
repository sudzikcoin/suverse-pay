import Link from "next/link";
import { redirect } from "next/navigation";
import { DashboardHeader } from "@/components/layout/dashboard-header";
import { auth } from "@/lib/auth";

/**
 * Static documentation for the seller-onboarding flow. Authenticated
 * because we link to /dashboard from the steps and that path is
 * gated; an unauth visitor would just bounce through /login anyway.
 *
 * Kept inline (no markdown loader) — the content is small enough
 * that the cost of an MDX/remark dependency isn't worth it.
 */
export default async function DocsConfigurePage(): Promise<React.JSX.Element> {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }

  return (
    <main className="min-h-screen">
      <DashboardHeader
        breadcrumb={[
          { label: "Dashboard", href: "/dashboard" },
          { label: "Docs" },
          { label: "Configure resource server" },
        ]}
      />

      <article className="container max-w-3xl space-y-10 py-12">
        <header>
          <div className="text-[11px] uppercase tracking-[0.2em] text-amber-400">
            5-minute setup
          </div>
          <h1 className="mt-2 text-3xl font-semibold">
            Turn any HTTP endpoint into a paid x402 endpoint
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            You'll create a resource API key, configure where to receive
            USDC, copy a snippet into your server, and probe it to
            confirm everything's wired up. End-to-end ~5 minutes.
          </p>
        </header>

        <Step n={1} title="Create a resource API key">
          <p>
            Open the{" "}
            <Link href="/dashboard" className="text-amber-400 hover:underline">
              dashboard
            </Link>
            , click <em>New API key</em>, give it a label like
            <code className="mx-1 rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">
              prod-parser
            </code>
            and copy the <code>sup_live_…</code> plaintext when it
            appears. You'll see it exactly once — paste it into your
            <code className="mx-1 rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">
              .env
            </code>
            as <code>SUVERSE_PAY_API_KEY=…</code>.
          </p>
        </Step>

        <Step n={2} title="Configure your resource server">
          <p>
            From the dashboard, find your key and click <em>Configure</em>.
            That opens
            <code className="mx-1 rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">
              /dashboard/keys/&lt;id&gt;/configure
            </code>
            where you pick accepted networks (Base (Coinbase L2) is
            recommended for first integrations), paste your USDC receive
            addresses, set
            a default price ($0.07 is a sensible starting point), and
            optionally describe what your endpoint does.
          </p>
          <p>
            Click <strong>Save configuration</strong>. The "Configured ✓"
            badge appears, and sections 06 + 07 unlock.
          </p>
        </Step>

        <Step n={3} title="Drop the snippet into your code">
          <p>
            Open section 06, pick your framework (Express, Fastify, or
            FastAPI), and copy the generated snippet. Install the
            listed dependencies (
            <code className="mx-1 rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">
              npm i @suverselabs/x402-server
            </code>
            for Node, or the inline implementation for Python). Set the
            env var.
          </p>
          <p>
            Replace the placeholder handler at the bottom with your
            real route. The middleware populates
            <code className="mx-1 rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">
              req.x402Payment
            </code>
            (Express) or
            <code className="mx-1 rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">
              request.x402Payment
            </code>
            (Fastify) with the verified payment receipt:
            <em> payer, network, asset, amount, txHash, raw</em>.
          </p>
        </Step>

        <Step n={4} title="Run the probe">
          <p>
            Boot your server, expose it on a real URL (production or
            ngrok), and paste that URL into section 07. <em>Run probe</em>
            does an unauthenticated GET, checks the status code is 402,
            that the body is JSON, that the
            <code className="mx-1 rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">
              accepts
            </code>
            array is well-shaped, and that at least one entry references
            a network you've configured.
          </p>
          <p>
            Each check renders as a row with a green or red dot. Red
            dots come with a one-line detail you can act on.
          </p>
        </Step>

        <Step n={5} title="Watch settles arrive">
          <p>
            Once a client signs an x402 payment against your endpoint,
            the suverse-pay facilitator settles it on-chain through one
            of the supported networks. The settle shows up in the
            dashboard's <em>Settles</em> panel within seconds, with the
            gross / fee / net split.
          </p>
          <p>
            If you set up an outbound webhook, the
            <code className="mx-1 rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">
              settle.succeeded
            </code>
            event hits your URL with the full receipt — handy for
            internal pipelines, ledger sync, or Slack notifications.
          </p>
        </Step>

        <section className="rounded-lg border border-border bg-card p-6">
          <h2 className="text-lg font-semibold">FAQ</h2>
          <dl className="mt-4 space-y-4 text-sm">
            <FaqItem
              q="What happens if the facilitator is down?"
              a="The middleware throws on the verify call and returns 502 with a fresh 402 challenge — well-behaved clients retry. We run hot/cold backups across CDP, PayAI, and Thirdweb depending on the network; full outage is unlikely."
            />
            <FaqItem
              q="Do I have to use @suverselabs/x402-server?"
              a="No. Any HTTP server that returns a well-formed 402 with the spec's challenge body works. The package is convenience; the wire format is the contract."
            />
            <FaqItem
              q="My probe says 'networks_match_config: false' — why?"
              a="The 402 challenge your server returns advertises one set of networks; your dashboard config has another. Most likely you forgot to redeploy after editing config. Hit refresh on /dashboard/keys/.../configure to see the canonical list, then update your code."
            />
            <FaqItem
              q="I can't see my plaintext API key — can I recover it?"
              a="No. We only store the SHA-256 hash. Revoke the lost key and create a new one — your existing settles keep working even after revocation, only new requests are rejected."
            />
            <FaqItem
              q="Can I set per-endpoint prices?"
              a="Not yet — v1 of the configure UI ships a single default price per key. Per-endpoint pricing is in scope for the next sub-task. Workaround for now: one resource API key per endpoint."
            />
          </dl>
        </section>

        <footer className="text-xs text-muted-foreground">
          Questions? File an issue at{" "}
          <Link
            href="https://github.com/sudzikcoin/suverse-pay/issues"
            className="text-amber-400 hover:underline"
          >
            github.com/sudzikcoin/suverse-pay
          </Link>
          .
        </footer>
      </article>
    </main>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="rounded-lg border border-border bg-card p-6">
      <header className="mb-4 flex items-baseline gap-4">
        <span className="font-mono text-xs text-amber-400">0{n}</span>
        <h2 className="text-xl font-semibold">{title}</h2>
      </header>
      <div className="space-y-3 text-sm leading-relaxed text-muted-foreground [&_strong]:text-foreground [&_em]:text-foreground/80">
        {children}
      </div>
    </section>
  );
}

function FaqItem({
  q,
  a,
}: {
  q: string;
  a: string;
}): React.JSX.Element {
  return (
    <div>
      <dt className="font-medium">{q}</dt>
      <dd className="mt-1 text-muted-foreground">{a}</dd>
    </div>
  );
}
