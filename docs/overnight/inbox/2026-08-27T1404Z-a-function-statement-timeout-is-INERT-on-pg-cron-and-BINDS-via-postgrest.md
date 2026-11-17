# 🚨 A function's `SET statement_timeout` is **PATH-DEPENDENT** — inert on the pg_cron path, **load-bearing via PostgREST** — and 122 declarations are holding real ceilings up

**Filed 2026-08-27 07:04 PT (14:04Z) by Claude Code on Trevor's box, interactive.**
**Refines:** known-issues **#43** (filed 2026-08-26, *"48 pg_cron jobs declare a `statement_timeout` that
does nothing"*). ⚠ **It does NOT refute #43's pg_cron measurement** — see §5.
**Refutes:** three claims in CLAUDE.md's `Database` bullet, one of which would make a "cleanup" actively
destructive.

---

## 1. How this was found — not by looking for it

Chasing `wallet-username-resolver`, which fails **10 of 15 ticks over 48 h**, nine of them
`canceling statement due to statement timeout`. The signature is unusually clean:

| | |
|---|---|
| every failure | `rows_found: 0`, `resolved: 0`, duration **60,129–60,207 ms** |
| successes | 16,125 ms (found 18) and 57,980 ms (found 138) |

`rows_found: 0` on every failure means it dies in the **first** step — the
`wallet_usernames_unresolved` RPC never returns — and it dies at **~60.1 s**, every time.

That number is suspicious, because the function declares `SET statement_timeout TO '60s'` — and
**#43 had just proven, the night before, that such a declaration does nothing.** Two measurements
that cannot both be right about the same object is the cheapest kind of lead.

## 2. The controlled A/B — same path, one variable

Two probes, identical but for the declaration, both `SECURITY INVOKER`, both sleeping **40 s**, both
called over HTTPS through PostgREST with the **service_role** key (i.e. exactly how every
`supabaseAdmin` RPC runs):

| probe | declares | result |
|---|---|---|
| `scratch_sleep_probe` | *nothing* | **HTTP 500 at 31 s** — `57014 canceling statement due to statement timeout` |
| `scratch_sleep_probe_pc` | `SET statement_timeout TO '60s'` | **HTTP 200 at 41 s** — completed, `timeout=1min` |

⭐ **The declaration moved the ceiling from 30 s to 60 s. On this path it is not inert; it is the
thing that decides.** And the control pins the other half: **`service_role`'s `statement_timeout=30s`
really does bind here** — the un-declared probe died at exactly it.

✅ **Reproduced on the real object, not just the probes:** calling
`wallet_usernames_unresolved(300)` through the same path returns **500 at 61 s**. The function
declares 60 s; it got 60 s.

## 3. ⛔ Why this matters more than a curiosity: 122 declarations are load-bearing

Parsed to seconds rather than compared as text (⚠ `max()` on a `text` column is **lexicographic** —
it reports `'90s' > '600s'`, which is how this nearly went out wrong):

| | |
|---|---|
| functions declaring a `statement_timeout` | **195** |
| range | **3 s – 900 s** |
| **declaring MORE than `service_role`'s 30 s** | **122** |
| declaring 30 s or less | 73 |

Longest five: `fmv_thin_sale_ask_disclosure_refresh` **900 s**, then
`refresh_topshot_pack_sales_agg`, `rpc_trust_health_precompute_refresh`,
`refresh_allday_pack_realized`, `refresh_topshot_pack_rip_values` at **600 s** each.

⛔ **So a batch "these declarations do nothing, remove them" would cap 122 functions at 30 s** —
including four board refreshes that legitimately run for minutes. #43 correctly warns against
*making the declarations real*; **the live hazard is now the opposite one, and nobody had written it
down.**

## 4. ⭐ It also explains the 352 s that CLAUDE.md could not

CLAUDE.md states **"no Postgres timeout bounds a `supabaseAdmin` RPC — the bound is the client (worst
observed 352 s)."** That is refuted as stated — the bound is 30 s — but the 352 s observation was
real, and the A/B reconciles it rather than discarding it: **a `supabaseAdmin` RPC is bounded by
whatever its FUNCTION declares**, and 122 functions declare more than 30 s, four of them 600 s. A
352 s RPC is not an unbounded one; it is one whose callee declared room for it.

⭐ **The generalisation that was wrong: "I saw one run 352 s, therefore nothing bounds it."** A single
long observation cannot distinguish *no ceiling* from *a high ceiling set somewhere you did not
look* — and the place nobody looked was the callee's own definition.

## 5. ⚠ What this does NOT overturn — stated precisely

- **#43's pg_cron measurement stands.** It probed the **pg_cron** path (`cron_heavy`), I probed
  **PostgREST**. Both can be true; the behaviour is **path-dependent**, and that is the finding. I
  did not re-run its four probes and I am not claiming they were wrong.
- ⚠ **I reproduced its result once, on my own path:** a session-level `SET statement_timeout = '3s'`
  followed by a call to a function declaring `60s` and sleeping 6 s **died at 3 s** — the declaration
  did not extend it there. **So both behaviours are real and I cannot yet say what selects between
  them.** ⛔ **The mechanism is deliberately NOT claimed** — I have an A/B, not an explanation, and
  a plausible story here would be exactly the "a plausible mechanism is not a measurement" error this
  repo keeps paying for.
- ⚠ **`anon` / `authenticated` were NOT re-measured.** CLAUDE.md's *"`authenticator`'s 8 s is the real
  ceiling"* is untouched by this work. Testing it would need an **anon-executable sleep function**,
  which is a DoS primitive on a public API and would trip the SECDEF-anon-exec sentinel — **not worth
  it for a doc line.**

## 6. Back to the pipeline this came from

`wallet-username-resolver` is **not** a timeout-configuration bug. Its 60 s is doing what it says,
and the query genuinely needs longer under load. Measured (⚠ during a saturation spell —
`active=8 / io_wait=9`, so **BUFFERS only, no timing claims**):

- **147,652 buffers** (104,884 hit + 42,768 read) for the whole statement.
- The `sales` legs carry **~61,000 buffers each**, with **`Heap Fetches: 49,343` of 98,511 rows —
  50%.** The 21-day window sits on the write head of `sales_2026`, so its 88.6% all-visible ratio
  buys nothing here (the #39 lesson, in a second place).
- ⭐⭐ **And the whole thing exists to find 15 rows.** `Limit (actual rows=15)`,
  `Rows Removed by Filter: 4130`. 99,193 sales → 3,238 distinct addresses → **15 unresolved**, every
  3 hours, at ~150k buffers a pass, failing 60% of the time.

⛔ **A rewrite I was about to ship is REFUTED by its own measurement.** The `sales` leg uses a
cross-join lateral (one scan, two rows per sale) while the two `pack_purchases` legs pre-aggregate.
Making `sales` symmetric is **provably equivalent** — `max(max(x)) = max(x)`, and the symmetric diff
over the real population is **3,238 = 3,238, 0 only-in-old, 0 only-in-new** — but it makes the plan
scan `sales` **twice**, and that scan is the expensive thing. **Equivalent and worse.** Recorded so
nobody re-derives it.

👉 **The real lever is a design change, not a query tweak:** the pipeline re-derives a 21-day
aggregate every 3 h to discover a handful of new addresses. Maintaining `wallet_usernames` rows at
ingest (username NULL) would turn the resolver into `WHERE username IS NULL`. **That is an
ingest-path change and is NOT auto-shippable** — filed, not built.

---

## 7. ⭐⭐ ADDENDUM, same session ~07:55 PT — there is a THIRD ceiling above both of these, and it CORRECTS §4 of this filing

§4 concluded *"a `supabaseAdmin` RPC is bounded by whatever its FUNCTION declares."* **That is true only
up to ~120 seconds.** Found by pulling on a different thread — six pipelines all failing with the same
error string — and it changes the actionable conclusion, so it is recorded here rather than in a new file.

### The measurement, controlled in both directions

One `SECURITY INVOKER` function declaring `SET statement_timeout TO '600s'`, called through
`/rest/v1/rpc/…` with the service-role key, at two sleep lengths:

| sleep | result |
|---|---|
| **150 s** | **HTTP 504 after 125 s** — body `upstream request timeout` |
| **110 s** | **HTTP 200 after 111 s** — `COMPLETED 110s; timeout=10min` |

⭐ **The positive control is what makes this readable.** The 110 s run proves the 600 s declaration really
was in force (`service_role`'s 30 s would have killed it at 30), *and* that nothing else was broken. The
150 s run then fails at **125 s** with a **504** — an HTTP status, not a Postgres error code. **So the
Supabase gateway hard-caps a PostgREST request at ~120 s regardless of role or declaration.**

### ⛔ What this changes

**The declaration ceiling and the gateway ceiling compose, and the lower one wins:**

| path | what bounds a long call |
|---|---|
| pg_cron (`SELECT public.fn()`) | the role's timeout — **the declaration is INERT** (44/248 overrun, worst 596,559 ms) |
| PostgREST / `supabaseAdmin` | `service_role` 30 s, **raised by the callee's declaration**, **hard-capped by the gateway at ~120 s** |

⭐⭐ **Therefore a declaration above ~120 s is unreachable on BOTH paths** — inert where pg_cron calls it,
gateway-killed where PostgREST does. **48 of the 196 declaring functions are in that band** (up to
**900 s**), including `fmv_thin_sale_ask_disclosure_refresh` at 900 s and four board refreshes at 600 s.
⚠ **This does NOT make them safe to strip** — §3's warning stands for the **75 functions declaring 30–120 s**,
which are exactly the ones the gateway still lets through. **The two groups need opposite treatment, and
telling them apart requires the 120 s line.**

### ⓘ It also gives six failing pipelines one root

`upstream request timeout` is the gateway's string, not Postgres's — CLAUDE.md already warns the two
"produce the same number and mean completely different things". Over 24 h these all fail with it:
`run-insider-detectors` **5/24**, `lock-check-batch` **9/46**, `compute-allday-pack-ev` **6/46**,
`allday-unmapped-resolver` **8/76**, `populate-pinnacle-wmc-fmv` **2/23** (plus
`topshot-buyer-backfill-historical` **7/47** on pool exhaustion). ⭐ **That is one ceiling with six
symptoms, not six bugs** — the same shape as the pg_cron statement-timeout cluster the register already
records as "one root, not 8". ⚠ **Pipeline `duration_ms` above 125 s does not contradict this** — several
of these make one RPC per collection, so a tick can burn ~120 s more than once
(`lock-check-batch` reports `nba_top_shot: … | disney_pinnacle: …`, avg 142 s, max 295 s).

⚠ **Not a fix, and no fix is proposed here.** The lever for each is "make the call finish inside 120 s"
(smaller batches per RPC), which is per-pipeline route logic. Filed, not built.

ⓘ **One mechanical note worth keeping:** a function created with `execute_sql` is **invisible to
PostgREST until the schema cache reloads** — the first probe returned `PGRST202 … no matches were found
in the schema cache`. `NOTIFY pgrst, 'reload schema'` fixes it in a few seconds. This is why
`apply_migration` causes the documented PGRST002 burst and `execute_sql` DDL does not: only one of them
reloads.
