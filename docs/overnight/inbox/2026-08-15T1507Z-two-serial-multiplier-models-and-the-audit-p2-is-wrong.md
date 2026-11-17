# The platform has TWO serial-multiplier models, and deep-audit run 2's P2 compared the homepage against the wrong one

**Filed 2026-08-15 15:07Z / 08:07 PT (Claude Code, interactive).** Documentation half SHIPPED; the two pricing
questions below are FILED, not taken — they change published prices and that is Trevor's call.

---

## 1. Correction: deep-audit run 2's P2 is WRONG. Do not act on it.

The audit says:

> **P2.** The homepage publishes three serial-premium multipliers the live model does not produce — claims
> 12× / 4.5× / 3×, live values **9.89× / 1.50× / 5.00×**, two wrong in *opposite* directions.
> …Fix: drop the numerals or render them live with sample size.

`components/HomePageMarketing.tsx:145` is **accurate**. It states the constants in
`lib/fmv/serial-multiplier.ts` verbatim:

```ts
export function fmvSerialMultiplier(serial: number, circ: number): number {
  if (serial === 1) return 12.0      // homepage: "1-of-1 = 12×"
  if (serial <= 10) return 4.5       // homepage: "low serials = 4.5×"
  if (serial <= 23) return 2.8
  if (serial === circ) return 3.0    // homepage: "last mint = 3×"
  return 1.0 + 0.08 * Math.max(0, 1 - serial / circ)
}
```

The audit's 9.89 / 1.50 / 5.00 are the `ALL/ALL` roll-up rows of the **`serial_fmv_multipliers` table** — a
*different subsystem*. **Following the audit's recommendation would have replaced an accurate description of the
FMV API's model with numbers from a model the API never calls.** ⚠ It would also have published a single scalar
for a quantity that is a **matrix**: measured live, Top Shot's reliable rows span `first` **1.98–60.00×**,
`low` **1.00–16.25×**, `perfect` **1.17–48.00×** across tier × circulation band. A one-number summary of that
is a false-precision claim whichever number you pick.

**The register entry should be re-pointed, not closed** — there IS a real finding here, just not the one filed.

---

## 2. The real finding: two models, both called "serial premium multipliers", disagreeing ~3×

| | `lib/fmv/serial-multiplier.ts` | `serial_fmv_multipliers` (table) |
|---|---|---|
| shape | hardcoded step function | fitted per `tier × circ_band`, refit weekly |
| 1-of-1 | **12.0×** | **9.89×** (ALL/ALL; 1.98–60.00 by cell) |
| serial ≤10 | **4.5×** | **1.50×** (ALL/ALL `low`; 1.00–16.25 by cell) |
| last mint | **3.0×** | **5.00×** (ALL/ALL `perfect`; 1.17–48.00 by cell) |
| reached by | `/api/fmv` (public product API), `/api/fmv/demo` | `serial_fmv_estimate` → `get_wallet_moments_with_fmv`, `topshot_underpriced_serials_board` |

So **a collector's PORTFOLIO and the PRODUCT API price the same #1 serial differently** — 9.89× vs 12.0× at the
roll-up, and much further apart per tier (a LEGENDARY/ultra #1 fits at **2.17×**, against the API's flat 12×).
Neither is obviously "right": the table is empirical and tier-aware, the step function is simple and stable.
**The defect is that both exist under one name with nothing recording which is authoritative.**

⚠ Note `lib/market-analytics.ts`'s `applySerialPremium` is a **third** set (1.35 / 1.18 / 1.2) — but that one is
documented in CLAUDE.md as deliberately separate (observed market premium for badge/trait display), so it is not
part of this conflict. Do not "reconcile" it.

**Decision needed (Trevor):** which model is authoritative for the product API? Cheap first step is to make the
API report which one it used rather than to change any number.

## 3. `/api/fmv` evaluates the curve at a FABRICATED circulation

`app/api/fmv/route.ts:102` and `:279`:

```ts
const mult = serial != null ? serialMultiplier(serial, 1000) : null; // circ unknown without metadata
```

The route never selects `circulation_count` — there is no `circulation_count` anywhere in the file. Consequences:

- **The documented `lastMint: 3x` is unreachable** except for editions whose circulation is exactly 1000, because
  the branch is `serial === circ` and `circ` is always 1000.
- **The ordinary-serial tail uses a fake denominator.** Serial 250 of a **/500** edition is halfway through the
  print run but is scored as position 0.25, so it receives 1.06× instead of 1.04×. Any serial > 1000 clamps to
  exactly 1.0× regardless of the edition's real size.
- Serials 1 / ≤10 / ≤23 are **unaffected** (they short-circuit before `circ` is read), which is why this has been
  invisible — the headline cases are all correct.

The fix is small (fetch `circulation_count` alongside the edition lookup, which the route already does for
`external_id`) but it **changes `serialMult` and `adjustedFmv` for every non-banded serial on the documented
product API**, so it is a pricing change, not a bug-fix-in-place. Filed rather than taken.

---

## 4. SHIPPED with this filing (documentation only, no pricing change)

`/api/fmv/demo` carried its **own forked copy** of the multiplier whose tail had drifted to
`max(1, (circ/2/serial)^0.4)`. Measured divergence against the real endpoint:

| serial | circ | `/api/fmv` returns | demo published |
|---|---|---|---|
| 50 | 1000 | 1.076× | **2.512×** |
| 100 | 1000 | 1.072× | **1.904×** |
| 250 | 500 | 1.040× | 1.000× |

So the public, no-auth, 1h-cached surface whose entire purpose is to show a developer what the API does
**overstated the serial premium by up to ~2.3×**, in both its `exampleAdjustments` sample numbers and its
published `serialMultipliers.other` formula string. The fork is deleted, the route imports the shared module,
the documented breakpoints are derived from it, and
`__tests__/api-fmv-demo-docs-match-implementation.test.ts` pins docs-match-code (three mutations, each
reddening only its own assertion). **No FMV math changed** — `/api/fmv`'s own output is byte-identical.
