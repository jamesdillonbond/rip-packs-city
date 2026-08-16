# The wallet-backfill error classifiers miss object-shaped rejections, and the cost is a permanently-red mega-wallet

**Filed 2026-08-16 00:25Z (2026-08-15 17:25 PT) · Claude Code, interactive test-coverage pass · NOT SHIPPED — this changes ingest retry behaviour**

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

## How likely is the object shape?

Unverified, and that is the point of filing rather than fixing. FCL and the Flow REST wrapper both reject with non-`Error` values in some paths, but **I have not measured how often a real 1106/1110 arrives object-shaped in production**. The right next step is a measurement, not a patch:

- Add a one-line diagnostic at the catch site recording `typeof err` and `err?.constructor?.name` for classified-as-unknown failures on the wallet-backfill pipelines, and read it after a day.
- If object-shaped rejections never occur, this is a latent robustness gap and can stay as-is with the tests documenting it.
- If they do occur, the fix is one line per classifier — but see the caveat below.

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
