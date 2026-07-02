# Rip Packs City — Roadmap (as of 2026-07-01)

Derived from the 2026-07-01 comprehensive audit ([docs/audits/comprehensive-audit-2026-07-01.md](audits/comprehensive-audit-2026-07-01.md)) plus current strategy. Framing is unchanged and load-bearing:

- **Intelligence-first.** The goal is to be more useful than nbatopshot.com itself. Cart / live-buy stays shelved.
- **Flow is chain one.** NBA Top Shot (flagship), NFL All Day, LaLiga Golazos, UFC Strike, Disney Pinnacle. Quality bar does not drop while chain two is prepped.
- **Chain two = Solana / Candy**, sequenced not parallel. Firm tripwire fires 2026-07-08.
- **No paywall / monetization / public-launch push until 50+ weekly active users.**

The Top Shot experience is already excellent. The through-line of this roadmap is **(1) keep production alive and fast, (2) close the All Day → Pinnacle intelligence-parity gap, (3) fix the data-integrity items that undercut "everything looks accurate," then (4) grow.**

---

## NOW (this week — unblock + stop-the-bleeding)

### 0. Operator actions (only Trevor can do these — highest urgency)
- **Raise the Vercel on-demand spend cap.** It is on track to *pause production* in early July. Raise it or explicitly accept a pause. Nothing else on this roadmap matters if the site goes dark.
- **Raise Supabase PostgREST `db-pool`.** Kills the intermittent "Timed out acquiring connection from connection pool" on edition/pack/player pages (Postgres has huge headroom — 17/90; this is a pool-size setting, not `max_connections`). App-side fan-out was already cut 3→1.

### 1. Parallel mis-attribution writer leak (Finding F1 — data accuracy)
Standard moments' sales are landing on new S8 `::` parallel editions (Club Collection `::16`, Hardcourt `::18`), producing impossible serials at Standard prices on parallel pages — 235 in the last 30 days, still happening today. This directly undercuts "everything looks accurate." **Fix the writer first (sales-indexer edition-resolution for these subedition types + confirm real parallel circulation), then one-time re-key drain.** Do not blind re-key — the conflation history shows that backfires.

### 2. Serial + reconciliation display polish (Findings F3, F4)
- Render `serial_number = 0` as "—" instead of "#0" (3.5% of TS sales). Small display-layer change, high visible-accuracy payoff.
- Fix reward-pack "opened vs minted" reconciliation so depletion/remaining aren't misleading when cumulative opens exceed the `pack_distributions` minted figure.

---

## NEXT (2–6 weeks — close the All Day / Pinnacle parity gap)

This is the "continue replicating FMV / Pack EV to All Day and Pinnacle" work, in priority order by user value.

### 3. All Day Pack EV → drop-weighted (biggest All Day gap)
Today All Day pack EV uses **uniform weighting** (every edition `Wt 1`), which the page itself admits over-states rare-heavy packs. Replicate the Top Shot drop-weighted model: source per-edition pull odds (Dapper studio-platform `searchDistributions`, same secret-free path already used for Pinnacle catalog + All Day studio history) → per-edition `drop_weight` → weighted EV + calibration against realized pulls. Payoff: All Day pack pages go from "rough estimate" to genuinely differentiated.

### 4. All Day data-quality (Findings F2, buyer resolution)
- Cross-source sales dedup (studio-history vs on-chain, ~1% dupes) — dedup key on nft_id+price+day, then one-time collapse.
- Buyer resolution: recover real buyers from the Flowty-router / Dapper-intermediate address via the existing `fetchTxBuyers` / forward-Deposit-scan path so Recent Sales stop showing `— —` / `0x3cdb…`.
- Jersey-match special serial (All Day players have jersey numbers; the row is missing).

### 5. Pinnacle sales enrichment (cheapest Pinnacle wins)
- Capture **serial number** and **buyer/seller** on Pinnacle sales so render pages match TS/All Day (currently serial "—", no buyer/seller).
- FMV history chart on render pages (data exists in `pinnacle_fmv_history`).
- Overview polish (F6): refresh the stale news blurb, trim `set_name` whitespace (coordinated across Pinnacle tables), fix the "−559.2% scarcity" copy, resolve render→character on Recent Top Sales.

### 6. Pinnacle Pack EV (proven feasible, review-gated build)
Pinnacle has **zero pack distributions** indexed — no packs tab, no pack EV, no pack sniper. The probing this week proved the mechanism end-to-end (typename `A.edf9df96c92f4595.PackNFT.NFT`, odds via `searchDistributions`, editionIds → `pinnacle_catalog`; worked example Pixar Sketchbooks EV $36.16 vs $49.95). **Confirmed: supply-weighted is correct; uniform is garbage (531× on parallels).** Build = a Pinnacle pack indexer + supply-weighted EV, then a Packs tab. Bigger lift; gate on Trevor's go since it's a one-drop-at-a-time surface.

---

## LATER (strategic — grow once parity + traction are there)

### 7. Chain two — Solana / Candy
Firm tripwire fires **2026-07-08** (30 days post Candy Solana marketplace open + ≥30 days of sales history + defined edition/serial schema). Chain-abstraction Phases A–F are already complete, so the DB is ready. If the tripwire passes, begin the Solana indexer (Helius DAS + Magic Eden + a `helius-proxy` worker on its own auth surface). Beezie/Base stays a parallel `evm_*` data plane until it has a real product consumer or Candy fails.

### 8. Deeper intelligence surfaces (differentiation)
- **Collector leaderboards** — blocked on a complete ownership index (`wmc` covers ~241 wallets; `moments.owner` is shallow). Needs `topshot_ownership` filled before this ships.
- Activate the omni-channel deal/serial/FMV alerts (built, inert at 0 subscribers) once there's an audience.
- Extend IPFS media verification / recovery where catalogs allow (TS is complete; All Day/Pinnacle need resolver contracts).

### 9. Monetization (gated, do not start before 50+ WAU)
Pro paywall + Stripe + public launch. Current traction is pre-launch (WAU ~2). Instrumentation (`outbound_clicks`, funnel) is live; the lever is audience, not the paywall. No promo (tweets/Reddit/TC DMs) until Trevor explicitly greenlights.

### 10. Standing hygiene (already automated — keep running)
Nightly autonomous pass, daytime monitor, weekly health/data-quality/surface-QA, monthly strategy/memory. Renew the GitHub PAT before **Sep 7** (reminder set Aug 31) or autonomous shipping silently stops.

---

## One-line prioritization
Keep the lights on (Vercel cap, DB pool) → fix parallel accuracy (F1) → drop-weighted All Day EV → Pinnacle sales enrichment → Pinnacle packs → chain two. Monetization waits for traction.
