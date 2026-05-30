# External catalog submissions

How to get Suverse Pay endpoints listed across the wider x402 / MCP
ecosystem. Each row tells you the submission surface, whether it's
automatable, and the one-time prep we need on our side.

## Summary

| Catalog | Submission path | Automatable? | Action |
|---|---|---|---|
| **x402.org/ecosystem** | Google Form | ❌ Manual one-shot per service | Fill the form below |
| **CDP Bazaar / x402bazaar.xyz** | Auto-indexed when routing through CDP facilitator | ✅ Per-payment (CDP-eligible chains only) | Set `discoverable: true` on bazaar extension |
| **Smithery** (MCP only) | `smithery mcp publish` CLI | ✅ Once via CLI | One-shot publish for `@suverselabs/x402-mcp` |
| **MCP Market** (cline) | Web form at mcpmarket.com/submit | ❌ Manual one-shot | Submit GitHub repo URL |
| **Official MCP Registry** | registry.modelcontextprotocol.io | TBD | Investigate later |

---

## x402.org/ecosystem

**Submission:** Google Form — <https://docs.google.com/forms/d/e/1FAIpQLSc2rlaeH31rZpJ_RFNL7egxi9fYTEUjW9r2kwkhd2pMae2dog/viewform>

**Automation:** None. The form is the only path; the `x402-foundation/x402` GitHub repo doesn't contain a registry directory (it's the spec + reference implementations).

**What to paste in the form** for Suverse Pay itself (do this once):

```
Project name:        Suverse Pay
URL:                 https://suverse-pay.suverse.io
Category:            Payment gateway / Aggregator
Description:         Unified x402 payment gateway aggregating 7 facilitators
                     (Coinbase CDP, cosmos-pay, PayAI, thirdweb-x402, binance-x402,
                     bofai-x402, t402-io) behind one REST API. Smart routing by
                     cost/latency, normalised responses, public catalog at
                     suverse-pay.suverse.io/catalog with .well-known/x402 manifest
                     for ecosystem discovery.
Networks:            18 EVM mainnets + Solana mainnet + Cosmos Noble + TRON
Facilitator URL:     https://facilitator.suverse.io
Catalog URL:         https://suverse-pay.suverse.io/catalog
Discovery manifest:  https://suverse-pay.suverse.io/.well-known/x402
Contact:             support@suverse.io
```

Per-seller listings probably won't go through this form one by one — we
get listed AS a catalog provider; downstream sellers get discovered via
our `.well-known/x402`.

---

## CDP Bazaar (x402bazaar.xyz)

**Submission:** Automatic. CDP indexes any endpoint that settles a payment through their facilitator with the bazaar extension enabled.

**Automation:** Per-payment, but only for endpoints that route through CDP. Our proxy uses smart routing across multiple facilitators; CDP wins for Base + Solana when the seller hasn't pinned a different chain.

**What to do:** When emitting a 402 challenge from `apps/proxy`, include the bazaar metadata block in the challenge body for CDP-eligible chains:

```ts
extensions: {
  bazaar: {
    discoverable: true,
    title: "<listing title>",
    description: "<listing description>",
    category: "<our catalog category>",
  }
}
```

The cleanest implementation is to read it from `catalog_listings` at proxy-settle time when the route picks CDP. Out of scope for the v1 catalog rollout — file it under "Coinbase Bazaar wiring" backlog.

**Caveat from earlier memory:** our hybrid x402 v1 + top-level extensions.bazaar IS indexed nowhere (0 of 50k). The CDP indexer wants either clean v2 (extensions.bazaar + amount + CAIP-2) or legacy v1 (outputSchema). PayAI supports v2 on Solana+Base. See `reference_cdp_bazaar_v2_requirement.md` for the migration backlog (PRs #20/#21 open+unmerged on the suverse-pay repo).

---

## Smithery (MCP directory)

**Submission:** `smithery mcp publish` CLI.

**Automation:** ✅ One CLI call publishes our `@suverselabs/x402-mcp`.

**Recipe:**

```bash
# Once per machine
smithery auth login

# After every npm publish of @suverselabs/x402-mcp
smithery mcp publish \
  https://www.npmjs.com/package/@suverselabs/x402-mcp \
  -n suverselabs/x402-mcp
```

Smithery also accepts an MCPB bundle. For an npm-published server,
pointing at the npm URL is simplest. The registry pulls the README +
manifest from the npm tarball.

**Backlog:** automate inside the package's `prepublishOnly` step or a
GitHub Actions release workflow.

---

## MCP Market (cline)

**Submission:** Web form at <https://mcpmarket.com/submit>.

**Automation:** None. Form asks for a GitHub repository URL.

**What to paste:**
- GitHub repo: `https://github.com/sudzikcoin/suverse-pay/tree/main/packages/x402-mcp-buyer`
- Description: "Buyer-side MCP for x402 — discover and auto-pay paid APIs across the suverse-pay catalog and ecosystem"
- Categories: payments, discovery, agent

---

## Official MCP Registry

**URL:** <https://registry.modelcontextprotocol.io/>

**Status:** Not yet investigated. Listed in search results as the
canonical MCP registry. Action: read their submission docs and add
results here. File as a small follow-up task.

---

## Recommended next actions

1. **One-time:** Submit Suverse Pay to x402.org via the Google Form above.
2. **One-time:** Submit `@suverselabs/x402-mcp` to MCP Market and Smithery via the CLI.
3. **Backlog:** Wire CDP Bazaar extension into `apps/proxy` 402 challenges for CDP-routed payments (needs the existing v2 migration in PRs #20/#21 to land first).
4. **Backlog:** Investigate the official `registry.modelcontextprotocol.io` registry and add submission notes.

Most external catalogs are deliberately gatekept (form / PR review) to
keep spam down. Our own `/catalog` + `/.well-known/x402` is the primary
discovery surface; external listings are amplification.
