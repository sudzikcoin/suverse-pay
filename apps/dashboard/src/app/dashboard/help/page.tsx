import Link from "next/link";
import { redirect } from "next/navigation";
import { DashboardHeader } from "@/components/layout/dashboard-header";
import { auth } from "@/lib/auth";

/**
 * In-app Help page. Single static file — no MDX, no client logic.
 *
 * Three sections in scroll order:
 *   1. Quick start  — three links to the most-asked-about pages
 *   2. Glossary     — definitions for x402, facilitator, settle, etc
 *   3. FAQ          — common questions sellers hit in the first week
 *
 * Contact info at the bottom. Auth-required so we can link freely
 * into other /dashboard/* pages.
 */
export default async function HelpPage(): Promise<React.JSX.Element> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  return (
    <main className="min-h-screen">
      <DashboardHeader
        breadcrumb={[
          { label: "Dashboard", href: "/dashboard" },
          { label: "Help" },
        ]}
      />

      <article className="container max-w-3xl space-y-12 py-12">
        <header>
          <div className="text-[11px] uppercase tracking-[0.2em] text-amber-400">
            Help · v0.4
          </div>
          <h1 className="mt-2 text-3xl font-semibold">
            How suverse-pay works, in 5 minutes
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Glossary, FAQ, and pointers. If you can't find what you
            need, email us — link at the bottom.
          </p>
        </header>

        <section>
          <h2 className="text-lg font-semibold">Quick start</h2>
          <ul className="mt-3 space-y-2 text-sm">
            <li>
              <Link
                href="/dashboard/docs/configure-resource-server"
                className="text-amber-400 underline-offset-4 hover:underline"
              >
                5-minute setup guide →
              </Link>
              <span className="ml-2 text-muted-foreground">
                Create a key, configure receive addresses, install the
                snippet, probe it.
              </span>
            </li>
            <li>
              <Link
                href="/dashboard/proxies/new"
                className="text-amber-400 underline-offset-4 hover:underline"
              >
                Create your first proxy →
              </Link>
              <span className="ml-2 text-muted-foreground">
                Wrap an existing HTTPS API behind a paid URL — no
                server-side code required.
              </span>
            </li>
            <li>
              <Link
                href="/catalog"
                className="text-amber-400 underline-offset-4 hover:underline"
              >
                Browse the public catalog →
              </Link>
              <span className="ml-2 text-muted-foreground">
                See what other sellers have published. Yours can go
                here too via /dashboard/catalog/new.
              </span>
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold">Glossary</h2>
          <dl className="mt-4 space-y-4">
            {GLOSSARY.map((entry) => (
              <div key={entry.term}>
                <dt className="font-medium text-foreground">{entry.term}</dt>
                <dd className="mt-1 text-sm text-muted-foreground">
                  {entry.def}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section>
          <h2 className="text-lg font-semibold">FAQ</h2>
          <div className="mt-4 space-y-5">
            {FAQ.map((item) => (
              <details
                key={item.q}
                className="rounded-md border border-border bg-card/40 p-4"
              >
                <summary className="cursor-pointer text-sm font-medium text-foreground">
                  {item.q}
                </summary>
                <div className="mt-3 space-y-2 text-sm leading-relaxed text-muted-foreground">
                  {item.a}
                </div>
              </details>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-border bg-card/40 p-5">
          <h2 className="text-lg font-semibold">Still stuck?</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Email{" "}
            <a
              href="mailto:support@suverse.io"
              className="text-amber-400 underline-offset-4 hover:underline"
            >
              support@suverse.io
            </a>{" "}
            with the URL of the page you were on and what you were
            trying to do — we usually reply within a business day.
          </p>
        </section>
      </article>
    </main>
  );
}

const GLOSSARY: ReadonlyArray<{ term: string; def: React.ReactNode }> = [
  {
    term: "x402",
    def: (
      <>
        Open HTTP-level payment protocol: when a buyer hits a paid
        endpoint, the server returns a <code>402 Payment Required</code>{" "}
        challenge describing what to pay and on which chain. The buyer
        signs an on-chain transfer, retries with a{" "}
        <code>PAYMENT-SIGNATURE</code> header, and gets the response.
      </>
    ),
  },
  {
    term: "Facilitator",
    def: (
      <>
        A service that verifies and broadcasts the buyer's payment on a
        specific chain. suverse-pay aggregates multiple facilitators
        (Coinbase CDP for Base/Solana, cosmos-pay for Noble, etc.) so
        sellers see a uniform interface and buyers can choose any
        supported chain.
      </>
    ),
  },
  {
    term: "Settle",
    def: (
      <>
        A successfully broadcast payment — the funds are en route to
        your wallet and the tx hash is known. "Settled" is the terminal
        success state; the response is forwarded to the buyer at the
        same moment.
      </>
    ),
  },
  {
    term: "Resource API key",
    def: (
      <>
        Identifies which seller a settled payment belongs to. Format:{" "}
        <code>sup_live_&lt;32 alnum&gt;</code>. Shown ONCE in plaintext
        at creation — we only store the SHA-256 hash. Used by your
        server snippet to authenticate calls to the suverse-pay
        gateway.
      </>
    ),
  },
  {
    term: "Proxy",
    def: (
      <>
        A wrapper around your upstream HTTPS endpoint. Buyers hit the
        proxy URL (<code>proxy.suverse.io/v1/proxy/&lt;key&gt;/&lt;slug&gt;</code>);
        we return a 402, accept payment, then forward the request to
        your upstream with the headers you configured. Zero code in
        your upstream service.
      </>
    ),
  },
  {
    term: "PayTo address",
    def: (
      <>
        The wallet address that receives the USDC payment for a given
        network. One per network family (EVM, Solana, Cosmos, TRON).
        We are non-custodial — buyer signs straight to this address.
      </>
    ),
  },
  {
    term: "CAIP-2",
    def: (
      <>
        A standard for naming chains. <code>eip155:8453</code> is Base
        mainnet; <code>solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc6wjsTLnYjz</code>{" "}
        is Solana mainnet; <code>cosmos:noble-1</code> is Noble. You'll
        see CAIP-2 strings in the proxy form and in settle rows.
      </>
    ),
  },
];

const FAQ: ReadonlyArray<{ q: string; a: React.ReactNode }> = [
  {
    q: "When do I get paid?",
    a: (
      <p>
        The moment a buyer's payment settles on-chain — usually within
        a few seconds. The USDC lands directly in your configured
        receive wallet; we never touch your funds.
      </p>
    ),
  },
  {
    q: "What does suverse-pay charge me?",
    a: (
      <p>
        A small per-settle platform fee, currently 30 basis points
        (0.3%) with a $1 USDC cap per call. Tracked in the{" "}
        <code>fee_amount</code> column you'll see on your settles, and
        downloadable as a CSV via the Invoice export panel.
      </p>
    ),
  },
  {
    q: "Can I change a proxy's price after creation?",
    a: (
      <p>
        Yes — open the proxy detail page and click Edit. New prices
        apply to all future 402 challenges. In-flight payments are
        unaffected.
      </p>
    ),
  },
  {
    q: "What happens if my upstream returns a 5xx?",
    a: (
      <p>
        We forward the upstream status code to the buyer and log the
        outcome as <code>upstream_error</code>. The buyer still gets
        their failure response, but you don't get paid for that call
        — we don't settle if the upstream didn't deliver.
      </p>
    ),
  },
  {
    q: "Why do I need a receive wallet per chain?",
    a: (
      <p>
        EVM, Solana, Cosmos, and TRON have incompatible address
        formats — a Base address can't receive a Solana transfer. If
        you accept payments on a chain, we need an address on that
        chain so the buyer's signature can be addressed correctly.
      </p>
    ),
  },
  {
    q: "Is my upstream auth token safe?",
    a: (
      <p>
        Yes. Forwarded headers are encrypted at rest with AES-GCM,
        keyed by an environment-scoped <code>PROXY_HEADER_KEY</code>{" "}
        we never log. The dashboard cannot read them back after save —
        re-paste if you need to rotate.
      </p>
    ),
  },
];
