# Handoff — the closure trigger fixed the label; the number and the sales count still render

> ## ✅ DRAINED 2026-08-04 (PT) — do NOT re-execute
> **Both** candidate fixes shipped, A at the data layer and B across the whole per-edition surface class:
> - **A (data guard)** — BEFORE INSERT trigger `fmv_snapshots_zero_stale_sales_count` zeroes `sales_count_30d` on exactly the `days_since_sale > 30` self-contradiction, for every writer (`supabase/migrations/20260804060000_audit_20260804_fmv_zero_stale_sales_count.sql`). Never touches `fmv_usd`, `days_since_sale` or `confidence`, and leaves rows with a genuine recent sale alone. Measured 58 self-contradictory latest-per-edition rows pre-ship. The same migration also revoked the default PUBLIC EXECUTE on both `fmv_snapshots` trigger functions, clearing `check_secdef_anon_exec_drift()`.
> - **B (UI)** — `34bccbf8` fixed the moment page, then `19ce06f1` extended the identical `isMarketClosed` gate to the canonical edition page and **both** OG unfurl cards (the moment fix had left them showing "Current FMV $313.43" under the frozen-market banner). Guard test extended 5 → 7 cases.
>
> Detail + revert paths: `docs/overnight/ledger.md` 2026-08-04. Kept for the measurement tables and the reasoning, not as an open item.

**Date:** 2026-08-04 · **For:** Claude Code
**Follows:** `20cef621` (market-closure DB fact). That shipped correctly — this is a residual it exposes, found by rendering the page rather than reading the data.

---

## What a visitor sees right now

Public, no auth, live production — `/moment/b110343c-83f7-465a-96c1-771749461cc2` (Dustin Poirier · UFC 257 KO TKO):

```
Current FMV   $313.43
              7 sales / 30d
Avg Sales Price  $313.43

UFC Strike is migrating to the Aptos blockchain; Flow trading has been
frozen since May 2026. This Flow moment is no longer tradeable...

Recent activity
  #94   $285.00   1y ago
  #19   $350.00   1y ago
  #28   $499.00   1y ago
```

**The page states "7 sales / 30d" and "1y ago" in the same viewport, under a banner saying trading has been frozen since May.** The edition's actual last sale was **2025-07-13 — 387 days ago**.

The closure work is doing its job: the banner renders, the schema.org payload carries **no `offers` block**, and a sibling edition with no FMV correctly renders "FMV unavailable". This is specifically about editions that still carry a carried-forward value.

## Root cause

`20cef621`'s trigger caps `confidence`. It does not touch `fmv_usd` or `sales_count_30d`, and the Step-6 carry-forward re-stamps both daily:

| computed_at | fmv_usd | confidence | sales_count_30d |
|---|---|---|---|
| 2026-08-03 04:09 | 313.43 | **STALE** ← trigger working | **7** |
| 2026-08-02 03:49 | 313.43 | MEDIUM | 7 |
| 2026-08-01 03:29 | 313.43 | MEDIUM | 7 |
| 2026-07-31 03:10 | 313.43 | MEDIUM | 7 |
| 2026-07-30 02:49 | 313.43 | MEDIUM | 7 |

`sales_count_30d = 7` is byte-identical across every daily snapshot and has been frozen since the market closed. The UI renders the dollar and the count regardless of `confidence = STALE`.

## Scope — measured, and it is mostly UFC

`fmv_snapshots` carries **both** `sales_count_30d` and `days_since_sale`, so the contradiction is checkable inside a single row with no join:

| collection | rows claiming 30d sales | **self-contradictory** | rate | worst `days_since_sale` | worst false count |
|---|---|---|---|---|---|
| **UFC Strike** | 38 | **18** | **47.4%** | **524** | — |
| NBA Top Shot | 11,801 | 27 | 0.23% | 87 | **75** |
| NFL All Day | 3,093 | 11 | 0.36% | 74 | 16 |

**56 editions platform-wide.** UFC is systemic (closure); Top Shot and All Day are a small tail that self-corrects once an edition trades again — but note one Top Shot edition claims **75 sales in 30 days** with a last sale over 30 days old, on the flagship collection.

The 524-day worst case matches the roadmap's original "sales 470–524 days old" figure exactly.

## Two candidate fixes — your call which, or both

**A. Data guard (mirrors the closure trigger, and I did not ship it deliberately).**

A row cannot honestly say "7 sales in the last 30 days" and "last sale 387 days ago". `days_since_sale` is derived from a real timestamp; `sales_count_30d` is the carried value. So:

```sql
-- BEFORE INSERT on fmv_snapshots, alongside the closure trigger
IF COALESCE(NEW.days_since_sale, 0) > 30 AND COALESCE(NEW.sales_count_30d, 0) > 0 THEN
  NEW.sales_count_30d := 0;
END IF;
```

I held this back because it is user-visible: 56 editions' rendered subtitle changes. It is a factual-consistency guard rather than a pricing change, so it is Cowork-shippable the moment you say go.

**B. UI (yours regardless).** Where `confidence = 'STALE'`, render `—` rather than a dollar, and suppress the "N sales / 30d" subtitle. This is the roadmap §1 rule — *"a number we cannot stand behind must not render as a number"* — and right now a STALE label still renders a confident-looking `$313.43`.

**B is the one that actually closes Gate 1 item 4.** A alone makes the subtitle honest ("0 sales / 30d") but still prints $313.43 next to a frozen-market banner.

## Verification

- Re-run the scope table; UFC self-contradictory should go to 0, TS/All Day to 0.
- Re-render `/moment/b110343c-83f7-465a-96c1-771749461cc2` and confirm no dollar and no "N sales / 30d".
- Confirm a live-market edition with genuine recent sales is untouched (All Day has 3,082 legitimate rows — a guard that zeroes those would be far worse than the defect).

## Guardrails

- Direct to `main`, no branches. PowerShell `git`; `git rev-list --count origin/main..HEAD` = 0.
- Ledger before code, with the revert path.
- ⚠ A docs-only tip commit is skipped by `vercel.json`'s `ignoreCommand` and shows as **CANCELED** — that is correct, not a failed deploy. `4e0a0729`, `2e40ab74` and `b71a3ec5` are all this. Don't chase it.

## Expected end state

A closed-market edition publishes no dollar and no sales-count claim, and the 56 self-contradictory rows go to zero — so the page a collector actually loads stops disagreeing with itself.
