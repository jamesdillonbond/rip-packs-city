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

---

## 🔁 THE ALLDAY HALF IS GONE — and NOT by fixing the thing this filing proposed fixing

Discharged 2026-09-02 ~02:1x PT, same session. This filing's "separate, DB-side finding" — `nfl_all_day`
/ `onchain_nil` / `not_in`, **700 rows / 9,959 attempts since 08-07** — proposed an escalating cooldown
in `get_serial_backfill_targets`, gated on a measurement of how many of the 700 were permanently
unrecoverable.

**That measurement is now unnecessary, because the rows are no longer targets at all.**
`backfill_null_serial_sales_from_moments` gained a third `COALESCE` leg reading `nft_edition_map`
(ledger 2026-09-02) and one unbounded pass wrote **2,307 serials**. AllDay's null-serial population with
a real `nft_id` went **2,295 → 0**; UFC **10 → 0**; Golazos **2 → 0**.

Re-measured after the drain:

| | |
|---|---:|
| `get_serial_backfill_targets(allday, 1000)` | **0** |
| `get_serial_backfill_targets(topshot, 1000)` | 69 (the rest of the 1,094 sit inside the 24 h cooldown) |
| AllDay rows in `sales_serial_backfill_failures` | 2,144 |
| …of those, whose sale now carries a serial | **2,144 — 100%** |

The picker's leading predicate is `s.serial_number IS NULL OR s.serial_number = 0`, so a resolved sale
is skipped **permanently and by construction**. The treadmill does not need a backoff; it has no fuel.

⭐ **The lesson, and it is the reusable half.** The escalating-cooldown fix was scoped against the
*retry* — how often we re-ask an upstream that keeps saying `not_in`. The actual defect was one level
up: **the answer was already in our own database, in a table the resolver never read.** A backoff would
have made the treadmill cheaper and left 2,180 sales permanently unpriced. 👉 **Before tuning how often
you re-ask a failing upstream, check whether anything local already knows the answer** — a retry policy
is a fix for a *rate*, never for a *gap*.

⛔ **What this does NOT resolve, stated so nobody reads the zero as a green light:** the Top Shot lane's
`http_530` / `http_429` deadness, and the `unknown` null-instrument in `pipeline_runs.extra`, are
untouched. Top Shot's 1,094 remaining null-serial sales are exactly the ones only that lane can reach —
`nft_edition_map` gained **2** of them. **The instrument half stays open, and it is now the whole of
this filing.**

---

## 🔁 FALSIFIER RUN 2026-09-02 ~03:3x PT — NOT MET on the Top Shot half; the AllDay half is EMPTY across every reason

This filing's exit condition was: *"Re-run the `failure_detail` breakdown. If Top Shot's `http_530`
and `http_429` counts stop growing, the upstream recovered and this filing is a historical record."*

**They have not stopped.** Trailing 6 hours: **`http_530: error code: 1033` +245**, **`http_429: error
code: 1015` +436**, newest 08:41:04Z. ⛔ **The Top Shot lane is still 100% dead and this filing is still
open.**

### The AllDay half, by contrast, is finished — and across EVERY failure reason, not just `not_in`

Re-derived after the `nft_edition_map` leg and the 45d → 3650d default window shipped. Every AllDay
row in `sales_serial_backfill_failures` whose sale is still tracked now points at a **resolved** sale:

| collection | failure_detail | rows (24 h) | sale now has a serial |
|---|---|---:|---:|
| `nfl_all_day` | `not_in:0xe4cf4bdc1751c65d` | 269 | **269** |
| `nfl_all_day` | `escrowed_or_unseeded` | 119 | **119** |
| `nfl_all_day` | `not_in:0xb4254874588aa1a2` | 36 | **36** |
| `nfl_all_day` | `not_in:0xbf478c4f106c4ac1` | 24 | **24** |
| `nfl_all_day` | `not_in:0x19c4d1ed5cffac6c` | 16 | **16** |
| `nfl_all_day` | `not_in:0x4ba45c2312086820` | 14 | **14** |
| `nba_top_shot` | `http_530: error code: 1033` | 682 | 78 |
| `nba_top_shot` | `http_429: error code: 1015` | 436 | 15 |

⭐ **This filing scoped the AllDay problem to `onchain_nil` / `not_in` and proposed an escalating
cooldown for it. The local fix retired `escrowed_or_unseeded` as well — a reason the proposal never
considered — because it was never a property of the FAILURE at all.** Every one of those rows failed
for a different upstream reason and every one of them was answerable from `nft_edition_map`.
👉 **When the answer is available locally, the taxonomy of upstream failure reasons is beside the
point — do not design a policy around a breakdown of it.**

⚠ **Top Shot's 78 + 15 resolved are NOT attributed to tonight's changes** and should not be read that
way: its null-serial population is unchanged at **1,094**, and the local legs reach only 2 of them.
Those 93 were resolved before this window. **The 1,094 are exactly the rows only the dead lane can
reach**, which is why the two halves of this filing had opposite outcomes.

### Still open, and now the whole of it

1. The Top Shot lane's `1033` / `1015` deadness (upstream; a breaker fixes the 530, a backoff the 429).
2. `unknown` as the only `failures_by_reason` bucket Top Shot ever reports — the null instrument. The
   discriminator was already in `failure_detail`; only the aggregate dropped it.
