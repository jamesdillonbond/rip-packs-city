# Finding — the Candy treasury heuristic is CORROBORATED, and the fix needs no address from Candy Digital

Cowork cloud session, 2026-08-10 ~19:00 PT. **Read-only; nothing applied.** Follow-up to the filed
"`candy_treasury_wallet` is an argmax heuristic, not an identity" finding, which stopped — correctly —
rather than shipping. **Two of its three conclusions change.**

## ✅ "It may already be wrong" — REFUTED by an independent source

The worry was that `BhA2Bfd8t2F2jDiUNdioGRJQt7MiaWo3Ro5H2Yt7APe2` covers only **117 of 125** editions
while the runner-up covers **all 125**, and "a treasury normally retains some of everything."

**`candy_packs` settles it, and it does not touch `wallet_moments_cache` at all:**

| owner | sealed packs | share |
|---|---|---|
| **`BhA2Bfd8…APe2`** | **2,220** | **88.8 %** |
| `1BWutmTv…NDix` | 38 | 1.5 % |
| `oNQwwPNy…326Wx` | 14 | 0.6 % |
| next five | 8–11 each | — |

**2,501 packs / 84 owners, and the current argmax wallet holds 58× the runner-up.** No collector
holds 2,220 sealed packs. `SELECT candy_treasury_wallet = 'BhA2…'` → **true**: the two independent
methods name the same wallet.

👉 **And the 117/125 argument inverts.** A treasury that has *sold down* its inventory naturally
exhausts some editions entirely; a completionist collector who bought broadly covers all 125. So
117/125 for the treasury and 125/125 for the runner-up is the **expected** pattern, not an anomaly.

ⓘ **Third source checked and it is silent — deliberately reported as such.** `candy_pack_sales.seller`
does **not** show the treasury at all (top sellers: 26/21/14/13/12 sales, all collectors). That table
captures **secondary Magic Eden** sales; primary distribution is drops, not ME. **Wrong instrument,
not contrary evidence.**

## ⛔ "It removes a 1.5 s scan from three boards" — DO NOT sell the change on performance

I was about to make that case. Measured instead — `EXPLAIN ANALYZE` on `candy_treasury_wallet`
**just now**:

```
Execution Time: 76.849 ms
  Index Only Scan idx_wmc_candy_holder_cover  (25,375 rows)   Heap Fetches: 5,965
```

**76.8 ms, not ~1,530 ms**, and 5,965 heap fetches rather than 12,070. Same cache-residency variance
this instance has shown all session (`candy_pack_ev_model` 94,508 ms → under budget in 20 minutes).
**One timing does not establish a cost here — in either direction.** The performance argument for
changing this is not supported; make the change on correctness grounds or not at all.

## 🟢 The fragility hazard is real — but the fix is a CROSS-CHECK, not a replacement

The genuine problem stands: the definition is `ORDER BY count(*) DESC LIMIT 1`, so if a whale crosses
the treasury's holdings, three public boards (`candy_pack_market`, `candy_scarcity_board`,
`candy_special_serials_board`, plus `candy_holder_board`'s exclusion) **silently relabel a real
collector as treasury** — boards stay green, numbers go wrong, nothing alerts.

Current margin, stated properly: **2,840 vs 1,323 serials — a 2.15× gap** (not the 11.2 %-vs-5.2 %
framing, which understates the headroom).

**The opportunity is that there are now two independent signals that currently agree.** That is
exactly the setup for a divergence alarm:

> Alert when `argmax(wallet_moments_cache)` ≠ `argmax(candy_packs.owner WHERE NOT is_burnt)`.

It fires precisely on the failure condition — a relabelling — costs one cheap read of a 2,501-row
table, needs **no address from Candy Digital**, and does **not** freeze a possibly-wrong answer the
way caching the argmax would. **It makes the silent failure loud instead of trying to make it
impossible.**

⚠ **Two caveats before anyone promotes `candy_packs` to the primary definition** (as opposed to using
it as a cross-check):
- **`is_burnt` is 0 across all 2,501 rows.** Either no pack has ever been opened since indexing began,
  or the flag is not maintained. **Resolve that before depending on it** — if packs burn on opening,
  treasury custody decays and the signal eventually inverts.
- **The table refreshed 20.7 h ago.** Fine for a cross-check, thin for a live board dependency.

## Recommendation

1. **Close "the treasury may be wrong."** Two independent sources agree; the coverage argument that
   raised it actually supports the current answer.
2. **Keep the wmc argmax as the definition** for now — it is corroborated, and the performance case
   for changing it evaporated on measurement.
3. **Add the divergence cross-check** as the actual fix for the relabelling hazard. ⚠ If it lands as
   a trust arm, that edits `v_rpc_trust_health` (38 arms, load-bearing) — assert on the arm anchor,
   keep the count exact, re-assert `security_invoker = on` and re-run
   `check_public_security_invariants()`.
4. **Still worth having the real address** if it is cheap to get — it would make this an identity
   rather than a corroborated heuristic. But it is **no longer blocking**, and chasing it is no
   longer the prerequisite for closing the hazard.

---

## ✅ CLOSED 2026-08-11 (Claude Code) — shipped, with one number corrected

Re-verified live: both argmaxes still name `BhA2Bfd8…APe2` (wmc **2,610** serials vs runner-up
1,367 = 1.9×; packs **2,243** vs 21 = **107×**). Recommendations 1–3 actioned.

⛔ **The 76.8 ms measurement above is WRONG, and it inverts the doc's own conclusion.** `EXPLAIN
(ANALYZE, BUFFERS)` on `candy_treasury_wallet`, measured cold: **2,854 ms** (Index Only Scan over
25,375 rows, 7,297 heap fetches, 19,627 buffers). The doc was right that "one timing does not
establish a cost here — in either direction"; that caveat simply cut the other way. The practical
consequence is real: at ~2.85 s this **cannot** be a live `v_rpc_trust_health` arm and must not go
inside `get_pipeline_alerts()`, whose 45 s budget has already been taken down once by a single
heavy arm.

**Shipped instead:** `check_candy_treasury_divergence()` — a standalone service-role SECDEF function
(migration `audit_20260811_edge_fn_http_error_arm_and_candy_treasury_crosscheck`) returning
`diverged` plus both argmaxes, their counts, and `packs_last_seen`. Currently `diverged: false`.
Standalone **on purpose**, so the cross-check can be run by the monitor / weekly sweep without
putting a 2.85 s scan on the alert path. The board stays at **38 arms**; `v_rpc_trust_health` was
not touched.

Both caveats the doc raised are carried verbatim in the function's `note` field so they travel with
the data: `is_burnt` is 0 across all 2,501 rows (resolve before promoting `candy_packs` to the
primary definition), and `candy_packs` refreshes on a multi-hour cadence (~18–20 h at time of
writing), so this is a cross-check, not a live board dependency.
