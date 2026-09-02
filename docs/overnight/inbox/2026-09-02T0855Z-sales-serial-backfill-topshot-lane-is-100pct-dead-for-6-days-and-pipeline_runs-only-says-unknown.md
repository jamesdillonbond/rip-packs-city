# `sales-serial-backfill`'s Top Shot lane is **100% dead for 6 days**, the cause is fully known per-row, and `pipeline_runs` only says `unknown`

**Filed 2026-09-02 ~01:55 PT (08:55Z), Claude Code cloud session.**
**Nothing shipped.** The fix is a Supabase **edge deploy** (`supabase/functions/sales-serial-backfill/`),
which this session deliberately did not do. Found while verifying an unrelated change to this
pipeline's caller — the run payload was in front of me and the Top Shot column was all zeros.

## The observation

Fourteen consecutive runs, the full ~73 h `pipeline_runs` retention:

| lane | processed | resolved | reasons |
|---|---:|---:|---|
| `topshot` | **1,509** | **0** | `{"unknown": N}` — every run, every row |
| `allday` | 1,505 | 107 | `no_holder`, `onchain_nil` — informative |

The pipeline logs **`ok: true`** throughout, because the AllDay lane's 107 resolutions are what
`rows_written` reports. ⚠ **`rows_written` is a per-PIPELINE aggregate over two lanes with opposite
health**, so a lane that has recovered nothing in six days is invisible in it.

## `unknown` is a null instrument — and the discriminator was already on disk

`reason: "unknown"` is assigned at **three** different places in the edge function (a thrown fetch
error, a non-404 HTTP status, a JSON-parse failure), and each one sets a `detail` that says which. That
`detail` **is** persisted per row — `record_serial_backfill_failure` writes it to
`sales_serial_backfill_failures.failure_detail` — and is then **dropped** when `failures_by_reason` is
aggregated into `extra`.

**So the answer was one query away the whole time:**

| collection | reason | `detail` head | rows | attempts | since |
|---|---|---|---:|---:|---|
| `nba_top_shot` | `unknown` | **`http_530: error code: 1033`** | 682 | 1,819 | **2026-08-27** |
| `nba_top_shot` | `unknown` | **`http_429: error code: 1015`** | 436 | 1,515 | **2026-08-29** |
| `nfl_all_day` | `onchain_nil` | `not_in:<holder>` | 700 | **9,959** | 2026-08-07 |
| `nfl_all_day` | `no_holder` | `escrowed_or_unseeded` | 119 | 144 | 2026-08-30 |

👉 **The Top Shot lane is not broken. Its upstream is.** `http_530 / error code: 1033` is Cloudflare
origin-down and `http_429 / error code: 1015` is Cloudflare rate-limiting — 100% of the lane, split
between the two.

⭐ **And `error code: 1033` is character-for-character the signature `lib/pipeline/upstream-breaker.ts`
already exports as `CLOUDFLARE_ORIGIN_DOWN`.** The same Top Shot outage is tripping `offers-sweep`'s
breaker on schedule tonight. **One upstream event, two pipelines, one of them protected and instrumented
and the other burning its whole batch into it every two hours for six days.**

## Suggested fixes, in order of value — all edge-side

1. **Wire the breaker into the Top Shot lane.** `checkUpstreamBreaker` is built for exactly this shape
   and its default signature already matches the observed 530. ⚠ It is currently a `lib/` module and
   this is a Deno edge function, so it cannot be imported as-is — **do NOT copy it** (that is how this
   repo got 37 divergent `stripComments`). Either read the last run's error DB-side, or extract the
   signature to something both runtimes can share.
2. **Stop `unknown` being a null instrument.** Carry a coarse bucket of `detail` into `extra` — the
   HTTP status is enough (`unknown_http_530: 271`). **The rule this violates is already written down:
   fixing a guard without fixing the field an observer keys on leaves the incidence unmeasurable.**
3. ⚠ **The 429 deserves its own answer, and it is not the same as the 530.** Being rate-limited is a
   statement about OUR request rate; 1,515 attempts into a 1015 is arguably making it worse. A breaker
   fixes the 530; the 429 wants a backoff.

## A separate, DB-side finding in the same table

`nfl_all_day` / `onchain_nil` / `not_in:<holder>`: **700 rows, 9,959 attempts, since 2026-08-07** —
about **14 attempts per row over 26 days**. `not_in` means the moment is not in the recorded holder's
collection, which for a sold-on moment is **permanent**, and `get_serial_backfill_targets` applies a
**flat 24 h cooldown with no escalation**, so a row that has failed fourteen times is retried exactly as
often as one that failed once.

⭐ **This half is fixable WITHOUT a deploy** — the picker is a DB function
(`public.get_serial_backfill_targets`, `LANGUAGE sql`), so an escalating cooldown keyed on
`sales_serial_backfill_failures.retry_count` is a `CREATE OR REPLACE`. ⛔ **NOT done here**, because it
needs a measurement first: how many of the 700 are genuinely permanent versus recoverable once the
holder is re-walked? An escalating backoff on a recoverable row just delays the recovery.

## Falsifier / re-derive

Re-run the `failure_detail` breakdown. **If Top Shot's `http_530` and `http_429` counts stop growing,
the upstream recovered and this filing is a historical record, not an open item** — the lane needs no
code to start working again. **The instrument half stays open either way:** `unknown` will hide the next
cause exactly as well as it hid this one.
