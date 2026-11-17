# FMV sweep — shipped + drafts (2026-06-03)

Output of the 7-agent read-only workflow `rpc-fmv-sweep-2026-06-02` (diagnose 2 mispriced
editions + audit the 4 FMV recalc-fix decisions) plus follow-up verification. Coordinates
with the 2026-06-02 open-work handoff (`docs/handoff-2026-06-02-open-work-and-fmv-fix-calls.md`).

Two of the handoff's recalc-fix premises were **overturned** by skeptical re-verification (D3, D4),
and one of the two `v_fmv_sanity_flags` editions (74:2650) is a **false positive**. Details below.

---

## SHIPPED this session (live)

### D2 — JSON-LD omits `offers.price` on STALE FMV (commit `6e90f3f`, code → main)
A STALE FMV is an unreliable price hint; indexing a wrong price is worse than none.
- [app/moment/[id]/page.tsx](../app/moment/[id]/page.tsx) — `priceForSchema` is `null` when `f.confidence === "STALE"`, so the Product `Offer` is omitted entirely.
- [lib/seo.ts](../lib/seo.ts) `editionJsonLd` — a STALE FMV is skipped as a price source, but a live `lowAsk` is still used (a real current ask is reliable even when the FMV is stale).
- Markup only; no pricing-math change. `confidence` field confirmed present on both payloads.
- Revert: `git revert 6e90f3f`.

### v_fmv_sanity_flags v2 (migration `audit_20260603_v_fmv_sanity_flags_v2_sales_only_baseline`, live)
The original view compared each edition against its set's **all-confidence** median, which in
ask-heavy sets is effectively an **ask median** (ASK_ONLY rows are `low_ask × 0.90`, 5–40× above
real sales). That inflated the baseline — it caught 8:62 only by luck and **false-flagged 74:2650**.
v2 fixes it:
- Baseline = **sales-confidence only** (`HIGH/MEDIUM/LOW`), excludes ASK_ONLY/STALE/NO_DATA.
- Gates: confident cheap price (`HIGH/MEDIUM`), `< 12%` of the sales-median, **absolute gap `> $50`**, set sales-median `> $100`, `>= 4` sale-priced editions.
- At install returns **only 8:62** (`pct_of_sales_median 0.1%` vs sales-median `$1,394.85`); 74:2650 correctly dropped.
- `security_invoker`, `service_role` only (S1 anon-revoke preserved).
- Revert: restore the prior flat-all-confidence / `>$200` definition.

**Wire into monitoring (operator — Cowork task, not in repo):** add to `rpc-weekly-health-check`
(or the daytime monitor): `SELECT * FROM public.v_fmv_sanity_flags;` and alert if any row returns.
Now alert-grade (any row = a real mispricing to investigate).

---

## NEW FINDING — the mis-key bug is a *batch*, not one edition (investigation queued)

The 8:62 diagnosis (below) generalizes. A direct detector — **sales whose `serial_number`
exceeds the edition's `circulation_count`** (physically impossible for a correctly-keyed edition)
— surfaces **49 TS editions** (27 with ≥3 such sales, 15 with ≥5) over the last 120d. The 15-with-≥5
set, with a wmc cross-check (`distinct_other_wmc_keys` = how many *different* true editions the
mis-keyed nft_ids actually belong to):

| external_id | player / set | tier | circ | impossible sales | max bad serial | fmv | other wmc keys | read |
|---|---|---|---|---|---|---|---|---|
| `245:8446` | Chet Holmgren / TS This Playoffs | FANDOM | 190 | 49 | 653 | $5.66 | **0** | likely **stale circ**, not mis-key |
| `8:62` | Giannis / Cosmic | LEGENDARY | 49 | 34 | 972 | $1.56 | **1** | **confirmed mis-key → Clamps 226:7541** |
| `127:4681` | Jalen Green / Throwdowns | RARE | 699 | 16 | 888 | $5.50 | 1 | clean single-target mis-key |
| `124:4841` | Sam Merrill / Base | COMMON | 8000 | 15 | 11173 | $2.16 | 5 | messy (multi-key / circ) |
| `2:62` | Giannis / Base | COMMON | 1000 | 12 | 2378 | $6.31 | 13 | messy |
| `2:313` | Ayton / Base | COMMON | 1500 | 12 | 2846 | $3.67 | 12 | messy |
| `127:4683` | Kawhi / Throwdowns | RARE | 386 | 8 | 1129 | $6.80 | 1 | clean single-target |
| `166:6034` | Gobert / Metallic Gold LE | RARE | 299 | 7 | 742 | $10.33 | 2 | clean-ish |
| `64:2366` | Okoro / Throwdowns | RARE | 888 | 7 | 1752 | $6.80 | 2 | clean-ish |
| `29:907` | Obi Toppin / Metallic Gold LE | RARE | 228 | 6 | 618 | $7.67 | 1 | clean single-target |
| `64:2375` | Westbrook / Throwdowns | RARE | 442 | 6 | 1547 | $11.21 | 1 | clean single-target |
| `29:897` | Oubre / Metallic Gold LE | RARE | 499 | 6 | 730 | $4.25 | 1 | clean single-target |
| `2:41` | Middleton / Base | COMMON | 1000 | 5 | 3024 | $6.38 | 9 | messy |
| `5:109` | Paul George / Metallic Gold LE | RARE | 299 | 5 | 669 | $5.10 | 3 | clean-ish |
| `218:7500` | Keyonte George / Base | COMMON | 4099 | 5 | 7228 | $0.54 | 1 | clean-ish |

**Two distinct sub-populations:**
1. **Clean single-target mis-keys** (`other wmc keys = 1`, RARE/LEGENDARY, low-circ): 8:62, 127:4681, 127:4683, 29:907, 64:2375, 29:897, 218:7500. Same signature as 8:62 — a contiguous mint block of a *different* moment was attributed here. These are the high-confidence re-map candidates.
2. **Messy / ambiguous** (`other wmc keys ≥ 5`, Base Set COMMONs) and **stale-circ false positives** (`keys = 0`, e.g. Chet 245:8446 — no wmc disagreement, circulation_count probably understated for an open Playoffs edition). These need per-edition analysis before any move.

**Detection query (for triage / future view enhancement):**
```sql
SELECT e.external_id, e.player_name, e.set_name, e.tier, e.circulation_count AS circ,
       count(*) AS impossible_sales, max(s.serial_number) AS max_bad_serial,
       (SELECT count(DISTINCT w.edition_key) FROM sales s2
          JOIN wallet_moments_cache w ON w.moment_id = s2.nft_id
          WHERE s2.edition_id = e.id AND w.edition_key <> e.external_id) AS distinct_other_wmc_keys
FROM sales s JOIN editions e ON e.id = s.edition_id
WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND e.circulation_count > 0 AND s.serial_number > e.circulation_count
  AND s.sold_at >= now() - interval '120 days'
GROUP BY e.id, e.external_id, e.player_name, e.set_name, e.tier, e.circulation_count
HAVING count(*) >= 5 ORDER BY impossible_sales DESC;
```
It was kept OUT of the alert-grade `v_fmv_sanity_flags` view (too noisy — conflates mis-key
with stale-circ). Use it as an investigation list. A refined `flag = serial-impossible AND
single-target wmc disagreement` would be precise enough to add later.

**Root cause to find:** a moments-edition writer assigned contiguous recent-mint nft_id blocks
to the wrong `setID:playID`. Likely a `buildEditionKey` / edition-resolution miss on a mint batch.
`wallet_moments_cache` (independent wallet-walk) has the correct mapping in every confirmed case —
**wmc is the source of truth over `moments`/`sales` for nft_id → edition.**

---

## DRAFT 1 — `8:62` re-map (DESTRUCTIVE — needs sign-off; do NOT auto-apply)

**Diagnosis (high confidence, independently re-verified):** Cosmic `8:62` (Giannis, LEGENDARY,
**circ 49**) has 82 moments keyed to it — **71 with serial > 49 (impossible)** — and 101 attributed
sales (all $0.35–$7). Every wmc-resolvable one maps to **De'Andre Hunter "Clamps" `226:7541`**
(COMMON, circ 1149, edition_id `69389eea-8d95-4efe-b074-d80a0c446f73`), whose own edition shows
NO_DATA / 0 sales because its sales were siphoned onto Cosmic. The `$1.56` FMV is honest math on
contaminated input.

**Re-map population (verified counts):**
- Sales on Cosmic 8:62: **101 total** → **22 wmc-confirmed** as Clamps · **78 residual** (no wmc row — sold moments not in any tracked wallet; need on-chain confirmation).
- Moments on Cosmic 8:62: **82 total** → **16 wmc-confirmed** Clamps.

**Two-tier plan:**

*Tier A — auto-safe (wmc-confirmed):* move the 22 sales + 16 moments to Clamps `226:7541`.
```sql
-- PREVIEW FIRST (read-only): exactly which rows move
SELECT s.id, s.nft_id, s.serial_number, s.price_usd
FROM sales s JOIN wallet_moments_cache w ON w.moment_id = s.nft_id
WHERE s.edition_id = '5d122b9b-2ee6-4cec-b64e-1b9315d17283' AND w.edition_key = '226:7541';

-- APPLY (only after preview review + on an authorized session):
UPDATE sales s SET edition_id = '69389eea-8d95-4efe-b074-d80a0c446f73'
FROM wallet_moments_cache w
WHERE w.moment_id = s.nft_id AND w.edition_key = '226:7541'
  AND s.edition_id = '5d122b9b-2ee6-4cec-b64e-1b9315d17283';

UPDATE moments m SET edition_id = '69389eea-8d95-4efe-b074-d80a0c446f73'
FROM wallet_moments_cache w
WHERE w.moment_id = m.nft_id AND w.edition_key = '226:7541'
  AND m.edition_id = '5d122b9b-2ee6-4cec-b64e-1b9315d17283';
```

*Tier B — residual 78 sales (no wmc):* every one has `serial > 49` → cannot be a genuine Cosmic
copy. They are almost certainly the same Clamps block (contiguous nft_id range `50429550–50450252`),
but **do not blind-move** — decode 2–3 sample txs on-chain (via the V1/V2 Dapper decode path) to
confirm the true edition, then move by the same `serial > circulation` gate. If on-chain confirms
Clamps, apply analogous UPDATEs gated on `s.serial_number > 49` instead of the wmc join.

**After re-map:** real Cosmic 8:62 (circ 49) keeps only its ~11 genuine `serial ≤ 49` moments; if
those have no clean sales it honestly falls to STALE/NO_DATA (not $1.56), and Clamps 226:7541 prices
correctly (~$1–2). Let `fmv-recalc` reprice both naturally — **do not live-patch any FMV snapshot.**

**Defensive complement (pricing logic — see also D3 risk class):** add a recalc-input guard that
drops sales where `serial_number > circulation_count` before computing WAP. This would have
prevented 87% of the bad 8:62 input from ever reaching the price, and protects against the whole
mis-key class regardless of attribution cleanup. Scope to the `upsert_topshot_marketplace_fmv`
sales CTE / fmv-recalc Step 1 input. Needs sign-off (touches the price input set).

---

## DRAFT 2 — D1: exclude STALE from headline portfolio total (footnote it)

**Why a DB change is required:** `wallet_moments_cache` has **no confidence column** —
`populate_wmc_fmv_from_snapshots` writes the latest snapshot's `fmv_usd` but drops the label. So
the STALE split has to be a confidence-aware join, not a client-only filter.

**Live impact (Trevor's wallet `0xbd94cade097e50ac`):** 120 STALE moments = **$5,425 of $97,184
(~5.6%)**, including the stale Wemby that the handoff flagged as inflating the total.

**Timing validated:** the candidate aggregate runs **~2.0s on Trevor's 18,451-moment wallet**
(worst realistic case) — under the 8s SECDEF timeout. Incremental cost over today's RPC ≈ 400ms
(the `editions` hash join + lateral latest-snapshot lookup); the existing 1.5s wmc scan dominates.

**Part A — `get_wallet_collection_stats(text)` (DB migration, `CREATE OR REPLACE`):** keep the
signature/STABLE/SECDEF/`search_path`/8s timeout; add a confidence-aware join and split the total.
```sql
-- add to RETURNS TABLE(...): fmv_stale_total numeric, stale_count bigint
-- replace the fmv_total aggregate; add the two STALE aggregates:
COALESCE(ROUND(SUM(wmc.fmv_usd) FILTER (WHERE lf.confidence IS DISTINCT FROM 'STALE')::numeric, 2), 0) AS fmv_total,
COALESCE(ROUND(SUM(wmc.fmv_usd) FILTER (WHERE lf.confidence = 'STALE')::numeric, 2), 0) AS fmv_stale_total,
COUNT(wmc.*) FILTER (WHERE lf.confidence = 'STALE') AS stale_count,
-- ... with this join added after the wmc LEFT JOIN:
LEFT JOIN editions e ON e.external_id = wmc.edition_key AND e.collection_id = wmc.collection_id
LEFT JOIN LATERAL (
  SELECT fs.confidence FROM fmv_snapshots fs
  WHERE fs.edition_id = e.id ORDER BY fs.computed_at DESC LIMIT 1
) lf ON true
```
Notes: `IS DISTINCT FROM 'STALE'` keeps NULL-confidence moments (no reachable snapshot) in the main
total — correct. Pinnacle FMV lives in `pinnacle_fmv_snapshots`, so Pinnacle moments won't match the
`editions` join → `lf.confidence` NULL → counted in the main total (acceptable; Pinnacle is rarely STALE).

**Part B — dashboard ([app/dashboard/page.tsx](../app/dashboard/page.tsx)):** extend `CollectionStat`
with `fmv_stale_total` + `stale_count`; map them in `refreshStats`; add a `staleFmv`/`staleCount`
useMemo mirroring `totalFmv`; render a small caption under the "Portfolio FMV" `StatTile` when
`staleCount > 0`: `+ {fmtUsd(staleFmv)} across {staleCount} stale-priced moments`.
[app/api/profile/collection-stats/route.ts](../app/api/profile/collection-stats/route.ts) passes RPC
fields through verbatim — no change needed.

**Consistency caveat:** sibling RPCs `get_wallet_total_fmv` / `get_wallet_moments_with_fmv` compute
their own totals and would still include STALE. Either update them too, or keep it intentional
(detail views still show STALE; only the headline excludes it). The per-collection rows on the
dashboard also read `fmv_total` — excluding STALE there is consistent but changes those displayed
numbers; confirm that's wanted.

**Status: drafted, not shipped — awaiting your go before touching the RPC** (it changes displayed
portfolio numbers).

---

## DRAFT 3 — D3: 60→90d lookback (handoff premise was WRONG)

**Finding:** there is **no 60d window that gates the NO_DATA decision.** The only `60` in
[app/api/fmv-recalc/route.ts](../app/api/fmv-recalc/route.ts) (~L754) is a **STALE-vs-LOW label
threshold** (`daysSinceSale >= 60 ? "STALE" : "LOW"`); widening it changes labels, not coverage.
The historical-fallback path (Step 5b, ~L646–790) and the cold-tail RPC already look back
**unbounded** in time. So:
- The named grails (**KD Supernova**, **LeBron Anthology circ-99**) have **zero sales at any age** —
  this is a **sales-ingest/data gap**, not an FMV-window gap. No lookback change recovers them.
  Also **KD Supernova is ULTIMATE** → excluded from every fmv-recalc path (owned by
  `recalc_ultimate_fmv`); recalc cannot touch it regardless.
- Across 4,266 TS NO_DATA editions, only **43** have any sale in 90d (29 in 30–60d, 14 in 60–90d).

**The one genuinely actionable lever (NO_DATA-scoped, pricing logic — needs sign-off):** the ~29
NO_DATA editions that *do* have recent sales are trapped by Step 5b's guard
`la.algo_version NOT LIKE '1.7.%'` (~L675), which skips any edition already labelled by 1.7.x.
Relax it to **also re-evaluate NO_DATA 1.7.x rows only**:
```
-- L675-ish, was: (la.edition_id IS NULL OR la.algo_version NOT LIKE '1.7.%')
   now:           (la.edition_id IS NULL OR la.algo_version NOT LIKE '1.7.%' OR la.confidence = 'NO_DATA')
```
…and in the Step 5b mapper (~L742–759), tag recovered rows **SALES_ONLY** when
`sales_count >= MIN_SALES_30D_MEDIUM` else **STALE** (it currently only emits STALE/LOW). Requires
Step 5b to also `SELECT la.confidence`.

**Risk (the load-bearing one):** scope the relaxation to `confidence = 'NO_DATA'` **only** — a
broader relax risks re-clobbering good 1.7.x HIGH/MEDIUM rows, exactly the **2026-05-30 Step 6
self-perpetuating NO_DATA cycle** class. Recovered prices must carry honest SALES_ONLY/STALE labels
and stay subject to `applyStaleGuard` + `apply_fmv_thin_sales_guard`. Do **not** ship this under a
"fixes the grails" claim — it does not (they have no sales).

---

## DRAFT 4 — D4: ASK 0.90 → haircut consolidation (handoff premise was WRONG — DO NOT CHANGE)

The handoff assumed ASK_ONLY is written at `ask × 0.90` at the source **and** a downstream haircut
re-discounts to ~0.75, so the two double-discount. **They do not.** The downstream haircut RPC is
gated by `abs(fmv − floor) < 0.01` — i.e. it only fires when FMV already equals the floor/ask.
ASK_ONLY rows are written with `fmv = ask × 0.90` and `floor = raw ask`, so `fmv ≠ floor` and they
are **excluded from the haircut**. No compounding occurs.

Forcing the "consolidation" (write ASK_ONLY at the raw ask, let the haircut discount) would drop
**209 editions from ×0.90 to ×0.55** — a real regression. **Recommendation: no change.** Mark the
D4 item in the 2026-06-02 handoff as resolved-no-action so it isn't re-proposed.

---

## SHIPPED 2026-06-03 (Claude Code, Trevor-directed, preview-first) — F3/F4/F2-A/F5

- **F3** — serial>circ recalc guard live in `app/api/fmv-recalc/route.ts` (Step 2a-ter). Preview: 102 impossible sales / 26 editions in the 30d window.
- **F4** — migration `audit_20260603_wallet_collection_stats_split_stale` (STALE split, service_role+postgres only) + dashboard footnote. Live STALE total $5,425.24 / 120 moments.
- **F2 Tier A** — migration `audit_20260603_remap_cosmic_8_62_tier_a_to_clamps_226_7541`. 22 sales + 16 moments moved Cosmic 8:62 → Clamps 226:7541. **Tier B (65 residual serial>49, no-wmc) still open — needs on-chain confirmation; F3 guard protects WAP meanwhile.**
- **F5** — Step 5b NO_DATA relax (scoped `confidence='NO_DATA'`) + SALES_ONLY/STALE tagging. Preview: 38 editions → 10 SALES_ONLY + 28 STALE. No window change; grails untouched (zero-sales ingest gap).
- **F6** — no action (premise false, confirmed).

**F2 Tier A revert (exact row ids):**
```sql
-- restore the 22 sales to Cosmic 8:62
UPDATE sales SET edition_id='5d122b9b-2ee6-4cec-b64e-1b9315d17283' WHERE id IN (
 '0f203e1d-3800-48d4-a4a7-e0c308ce588d','16243177-1d31-4b87-9942-bf1ee8654740','1dd28304-14f0-4cdc-958e-18514abadaee',
 '219968f0-3cf5-4c0c-8f14-0a7765989e43','23b66d71-39da-41a0-8824-b46122b2487f','243d255a-39b5-4ac6-aa06-0f60120c145d',
 '321273ac-29cb-4ce4-b011-fb0436798bd1','3ba28f55-7fbe-4c26-87bb-59282e16ef96','56a9fa60-f531-441f-bdcd-2c58b217f550',
 '5cd71b24-0640-41aa-b60b-355e59543362','5ee89ab5-2a55-4161-b78f-963421b1d7ce','610706ef-a03a-48c1-9a70-cfff721ba59f',
 '625009e9-0fdb-4d64-ad0b-4bee3290958d','71247251-e545-4642-9f46-9ffdbcc3c7c8','764623f0-d7cb-4603-abcb-737736aed722',
 '9201ad81-5e2d-4217-9e47-66bbcea6d0a2','ccf0b040-8862-47ce-8040-af27bf609463','ce11e739-3db7-4cad-8b58-74c084dca982',
 'e0e84b15-2eb7-40b1-96d9-563b9ddb9f0e','e13cfe9a-7dad-4e9b-b42e-eda8ae992f15','e96615be-f03b-4b18-98a2-34fb4531bf3b',
 'ff428c72-defb-45b8-bc1d-2de5955c68d8');
-- restore the 16 moments to Cosmic 8:62
UPDATE moments SET edition_id='5d122b9b-2ee6-4cec-b64e-1b9315d17283' WHERE id IN (
 '002cc006-d4df-4090-bf6d-ff6490c66366','41fb7780-f557-429b-9adf-6171ac574949','51638a23-1ce8-4725-963d-8381aa7e331f',
 '705078ba-2edd-4997-b0f2-a0cdd8b9a7b9','80aaadf0-0583-437b-bc6c-754b3a7203ba','8380d5af-d02c-4e8a-a177-21a0daf0fcb9',
 '93515516-95d6-490e-ad5e-744755353265','9aba14c6-1ab7-425b-b5b4-1a5ab5c41e9f','a6e824b7-e8a3-479c-a8a9-08edf87ab0ca',
 'af1bbb9e-173e-4249-a745-792682b74a3c','b4d7184e-df58-45b7-8be1-924030c84d67','b5d98505-6f75-4c70-a83f-a9bbbc6fc6e6',
 'cab4c972-805a-4719-a4f1-764e94b5f878','cc7c5ab0-c491-4783-b74f-6b6c9167c95b','ec1219da-8830-4a8b-8b4c-4e53388bbf9b',
 'f1a2222b-1786-42c6-83a0-8308599dd3f1');
```

## Status summary

| Item | State |
|---|---|
| D2 JSON-LD STALE-price gate | ✅ shipped (`6e90f3f`) |
| v_fmv_sanity_flags v2 | ✅ shipped (migration) |
| F3 serial>circ recalc guard | ✅ shipped 2026-06-03 (code) |
| F4 / D1 STALE-in-totals | ✅ shipped 2026-06-03 (migration + dashboard) |
| F2 Tier A 8:62 re-map | ✅ shipped 2026-06-03 (migration); Tier B (65 no-wmc) still open |
| F5 / D3 Step 5b NO_DATA recovery | ✅ shipped 2026-06-03 (code, premise corrected) |
| F6 / D4 ASK/haircut | ❌ no change (premise false) |
| F1 broader mis-key batch (~15 editions) | 🔎 open; F3 defends WAP, F2-style re-maps queued for the clean sub-batch |
