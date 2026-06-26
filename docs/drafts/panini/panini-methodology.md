# Panini Blockchain — pack-state rollup + FMV methodology (DRAFT)

Fleshes out the two go-live TODOs in the inert routes:
`app/api/cron/panini-circulation-refresh/route.ts` (pack-state rollup) and
`app/api/cron/panini-fmv-recalc/route.ts` (panini-1.0.0 FMV). Nothing here is wired.

Both methods need only **per-edition circulation** (`panini_editions.pulled_count`) + the fixed **pack
definitions** (product spec) — no extra feed beyond Plane A. This is the same arithmetic the community sheet does
by hand, made exact.

---

## 1. `panini_pack_state` rollup (the "still in packs" headline)

The trick: two slots are deterministic per pack, so packs-opened is *derivable*, not estimated-by-eye.

**FOTL packs ripped — exact.** Each FOTL pack yields exactly **one** FOTL-exclusive parallel (Aguila/Maple
Leaf/Old Glory/Nebula). So:

```
fotl_packs_ripped   = Σ pulled_count  WHERE parallel_family = 'fotl_exclusive'
fotl_packs_remaining = 13,960 − fotl_packs_ripped
fotl_packs_ripped_pct = fotl_packs_ripped / 13,960
```

(Sanity vs the tracker: it reported ~54% FOTL ripped on 2026-06-24 — reproduce this number as the rollup's
self-check.)

**Total packs opened — exact-ish.** Every pack (FOTL *and* Hobby) yields exactly **2 Base Silver**, and Base
Silver is minted by *no other* source (craft/challenge mint other parallels). So:

```
total_packs_opened = round( (Σ pulled_count WHERE set_name='Base' AND parallel='Silver') / 2 )
hobby_packs_opened = total_packs_opened − fotl_packs_ripped
hobby_packs_remaining = 50,480 − hobby_packs_opened
```

> **Go-live footgun (verify before trusting the rollup):** the FOTL math keys on
> `parallel_family = 'fotl_exclusive'`, which *we* set in `normalize.ts` from the feed's
> `isFotlExclusive` flag — robust. But `total_packs_opened` keys on the **raw feed label**
> `set_name='Base' AND parallel='Silver'`. The product spec calls it "Base Prizms Silver",
> so if the feed emits the long label this predicate silently returns **0** and every
> downstream count collapses. At discovery, confirm the feed's exact `parallel` string for
> base Silver and either match it (e.g. `parallel ILIKE '%Silver%' AND parallel_family='base'`)
> or canonicalize it in `normalize.ts`. This is the single highest-risk assumption in the rollup.

Store one `panini_pack_state` row per pack type (`fotl`, `hobby`) with `packs_total`, `packs_remaining`,
`price_usd`, `cards_per_pack`. The board derives `packs_ripped_pct`. (If the feed later exposes packs-remaining
directly, prefer that and keep this as the cross-check.)

**Pack EV — `gross_ev_usd` / `net_ev_usd`.** Pulls are uniform across remaining sealed copies, so an edition's
weight in a slot = its remaining sealed supply (`still_in_packs`). Mirror Top Shot's
`compute_pack_ev_per_edition_weighted`:

```
slot_ev(slot) = Σ_eligible(  still_in_packs_e / Σ still_in_packs(eligible_e)  ) × fmv_e
gross_ev_usd  = Σ_slots slot_ev(slot)
              (weight the "non-Silver OR 35% insert" slot: 0.65×non-insert pool + 0.35×insert pool)
net_ev_usd    = gross_ev_usd − price_usd
ev_ratio      = gross_ev_usd / price_usd      -- present as a RANK, never a buy signal (CLAUDE.md)
```

Eligible-edition pools per slot come from the pack→parallel mapping (FOTL: slot1/2 = Silver, slot3 = non-Silver
base ≤/124, slot4 = non-Silver-or-insert ≤/49, slot5 = FOTL-exclusive; Hobby drops slot5). Surface a coverage
caveat when <99% of the eligible pool has an FMV (Top Shot pack-reality precedent), so EV is never overstated.

---

## 2. `panini-1.0.0` FMV methodology

Reuse `lib/fmv-confidence.ts` end-to-end — do **not** invent a Panini-specific confidence ladder. Panini just
gets its own writer + own table (`panini_fmv_snapshots`), exactly like Pinnacle.

**Per-edition, parallel-aware (free by construction).** The side-table already keys one row per (player ×
parallel), so a Messi Base Silver /259 and a Messi Base Black 1/1 price independently. No blending — the bug
Pinnacle had before per-render FMV.

**Confidence (same enum, same gates):**
- HIGH / MEDIUM / LOW from secondary **sales** (WAP + days-since-sale + sales-count-30d, the existing escalation).
- ASK_ONLY from the floor ask × 0.90 when there are no qualifying sales but a live listing exists
  (`serial_low_ask_usd`) — the verified RPC convention.
- STALE when the only sales are >60d old; NO_DATA when there's neither a sale nor an ask.

**Serial-aware (optional `serial_fmv` payload).** Caps are small (≤259) so serial premiums matter — #1, and the
"perfect" serial (= last mint, `serial == mint_cap`), plus the 1/1 Black & Nebula. Reuse the serial-FMV layer
idea: `serial_fmv = base_fmv × serial_multiplier(serial, mint_cap)` from a power-fit once enough Panini sales
exist; until then ship base FMV only and **do not** fabricate a multiplier (the dense-LOW lesson — don't infer
spread that isn't measured).

**Sales basis (where the prices come from):**
- Plane A: CryptoSlam Panini **sales** feed (it already tracks Panini sales/floors) and/or the Panini marketplace
  secondary. Primary at launch.
- Plane B: OpenSea bridged secondary sales (`evm_nft_transfers` price-enriched) — only for bridged cards, only
  once WC2026 is bridgeable. Additive, not required for v1.

**Write discipline (the ledger-locked rule):** delete-then-insert one `panini_fmv_snapshots` row per edition,
`algo_version='panini-1.0.0'`, `collection_id` scoped. Daily duplicates are intentional history. One writer only
— never a second path that can clobber it (the TS `sales_wap_v1` incident).

---

## 3. Validation gates (before any of this is trusted)

- Rollup self-check: `fotl_packs_ripped_pct` reproduces the tracker's ~54% (2026-06-24) within a point.
- `total_packs_opened ≤ 13,960 + 50,480`; every `still_in_packs ≥ 0` and `≤ mint_cap`.
- FMV spot-checks: a Messi Silver prices below his Cracked Ice/Gold; a 1/1 Black is HIGH-variance/own-market; no
  edition prices above its own best ask.
- `v_fmv_sanity_flags`-equivalent = 0 for the Panini writer before wiring its cron.

---

## 4. Label canonicalization (the systemic fix for the §1 footgun)

The §1 `parallel='Silver'` risk is one instance of a general rule: **never match the feed's raw label strings
anywhere downstream.** The same raw-string dependency also lives in `external_id` (`set:player:parallel` — drifting
labels → duplicate editions) and in the squeeze board's grouping. Fix it once, at the edge, in `normalize.ts`.

**Verified why this is mandatory, not theoretical:** CryptoSlam's live Panini *soccer* mints this session render
as e.g. "Base Field Level – Gold Wave", "Base Mezzanine – Honeycomb" — **not** the Prizm sheet's
Silver/Red/Blue/Cracked Ice ladder. So the feed vocabulary will *not* equal the product-spec labels, and the exact
name the WC2026 Prizm set carries in the feed is unknown until G1.

**Hardening (apply when the feed is wired):**
- Add `canonicalParallel(raw)` + `canonicalSet(raw)` maps in `normalize.ts` that fold feed strings → a stable
  internal code: base parallels `silver|red|blue|cracked_ice|gold|zebra|black`; FOTL `aguila|maple_leaf|old_glory|nebula`;
  inserts by set code. Keep the raw label in `parallel` for display; add a canonical `parallel_code`.
- `external_id` keys off canonical codes (`<set_code>:<player_id>:<parallel_code>`), not raw strings, so label
  drift can't fork an edition.
- The §1 rollup predicate becomes `parallel_code='silver' AND parallel_family='base'` (no raw-string match);
  squeeze grouping uses `parallel_family` + `parallel_code`.
- The raw→canonical maps are filled from the **first real pull** (the one open discovery task) — until then they're
  empty and the routes stay inert, so there's no silent-zero risk in production.

This turns the single hardened predicate into a property of the whole pipeline: nothing downstream trusts a feed
string.
