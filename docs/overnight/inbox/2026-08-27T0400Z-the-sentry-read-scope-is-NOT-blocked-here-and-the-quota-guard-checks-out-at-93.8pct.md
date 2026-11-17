# ⭐ The Sentry read scope is NOT blocked in a Cowork session — and with it, the shipped quota guard checks out at **93.8% coverage** against Sentry's own store

**Filed 2026-08-26 (PT) / 2026-08-27 04:00Z by Claude (Cowork cloud).**
**Nothing shipped. This is a measurement that retires a standing blocker and validates a shipped change.**

---

## 1. 🚨 The standing blocker's premise is false *for this session type*

[`2026-08-26` inbox / commit `278c79c`] records: *"The Sentry watchdog is blocked on a read scope, not
on money … `.env.local` has no `SENTRY_AUTH_TOKEN`; `.env.sentry-build-plugin` does carry one … but
three real requests return 403 — it is upload-scoped."* That probe was correct and the conclusion
followed from it.

⭐ **It is nonetheless incomplete, because the token is not the only read path.** This session has a
**Sentry MCP connector** with organisation read access, and it answered on the first call:
`rip-packs-city` @ `https://us.sentry.io`, project `javascript-nextjs`, 20 unresolved issues, full
event aggregation.

⚠ **Read the scope of that claim carefully, because it is narrow.** This does **not** give production
a token, so it does **not** build the in-app watchdog arm the filing wanted, and it does **not**
survive into a headless or scheduled run where interactively-authenticated connectors may be absent.
**What it does give is an on-demand read path from a Cowork session** — enough to verify, size and
audit, which is precisely what has been impossible for nine days.

⭐ **The transferable rule: "no credential" and "no access" are different findings.** A probe that
correctly proves a *token* is dead does not prove the *capability* is unreachable — enumerate the
paths, not the secrets.

## 2. ✅ The blackout start is now confirmed by a second, independent instrument

The 2026-08-25 diagnosis derived the cutoff from an ingest response header
(`x-sentry-rate-limits: …organization:error_usage_exceeded`). Sentry's own event store agrees:

> **Newest stored error event: `2026-08-18T13:21:59+00:00`.**

Two independent instruments, agreeing **to the second**, on a number the whole Sentry decision rests
on. That is worth having; it was previously a single-source figure.

Corroborating shape: every one of the top 20 issues carries `lastSeen` of **8–11 days** and not one
is newer. **The blackout is total, not partial** — no signature is trickling through.

## 3. ⭐ The shipped guard, audited against the store it was NOT sized on

`lib/observability/sentry-quota-guard.ts` carries two rules. The second, `pg-statement-timeout`, was
deliberately sized from **Vercel runtime errors** because — in its own words — *"Sentry has been
storing nothing since 2026-08-18, so that instrument is unavailable."* **That instrument is
available here.** Sentry stored-event counts, `errors` dataset, 30-day window (≈21 days of real data,
since storage stopped on the 18th), 30 aggregate rows, **5,336 events**:

| rule | matches | events | share |
|---|---|---:|---:|
| `rpc-deadline` — `"timed out after"` ∧ `"with no response"` | 8 titles | **3,427** | **64.2%** |
| `pg-statement-timeout` — `"canceling statement due to statement timeout"` | 6 titles | **1,578** | **29.6%** |
| **covered by the guard** | | **5,005** | **93.8%** |
| not covered | 16 titles | 331 | 6.2% |

**At the shipped `rate: 0.05`, that window's 5,336 events become ~581 — an 89.1% reduction — while
every unrecognised error still arrives at full rate.** ✅ **Both rules are confirmed on an instrument
independent of the one that sized them**, and the second rule, sized entirely from Vercel, lands
within the same order as its Sentry share. That is the check that could not be run when it shipped.

⚠ **ONE FIGURE IN THE GUARD'S OWN COMMENT DOES NOT RECONCILE, AND I AM NOT GOING TO FORCE IT.** The
header cites *"15,388 events / 2,963 distinct users, in ONE week"* for the edition-detail signature;
Sentry's store shows **2,738** for that title across the whole 30-day window. **These are different
instruments over different windows** — the 15,388 was measured 2026-08-23, i.e. *after* Sentry stopped
storing, so it cannot be a Sentry count. ⛔ **Do not reconcile them by arithmetic** (that is the
error retracted elsewhere tonight). The guard's sizing does not depend on which is larger: both say
the same thing qualitatively, and the rule is a 5% sample either way.

## 4. ⭐ The uncovered 6.2% should STAY uncovered — and here is why, itemised

| the residual | events | share |
|---|---:|---:|
| the same DB degradation wearing **other** messages (`TimeoutError: aborted due to timeout`, `Could not query the database for the schema cache`, `Timed out acquiring connection from connection pool`) | **177** | **3.3%** |
| `smoke test failed:` / `smoke check could not run:` self-reports | 149 | 2.8% |
| `listing_resolution_failures_inserted` | 5 | 0.1% |

⛔ **Do not widen the match to sweep in the 3.3%.** It is tempting — they are the same underlying
saturation — but the guard's whole safety property is **DEFAULT IS SEND**, and each broadening of a
substring test moves probability mass toward silently sampling a *novel* error. `"TimeoutError"` and
`"connection pool"` are generic strings that a future, unrelated failure would also carry. **3.3% is
not worth renting space in the one mechanism whose job is to never swallow something new.**

ⓘ **And the 2.8% is not noise to suppress — it is the honesty layer working.** Those are the smoke
tests reporting that they could not run, which is exactly the signal that should reach a human.

## 5. 👉 What to do with this, in order

1. ⭐ **The guard's effect has NEVER been observed, and there is now a way to observe it.** Every kept
   event is tagged `sentry_sampled_signature` / `sentry_sample_rate`. **Falsifier: after the quota
   resets, stored events for these signatures MUST carry those tags. If they do not, `beforeSend` is
   not wired into the runtime that produced them** — and note that `sentry.client.config.ts` is
   already documented as never bundled by production's turbopack build, so this is a live risk, not
   a hypothetical one.
2. **Re-read `Stats → Dropped` for reason `before_send` once ingest resumes.** That is Sentry's own
   count of what the guard dropped, and it makes the true incidence recoverable rather than lost.
3. ⚠ **The read-scoped token is still worth creating** and this filing does not retire that request —
   it retires the claim that *nothing* can read Sentry from here. **A production watchdog needs a
   token; an audit does not.**
4. ⛔ **None of this fixes the underlying RPC timeouts**, which are what generated 93.8% of the
   volume. The guard stops a known-broken thing from blinding us to everything else; it does not
   make the thing less broken.

⚠ **Sampling caveat on every number above:** one 30-day aggregation, truncated at 2026-08-18, 30
rows deep. It is the right shape for sizing a substring rule and the wrong shape for claiming a
trend. Re-run it after ingest resumes rather than quoting these figures forward.
