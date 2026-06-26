# Panini Blockchain — build-out + go-live handoff

Date 2026-06-25. Status: **SCAFFOLDING / nothing live.** Per Trevor: build everything up, push nothing to the
site until fully built out and established. So this is repo-only — no migrations applied, no routes deployed,
no cron wired, no `is_active` flip. Everything here is ready to execute on his go.

Companion files:
- Research + sourcing: [docs/research/panini-prizm-wc2026-data-sourcing-2026-06-25.md](research/panini-prizm-wc2026-data-sourcing-2026-06-25.md)
- Product spec / seed reference: [docs/drafts/panini/panini-wc2026-product-spec.md](drafts/panini/panini-wc2026-product-spec.md)
- Drafted table DDL (un-applied): [docs/drafts/panini/panini-schema.sql](drafts/panini/panini-schema.sql)
- Drafted read surfaces (un-applied): [docs/drafts/panini/panini-read-rpcs.sql](drafts/panini/panini-read-rpcs.sql)
- Rollup + FMV methodology: [docs/drafts/panini/panini-methodology.md](drafts/panini/panini-methodology.md)
- `panini-proxy` worker (un-deployed): [docs/drafts/panini/panini-proxy/](drafts/panini/panini-proxy/)

Status of the ingest code (updated 2026-06-25 PM): the 5 inert route/lib files are **committed to `main`** (Trevor),
not just drafted — `lib/chains/panini/{feed,normalize}.ts` + `app/api/ingest/panini-editions/route.ts` +
`app/api/cron/panini-{circulation-refresh,fmv-recalc}/route.ts`. Independently re-reviewed this session: inert
guards present (every route logs a clean no-op while `PANINI_FEED_MODE` is unset), no secrets committed, correct
`collection_id` (`d1a0a7f5…`), `still_in_packs` left to the generated column, in-batch dedup before upsert, own
auth surfaces flagged. `log_pipeline_run`'s live signature was verified to match the routes' call (no silent-log
gap). They are on `main` but not yet in a built production deploy (the tip commit was docs-only → Vercel's
docs-only ignore CANCELED the build); they deploy as no-ops on the next code-bearing push.

Guardrail: strategy rule is one chain at a time, chain two = Candy/Solana. Panini is a *later* sequenced IP
expansion. This package de-risks it so it's a fast, low-risk start when its turn comes — it is **not** a green
light to begin a parallel build now.

---

## 1. Verified findings that drive the design (2026-06-25)

- **Product:** Panini Blockchain "2026 Panini Prizm FIFA World Cup" (digital). FOTL 13,960×$150 (Jun 19), Hobby
  50,480×$25 (Jun 24). Full parallel/insert/cap ladder in the product spec.
- **Plane A — Panini marketplace API:** single hardened gateway **`POST nft.paniniamerica.net/onepanini`**
  (GraphQL-style). Bot-protected: Signifyd device checks + reCAPTCHA on the store; naive calls return
  **HTTP 426 "Invalid request"** (requires the app's exact headers/handshake, likely an encoded body).
  Direct integration is possible but fragile + ToS-risky → must replicate the app request format behind a proxy.
- **Plane A — CryptoSlam (cleaner):** already indexes Panini Blockchain **live, per-card, with serials**
  (`web-api.cryptoslam.io/v1/mints/Panini America/{nav,search}`, .NET + Mongo DataTables; ~11h lag). Sells a
  commercial **NFT API** (`cryptoslam.io/products/api`).

  > **FINDING (2026-06-25, verified in-browser) — CryptoSlam does NOT currently index the WC2026 Prizm set.** Its
  > "Panini America" catalog (3,348 sets) contains **zero** WC-unique markers: no Aguila / Maple Leaf / Old Glory
  > host-nation parallels, no "World Cup" set, and **zero sets whose name contains "2026."** The 2026 Panini
  > *soccer* it indexes live is a *different* product — the "Base Field Level / Mezzanine" line (Gold Wave / Peacock
  > / Honeycomb parallels), not the Prizm World Cup ladder. **Consequence: `/onepanini` (via panini-proxy) is the
  > PRIMARY Plane-A source for the WC2026 Prizm product; CryptoSlam is NOT usable for it unless/until it adds the
  > set.** Caveat: CryptoSlam's nav facets lag (they list no "2026" season despite live 2026 mints), so treat this
  > as strong evidence, not absolute proof — re-check at G1, and check whether the set lands under a *separate*
  > CryptoSlam collection rather than "Panini America."
- **Plane B — Ethereum/OpenSea bridge:** opened Mar 30 2026, **OpenSea-exclusive**, Ethereum mainnet, cards
  escrow-locked on bridge. **Digital cards only — packs cannot bridge.** At launch only Toikido Bad Eggs Prizm
  was bridgeable; "additional collections unlocked as available" → **WC2026 is almost certainly NOT bridged
  yet.** So Plane B is not a near-term source for this product; the contract-address lookup is deferred.
- **RPC schema (read-only checks):** `panini_blockchain` row exists inert (`d1a0a7f5…`, chain=ethereum,
  contract NULL). The generic EVM indexer exists and is reusable for Plane B later (`evm_chains` has Flow EVM 747
  + Base 8453; `evm_nft_contracts` = Beezie on Base; Ethereum mainnet chain_id 1 not yet registered).

**Design consequence:** for the WC2026 product, **Plane A is the only real source.** Pack-state / "still in packs"
can *never* come from chain (packs don't bridge) — it must come from per-edition circulation in the feed. Plane B
is a later add for on-chain provenance/secondary sales of bridged cards.

---

## 2. Architecture (mirrors RPC's existing collection ingests)

```
                 ┌─────────────────────────── Plane A (primary, required) ───────────────────────────┐
 CryptoSlam NFT API ──┐                                                                               │
 (or /onepanini       ├─► lib/chains/panini/feed.ts ─► normalize ─► panini_editions (catalog + caps)  │
  via proxy, fallback)┘                                  │         ─► pulled_count (circulation)       │
                                                          │         ─► panini_pack_state (residual)    │
                                                          └─► panini_fmv_snapshots (algo 'panini-1.0.0')│
                 └────────────────────────────────────────────────────────────────────────────────────┘
                 ┌──────────── Plane B (later; bridged subset only, no packs) ────────────┐
 Ethereum mainnet (OpenSea) ─► existing evm_* indexer ─► bridge (contract,token_id) ─► sales/provenance
                 └────────────────────────────────────────────────────────────────────────┘
```

Surfaces (reuse Top Shot machinery 1:1): pack-EV / pack-reality, **squeeze board (still-in-packs → effective
supply)**, FMV per parallel + serial-aware, special serials/trophies (#1, perfect, 1/1 Black & Nebula),
player/parallel/set entity pages + checklists.

---

## 3. Inert ingest scaffolding (Candy-pattern)

**Canonical code now = the committed files** listed in the status note above (re-reviewed + verified this session).
Same discipline as the 2026-06-08 Candy onboarding: write **only** for `collection_id d1a0a7f5…`, **short-circuit**
until the feed is configured + discovery TODOs filled, **no cron / no watchlist**, so it ships dead until flipped.
The remaining inert pieces are now drafted too: the `panini-proxy` worker
([drafts/panini/panini-proxy/](drafts/panini/panini-proxy/)), the read surfaces
([drafts/panini/panini-read-rpcs.sql](drafts/panini/panini-read-rpcs.sql)), and the rollup + FMV methodology that
fills the two route TODOs ([drafts/panini/panini-methodology.md](drafts/panini/panini-methodology.md)).
The code blocks below are the original illustrative stubs — superseded by the committed versions, kept for context.

### lib/chains/panini/feed.ts — Plane A client (inert until configured)
```ts
// Panini Blockchain Plane-A feed. INERT until PANINI_FEED_MODE + creds are set.
// mode 'cryptoslam' => CryptoSlam commercial NFT API (recommended primary)
// mode 'onepanini'  => nft.paniniamerica.net/onepanini via a proxy worker (fallback; replicate app headers)
export type PaniniRawEdition = {
  id: string; player: string; nation?: string; set: string; parallel: string;
  rarity?: string; mintCap: number; circulation: number; // pulled-out-of-packs count
  isFotlExclusive?: boolean; serial?: number; thumbnailUrl?: string; floorAskUsd?: number;
};

const MODE = process.env.PANINI_FEED_MODE ?? "";          // "" => inert
export function paniniFeedEnabled() { return MODE === "cryptoslam" || MODE === "onepanini"; }

export async function fetchPaniniEditions(): Promise<PaniniRawEdition[]> {
  if (!paniniFeedEnabled()) return [];                    // INERT
  if (MODE === "cryptoslam") {
    // TODO(discovery): CryptoSlam NFT API — auth header + Panini WC2026 collection/set params + paging.
    // GET/POST per their API contract; map mints + unminted to PaniniRawEdition.
    return [];
  }
  // MODE === "onepanini": POST through PANINI_PROXY_URL (never call nft.paniniamerica.net from Vercel egress).
  // TODO(discovery): captured /onepanini request format (headers + body) from a logged-in session.
  return [];
}
```

### lib/chains/panini/normalize.ts — feed row → panini_editions
```ts
import type { PaniniRawEdition } from "./feed";
const PANINI = "d1a0a7f5-609a-49f4-a1a7-4eaac55b020b";
const TIER: Record<string, string> = { // rarity label -> tier_type
  "Uncommon":"COMMON","Rare":"RARE","Ultra Rare":"RARE","Epic":"LEGENDARY","Legendary":"ULTIMATE",
};
const FAMILY = (set: string, parallel: string, fotl?: boolean) =>
  fotl ? "fotl_exclusive"
  : set.toLowerCase().startsWith("base") ? "base"
  : /silver|gold|black/i.test(parallel) ? "tiered_insert" : "non_tiered_insert";

export function toEditionRow(r: PaniniRawEdition) {
  return {
    id: r.id,
    external_id: `${r.set}:${r.player}:${r.parallel}`.replace(/\s+/g, "_"),
    collection_id: PANINI,
    player_name: r.player, nation: r.nation ?? null, set_name: r.set, parallel: r.parallel,
    parallel_family: FAMILY(r.set, r.parallel, r.isFotlExclusive),
    rarity_label: r.rarity ?? null, tier: TIER[r.rarity ?? ""] ?? null,
    mint_cap: r.mintCap, pulled_count: r.circulation, // still_in_packs is a generated column
    is_fotl_exclusive: !!r.isFotlExclusive, serial_low_ask_usd: r.floorAskUsd ?? null,
    thumbnail_url: r.thumbnailUrl ?? null, last_seen_at: new Date().toISOString(),
  };
}
```

### app/api/ingest/panini-editions/route.ts — seed/refresh catalog + circulation (inert)
```ts
import { after } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { fetchPaniniEditions, paniniFeedEnabled } from "@/lib/chains/panini/feed";
import { toEditionRow } from "@/lib/chains/panini/normalize";

export const maxDuration = 300;
export async function POST(req: Request) {
  // auth: Bearer INGEST_SECRET_TOKEN (omitted here for brevity)
  if (!paniniFeedEnabled()) return Response.json({ status: "inert", reason: "PANINI_FEED_MODE unset" });
  after(async () => {
    const rows = (await fetchPaniniEditions()).map(toEditionRow);
    if (!rows.length) return;
    await (supabaseAdmin as any).from("panini_editions")
      .upsert(rows, { onConflict: "external_id,collection_id" });
    // still_in_packs recomputes automatically (generated column);
    // panini_pack_state + panini_fmv_snapshots refreshed by their own steps/cron at go-live.
  });
  return Response.json({ status: "accepted" }, { status: 202 });
}
```

Remaining inert files (same pattern, specify at go-live):
`app/api/cron/panini-circulation-refresh/route.ts` (re-poll circulation → refresh still_in_packs + pack_state),
`app/api/cron/panini-fmv-recalc/route.ts` (write `panini_fmv_snapshots`, algo `panini-1.0.0`), and the read RPCs
backing the squeeze/pack-EV surfaces. Proxy worker `workers/panini-proxy/` if MODE=onepanini (own auth secret,
**never** shares TS_PROXY_SECRET — see "Worker auth surfaces" in CLAUDE.md).

---

## 4. Go-live runbook (phased, gated — execute top-to-bottom when Panini's turn comes)

- **Gate 0 — strategy:** Panini is sequenced active (chain-two Candy work at a safe checkpoint; no parallel build).
- **G1 Feed decision:** sign up for CryptoSlam NFT API, confirm it carries WC2026 Prizm at edition+serial grain;
  price it. If insufficient → stand up `panini-proxy` + capture the `/onepanini` request format (logged-in session).
- **G2 Schema:** apply [panini-schema.sql](drafts/panini/panini-schema.sql) (inert tables). Verify RLS on + anon
  SELECT-only + `check_public_security_invariants()` = 0.
- **G3 Catalog seed:** set `PANINI_FEED_MODE` + creds; run `ingest/panini-editions` once; verify `panini_editions`
  row counts vs the product spec (7 base parallels + FOTL + inserts per player), caps correct, `still_in_packs`
  sane (≤ mint_cap).
- **G4 Circulation + pack state:** wire `panini-circulation-refresh` cron (off the :00 rush, staggered); confirm
  `still_in_packs` decreases over time and `panini_pack_state.packs_remaining` tracks the live drop.
- **G5 FMV:** wire `panini-fmv-recalc`; spot-check a Messi Silver vs a 1/1 Black; `panini_fmv_snapshots` confidences sane.
- **G6 Surfaces (still NOT public):** build pack-EV + squeeze + FMV + entity pages behind the existing
  feature-gate pattern; QA via the rpc-insights-qa checklist; keep routes out of `isPublicPath` until G8.
- **G7 Plane B (optional, when WC2026 becomes bridgeable):** pull the bridge contract + deploy block from
  OpenSea/Etherscan; uncomment the `evm_chains`/`evm_nft_contracts` inserts; point the EVM indexer at Ethereum
  mainnet (needs an ETH RPC — weigh cost); bridge `evm_nft_transfers` → sales by (contract, token_id).
- **G8 Go public:** flip `collections.panini_blockchain.is_active=true`, publish the registry entry, add the
  routes to `isPublicPath`, sitemap, OG. Run smoke + the security invariant + a post-ship watch.

Each phase is independently verifiable and reversible; nothing user-facing until G8.

---

## 5. Discovery items still open (one-time; were blocked from this environment)

1. **CryptoSlam NFT API** contract + pricing + confirm WC2026 Prizm coverage at edition/serial grain.
2. **`/onepanini` request format** (headers + body encoding) captured from a logged-in Panini session — only if
   we choose the direct-proxy path over CryptoSlam.
3. **Bridge contract address + chain_id + deploy block** (OpenSea/Etherscan) — deferred until WC2026 is bridgeable.
4. **Full edition matrix** comes from the feed at G3 (the product spec is the structural ladder, not the 500-card list).

## 6. Cost / risk notes

- Plane A via CryptoSlam = a paid API line item; via `/onepanini` = a proxy worker + brittle scraping + ToS risk.
- Plane B needs an Ethereum-mainnet RPC (indexer infra cost) — only worth it once a meaningful bridged volume exists.
- "Still in packs" is the headline differentiator and is **feed-derived** — protect that pipeline's freshness like FMV.
