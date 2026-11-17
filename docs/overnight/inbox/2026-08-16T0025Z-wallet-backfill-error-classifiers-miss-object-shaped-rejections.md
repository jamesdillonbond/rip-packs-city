# The wallet-backfill error classifiers miss object-shaped rejections, and the cost is a permanently-red mega-wallet

**Filed 2026-08-16 00:25Z · RESOLVED 2026-08-16 by measurement — see the next section. Kept as a record so nobody re-opens it.**

## What

All five classifiers in `lib/chains/flow/wallet-backfill-helpers.ts` normalize their input the same way:

```ts
const msg = err instanceof Error ? err.message : String(err)
```

`String(err)` on an **object-shaped rejection** yields `"[object Object]"`. So a genuine Cadence 1106 arriving as `{ message: "... max interaction with storage ..." }` — rather than as an `Error` — is **not classified**.

Affected: `isFlowQueryTimeout`, `isStorageLimitError`, `isComputationLimitError`, `isAccessApiInternalServerError`, `isNoCollectionCapabilityError`.

## Why it matters — the consequence is inverted from what it looks like

This is not "an error message renders badly". These classifiers exist **specifically to stop unfixable wallets counting as pipeline failures**. From the code's own comments: a 1106 is *"a permanent property of mega-wallets… there is no retry that fixes it"*, so those wallets are marked `ok: true` with `terminated_reason='storage_limit_exceeded'`.

A missed classification therefore does the opposite of the intended thing: the mega-wallet goes back into the **failure count forever**, where it reads as a regression nobody can clear and no retry resolves. The same applies to `computation_limit_exceeded` (1110) and `access_api_error_likely_computation_limit`.

## MEASURED 2026-08-16 — IT DOES NOT HAPPEN IN PRODUCTION. This is a latent robustness gap, not a live defect.

The original filing said this was unverified and asked for a diagnostic. **No diagnostic was needed** — the evidence was already in the database, and the check is decisive because the SAME stringification that feeds the classifiers also feeds the logged error:

```
catch (err) {
  const msg = err instanceof Error ? err.message : String(err)   // <- same expression
  ...
  await logRun({ ..., ok: false, error: msg })                   // <- lands in pipeline_runs.error
```

So an object-shaped rejection would write the literal `[object Object]` into `pipeline_runs.error`. Measured:

| source | rows with `[object Object]` | rows with any error | total |
|---|---|---|---|
| `pipeline_runs`, `wallet-backfill%` (73 h retention) | **0** | 902 | 12,197 |
| `pipeline_runs`, all pipelines | **0** | 2,943 | 41,561 |
| `pipeline_runs_daily.last_error` (indefinite, from 2026-07-29) | **0** | 676 | 2,465 |

**Zero out of 902 real wallet-backfill errors**, and zero across every pipeline the platform runs. FCL and the Flow REST wrapper evidently reject with `Error` instances on these paths in practice.

⚠ One caveat on the weakest row: `pipeline_runs_daily.last_error` keeps only ONE error per pipeline per day, so a rare object-shaped failure could in principle be masked there by a later different error. The 73 h `pipeline_runs` window is the load-bearing evidence — it retains every row.

**Disposition: leave the code as it is.** The tests below pin the current behaviour in both directions, which is the appropriate response to a gap that is real in principle and absent in practice. Do NOT widen the classifiers on the strength of this note — that was the original recommendation, and the measurement removed its justification.

## Why I did not just fix it

Reading `.message` off a non-`Error` **changes retry-vs-abort on production wallet ingest**. Wallets currently counted as failures would start being marked `ok: true` with a terminated_reason, which:

- changes `pipeline_runs` failure rates for `wallet-backfill*` (and anything watching them),
- is exactly the class of change that should arrive with a before/after count of how many wallets re-classify,
- could **mask a real failure** if the widened matcher catches a message it should not — the direction that fails silently.

⚠ Note the safe-direction asymmetry already encoded: `null`/`undefined`/`0`/`false` rejections all classify as unknown, i.e. as a **real failure**. That is correct — an unrecognised failure must stay a failure rather than be silently marked `ok: true`. Any widening must preserve that.

## Current behaviour is now pinned

`__tests__/wallet-backfill-helpers.test.ts` documents the limitation explicitly, in both directions, so a future change is deliberate:

- raw **string** rejections DO classify (the `String(err)` half, previously dark for three of the five),
- **object-shaped** rejections do NOT,
- `null` / `undefined` / `0` / `false` classify as unknown,
- and the `elapsedMs > 10_000` gate is now asserted **on the boundary** (10,000 classifies, 10,001 does not) — the previous fixtures used 4s and 20s, which pass whether the comparison is `>` or `>=` and whether the constant is 10s or 15s, so they asserted far less about the gate than they appeared to.

Mutating the classifiers to read `.message` off any object reds the object-shaped test, so if someone ships that fix they will be told to come back to this note.

## Related

Same file, same pass: 50 source lines still carry uncovered branches (the paginated `if (error)` reads at ~409/437/472, the `if (updErr)` update paths at ~1008/1314, and the cached-and-enriched skip at ~1584/1589). Those are lower-stakes than the classifiers and were left.
