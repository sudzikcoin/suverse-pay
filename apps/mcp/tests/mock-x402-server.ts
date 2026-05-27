import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * Minimal x402 resource server for integration tests. NOT a faithful
 * implementation of the v2 spec — it just emulates the parts the
 * client (pay_and_call) interacts with:
 *
 *   1. Initial GET/POST without payment proof → 402 with PaymentRequired
 *      JSON body containing accepts[]. (Body-form for v1 compatibility;
 *      pay_and_call also supports the v2 PAYMENT-REQUIRED header but
 *      body is simpler to write in a test fixture.)
 *
 *   2. Same call with PAYMENT-SIGNATURE OR X-PAYMENT header present →
 *      200 with a configured success body.
 *
 * It does NOT verify the signature or contact a facilitator — the
 * unit under test is the MCP client flow, not facilitator correctness.
 */
export interface MockX402Config {
  /** Routes that require payment, keyed by request path. */
  routes: Record<string, MockRoute>;
}

export interface MockRoute {
  /** PaymentRequired body sent on the initial unpaid call. */
  paymentRequired: PaymentRequiredBody;
  /** Body returned once the client retries with payment proof. */
  successBody: unknown;
}

export interface PaymentRequiredBody {
  x402Version: number;
  resource?: { url: string; description?: string };
  accepts: ReadonlyArray<Record<string, unknown>>;
}

export interface MockX402Server {
  baseUrl: string;
  callCounts: () => Record<string, { unpaid: number; paid: number }>;
  /** All inbound payment-proof header values, in receipt order. */
  receivedPaymentProofs: () => string[];
  close: () => Promise<void>;
}

export async function startMockX402Server(
  config: MockX402Config,
): Promise<MockX402Server> {
  const counts: Record<string, { unpaid: number; paid: number }> = {};
  const proofs: string[] = [];

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    const path = url.split("?")[0] ?? "/";
    const route = config.routes[path];
    if (!route) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "not_found", path }));
      return;
    }
    if (!counts[path]) counts[path] = { unpaid: 0, paid: 0 };

    const proof =
      (req.headers["payment-signature"] as string | undefined) ??
      (req.headers["x-payment"] as string | undefined);

    // Drain request body to keep node happy.
    req.on("data", () => {});
    req.on("end", () => {
      if (!proof) {
        counts[path]!.unpaid += 1;
        res.statusCode = 402;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(route.paymentRequired));
        return;
      }
      counts[path]!.paid += 1;
      proofs.push(proof);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      // Mirror the spec's PAYMENT-RESPONSE convention so the client
      // sees a base64-encoded SettlementResponse stub for visibility.
      const settlement = {
        success: true,
        transaction: "0xmocktxhash",
        network: extractFirstNetwork(route.paymentRequired),
      };
      res.setHeader(
        "payment-response",
        Buffer.from(JSON.stringify(settlement), "utf8").toString("base64"),
      );
      res.end(JSON.stringify(route.successBody));
    });
  };

  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("mock server did not produce a port-typed address");
  }
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    callCounts: () => structuredClone(counts),
    receivedPaymentProofs: () => [...proofs],
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function extractFirstNetwork(pr: PaymentRequiredBody): string {
  const first = pr.accepts[0];
  if (first && typeof first.network === "string") return first.network;
  return "unknown";
}
