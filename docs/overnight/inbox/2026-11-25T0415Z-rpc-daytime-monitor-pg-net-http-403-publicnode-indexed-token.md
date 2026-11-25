# Daytime monitor candidate — 2026-11-25 ~04:15Z (rpc-daytime-monitor, read-only pass)

**Title:** `pg_net_http_403` pipeline-alert arm reads **CRITICAL** on 4 Solana-RPC `403`s to `solana-rpc.publicnode.com` (`-32602 "Indexed requests require a personal token"`); the arm's own body resolves it to **self-inflicted / not an outage**, and candy data is fresh — so this is a *clear-the-arm* candidate, not a breakage.

**Priority:** LOW (no user-facing or data impact; sensing only).

**Source:** `rpc_ops_snapshot()` → `pipeline_alerts`, pipeline `pg_net_http_403`, observed 2026-11-25T04:05:22Z. Endpoint per `public.pg_net_request_log` (#241): `POST solana-rpc.publicnode.com/`. Body: `{"jsonrpc":"2.0","error":{"code":-32602,"message":"Indexed requests require a personal token. Get one at: https://www.allnodes.com/publicnode"},"id":1}`. Not present in `docs/overnight/ledger.md` or `docs/reference/known-issues.md`; the 2026-11-24 09:14Z overnight metrics reported "0 HIGH/CRITICAL", so this surfaced since.

**What it is (observed, not concluded):**
- 4 `pg_net`-dispatched calls returned HTTP 403 in a 2 h window to publicnode's Solana RPC, with an *indexed-method-requires-a-token* error (not a Cloudflare challenge, not an outage). publicnode gates indexed methods (`getSignaturesForAddress` / asset-indexed reads) behind a paid token.
- The only Solana lanes are the candy chain lanes (`candy-collections-census` / `candy-opensea-chain-listings` / `candy-sales-buyer-paid`), which per the ledger (11-22/11-23) already **fall through** keyless RPCs and treat publicnode nulls/limits harmlessly (publicnode holds ~1.5 d history; mainnet-beta/archive cover older ranges).
- Candy health is green this pass: `candy_sales_stale_hours` 0.8 (breach 168), `candy_ask_book_drop_pct` 3.4 (breach 60), `candy_offers_unverified_pct` 0, all `ok`. So no catalog/sale freshness cost.
- The arm is labelled CRITICAL only because these 403s are **not attributed to a recorded `request_id`** — the same "unattributed 403 cluster" default severity. Its own body states the self-inflicted reading clears when the probe records its request id.

**Risk read:** Low. No code/data change observed to have caused it; no downstream metric moved. The only real risk is a *masking* one — a genuinely-CRITICAL `pg_net_http_403` later would be harder to spot while this benign one sits CRITICAL.

**Suggested action (night pass / owner — do NOT treat as a conclusion):**
1. Confirm which candy lane dispatches the indexed publicnode call (join `pg_net_request_log` / the candy request-ledger on the failing `request_id`s), and that candy freshness is unaffected (it is, this pass).
2. Either (a) have that lane **record its dispatch request_id** so the arm attributes + clears (the arm's own stated fix), or (b) stop sending indexed methods to publicnode (route indexed reads to a keyed/archive RPC that serves them), or (c) if the lane already handles it harmlessly, add a narrow suppression so the CRITICAL default doesn't mask real ones.
3. Sensing only — the monitor does not fix this.
