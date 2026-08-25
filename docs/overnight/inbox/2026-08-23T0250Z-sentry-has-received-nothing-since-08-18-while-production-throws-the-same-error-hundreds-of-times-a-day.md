# 🚨 Sentry has ingested NOTHING since 2026-08-18 13:21:59Z — and Vercel logged the *identical* error string 447 times in the last 24 hours

**Filed 2026-08-22 19:50 PT (2026-08-23 02:50Z), Claude Code interactive.** Found while sweeping for
open work, not while chasing a report. Nobody reported it, which is the point: **a dark error
reporter reports nothing, including its own darkness.**

## The measurement, with the positive control

**Sentry side.** `rip-packs-city / javascript-nextjs`, errors dataset, 14-day window, sorted by
`-timestamp`. The **newest error event in the entire project** is:

```
Error: edition detail unavailable: rpc get_edition_detail timed out after 45000ms with no response
issue JAVASCRIPT-NEXTJS-26 · timestamp 2026-08-18T13:21:59+00:00
```

`lastSeen:-48h` over the same project returns **zero issues**. Every one of the 15 unresolved issues
reads `last seen 4 days ago`.

**Vercel side, same window, same error string** (`get_runtime_errors`, `since=24h`, run
2026-08-23T02:45Z):

```
Error: edition detail unavailable: rpc get_edition_detail timed out after 45000ms with no response
count=447  users=64  routes=/[collection]/edition/[slug], /[collection]/edition/[slug].rsc
first=2026-08-15T13:16:59Z  last=2026-08-23T00:48:40Z
```

⚠ **This is the control that makes the finding structural rather than a sampling artifact.** It is
not "Sentry is quiet and production might be quiet too" — it is **the same error, by string, in the
same hours, present on one instrument and absent from the other.** Production threw it 447 times in
the last 24h. Sentry's copy of it stopped 4½ days ago.

And it is not one class. The same 24h Vercel window carries **50 error groups**, many still firing
minutes before the read: `[pack-detail] pack_realized_ev` (271 / **124 users**),
`[panini-squeeze] backing view error` (257 / **230 users**), five `[candy-mlb] *_board` timeouts
(~220 users each), `[wallet-backfill-allday] upsert err` (1,826), the 300s Vercel runtime timeout
(3,897 / 403 users). **None of it is reaching Sentry.**

## What is NOT the cause — each ruled out, not assumed

- **Not a code change.** `git log --since=2026-08-18` over `*sentry*`, `instrumentation*` and
  `next.config*` is **empty**. The four init files are byte-identical to what was live on 08-18.
- **Not a missing server DSN.** `sentry.server.config.ts` and `sentry.edge.config.ts` hardcode the
  DSN as a literal — there is no env var to have been unset. (`sentry.client.config.ts` *does* read
  `NEXT_PUBLIC_SENTRY_DSN`, so a browser-side outage could be env-driven; the server side cannot be.)
- **Not an `enabled` gate.** Only the client config carries one (`NODE_ENV === "production"`). The
  server and edge configs have none.
- **Not "the errors stopped."** See the control above.

## What the cause most likely IS — and why I cannot confirm it from here

The intact-code + silent-ingest shape points **upstream of the app**: an org-level quota exhausted,
or spike protection engaged. The volume makes that easy to believe — issue
`JAVASCRIPT-NEXTJS-26` alone logged **2,718 events in six days**, and Vercel's 24h picture is
thousands more.

⚠ **I am naming this as the leading hypothesis, not a measurement.** Confirming it needs the Sentry
org's **Stats / Usage page** (dropped-vs-accepted event counts and the quota bar), which is an
operator surface — the MCP exposes issues and events, not billing. **Do not record the cause as
settled until someone reads that page.** If accepted events flatline against a full quota bar on
08-18, it is confirmed; if the quota has headroom, the cause is something else and this filing's
conclusion needs re-deriving, not patching.

## Why this outranks most of the open register

CLAUDE.md already states the rule this violates: *"A permanently-red or permanently-zero instrument
is indistinguishable from a broken one at a glance — check the LOG, not the badge, and **prove a
watcher can see a FAILURE** before relying on it."* Sentry has been the assumed watcher for the
honest-degradation paths. For 4½ days it has been unable to see anything, so:

- every `apiErrorResponse()` / `summarizeDegraded()` capture since 08-18 went nowhere;
- **a NEW defect shipped in that window would have produced exactly the same silence** as a healthy
  week. This is the "alert" sub-class from the honesty canon — *its output is silence, so the error
  is unfalsifiable* — applied to the alerting system itself.

## The second-order finding, which is the actual fix

⚠ **If the cause is quota, the chronic saturation noise is what spent it.** The honest-degradation
paths fire on every `57014` and every pool-acquire timeout, and the DB saturates daily by design of
the current instance size. That is thousands of events a day describing **one already-documented,
already-triaged condition** — and it crowds out the novel error the reporter exists to catch.

So the durable fix is not "raise the quota". It is to stop paying full price for a condition already
tracked elsewhere:

1. A `beforeSend` that collapses the chronic classes — Postgres `57014`, `Timed out acquiring
   connection from connection pool`, `rpc … timed out after 45000ms` — to **one representative event
   per class per window**, rather than one per request.
2. ⚠ **Suppression must be BOUNDED and VISIBLE, or this becomes the very defect it is fixing.**
   Whatever is dropped must still be counted somewhere a human reads (the sampled event's own tags,
   or the existing `pipeline_runs` / trust-board path). Dropping to silence would replace a dark
   reporter with a lying one.
3. ⚠ **Do NOT filter on the message text of a whole route.** The chronic classes are identified by
   SQLSTATE / a fixed transport phrase; a route-level filter would also swallow a genuinely new
   failure on the same route.

## Recommended next step, in order

1. **Operator:** open Sentry → Stats/Usage, read accepted vs dropped for 08-18 onward. That single
   page decides whether the cause above is right.
2. **Prove recovery with a positive control, never with a quiet dashboard.** After whatever fix:
   deliberately emit one uniquely-tagged test error and confirm it appears. ⚠ "Events started
   arriving again" is not the same claim as "this reporter can see a failure", and only the second
   one is worth relying on.
3. Then ship the `beforeSend` sampling above, so the next spike does not re-spend the quota.

---

## ADDENDUM 2026-08-22 23:35 PT (2026-08-23 06:35Z) — re-measured 3h45m later, and the one hypothesis that would have made this go away is dead

**Re-measured rather than assumed, because a filing is a dated sample.**

| | reading |
|---|---|
| Sentry, `errors` dataset, last **24h**, sorted `-timestamp` | **no results** |
| Sentry, per-day counts, last **14d** | **no results** |
| Newest Sentry error event, project-wide | still **2026-08-18T13:21:59Z** |
| Vercel, `/[collection]/edition/[slug]`, last 24h | `[edition] market_bundle canceling statement due to statement timeout` — **172 events, 135 users, last 2026-08-23T06:35:02Z** |

**Sentry has now been dark for ~4 days 17 hours**, and the control is not stale: production threw that
error **in the same minute this reading was taken**. The same 24h window carries `get_edition_detail`
timeouts at 250 events / 40 users, `get_edition_recent_sales` at 114 / 84, and a dozen more — on ONE
route.

⚠ **The "it may have already self-resolved" possibility is now DEAD, and it was the only reading under
which this could be left alone.** Two independent observations 3h45m apart, both zero, against a
control that moved. Nothing about the original diagnosis changes; what changes is that waiting is no
longer a defensible option.

⚠ **Still NOT established, and still needs the operator:** whether the cause is quota exhaustion. That
remains the leading hypothesis on the intact-code + silent-ingest shape, and it is still only readable
from the Sentry org's **Stats / Usage** page (accepted vs dropped), which the MCP does not expose.
**Do not record the cause as settled from this addendum** — it extends the duration, not the
attribution.

⚠ **And the recovery test is unchanged:** prove a watcher can see a FAILURE. Emit one uniquely-tagged
error and confirm it lands. "Events started arriving again" is a different claim from "this reporter
can see a failure", and only the second one is worth relying on.

---

## ADDENDUM 2026-08-23 08:2x PT — a THIRD hypothesis with the identical shape, and the MCP limit is now verified rather than asserted

**Read-only. Nothing was changed in Sentry.**

⚠ **The "MCP does not expose it" claim above is now MEASURED.** I searched the Sentry MCP tool catalog
for usage/stats/quota/rate-limit operations. It returns organisations, projects, issues, events, DSNs,
alert rules, monitors and snapshots — **there is no stats, usage, or quota tool of any kind**. So the
accepted-vs-dropped question genuinely cannot be answered from here, and the operator step stands.

🚨 **But the filing lists only TWO causes for the intact-code + silent-ingest shape (org quota, spike
protection), and there is a THIRD that produces it exactly and is checked on a different page:**

- **A per-DSN rate limit**, or **a deactivated client key.** `find_dsns` shows this project has
  **exactly one** key ("Default"). With a single key, a rate limit or an `isActive: false` on it takes
  **every** lane dark at once — server, edge and browser — which is precisely what was measured. ⚠ It
  also explains something the env-var hypothesis cannot: the server and edge configs hardcode the DSN,
  so their silence has to come from the ingest side, and a key-level limit is ingest-side.
- ⚠ **The read-only DSN listing does NOT return `isActive` or the rate-limit fields**, so this cannot be
  settled from the MCP either. It is one page from the quota bar in the UI: **Settings → Client Keys
  (DSN) → the key's rate limit, and whether it is enabled.**

**So the operator checklist is now two items on one visit, not one:**
1. **Stats / Usage** — accepted vs dropped from 08-18 onward; a flatline against a full bar confirms quota.
2. **Settings → Client Keys** — is the single key **active**, and does it carry a **rate limit**?
   If either is set, that is the cause and the quota reading will show headroom rather than a wall.

⛔ **What I deliberately did NOT do.** The MCP exposes `update_dsn`, which can clear a rate limit or
re-activate a key. **Firing it blind would have been a mutation of the production error reporter on an
unconfirmed diagnosis — and worse, it would have destroyed the evidence that attributes the outage.**
The two readings above cost one page-load each and settle it; guessing costs the attribution.

⚠ **The recovery test is unchanged and still the point:** after any fix, emit one uniquely-tagged error
and confirm it lands. *"Events started arriving again"* and *"this reporter can see a failure"* are
different claims, and only the second is worth relying on.

---

## ⏳ RE-DERIVED 2026-08-24 ~22:15 PT (2026-08-25 05:15Z) — STILL DARK, and the boundary has not moved by one second

**Checked independently through the Sentry API rather than re-read from this filing.** Newest event of any level, whole project:

**`2026-08-18T13:21:59+00:00`** — byte-identical to the timestamp above. The outage now stands at **6 days 15 hours**.

- `search_issues` over a 90-day window returns **6 unresolved issues, every one with `lastSeen` 6 days ago**; a 48-hour window returns **nothing at all**.
- The six are the same entity-page RPC-timeout family (`get_edition_detail` 2,898 events, `get_team_detail` 1,039, `get_player_editions` 134, `get_set_detail` 99, `get_player_detail` 260, `get_team_players` 9) — i.e. **the last thing Sentry saw is unchanged too**, not merely the last time it saw something.

⚠ **THE POINT OF RE-DERIVING: "it has probably resolved by now" is the default assumption about an outage nobody is watching, and it is false here.** Nothing self-healed. The two one-page-load readings this filing asks for (Stats/Usage, Client Keys) are **still the open action** and still cost the same.

⛔ **I could not run them.** The Sentry MCP surface available in this session exposes issue/event search but **no organization stats or DSN/key tooling**, so the quota-vs-rate-limit discriminator remains operator-only. Searched the tool catalogue explicitly rather than assuming.

✅ **The app-side elimination is now STRONGER, not weaker.** The 08-24 double-init filing established that production runs turbopack, so the live client init is the one with a **hardcoded DSN** — `NEXT_PUBLIC_SENTRY_DSN` is inert and no env change can silence any runtime. Nothing shipped on 08-24 (five honesty fixes across `/api/fmv`, `/api/profile/**`, pack-sniper) touched Sentry configuration.

⚠ **AND THE CONSEQUENCE IS CONCRETE, not abstract: every fix shipped on 08-24 had to be verified through VERCEL RUNTIME LOGS, because the error reporter cannot see them.** Two of them were caught working in production that way (`/api/fmv/demo` returning 503 instead of a fabricated `sampleCount: 0`; `/api/profile/tier-breakdown` returning 503 on a `57014`). **That worked — but it is a manual read of a log stream, not an instrument, and it does not scale past a session that goes looking.**

🚨 **The structural gap this exposes is the one #25 already names, one level out: nothing watches the WATCHER.** A detector going red is surfaced by nobody (#25); an error reporter going *silent* is worse, because silence is its healthy state's appearance. **Six days is how long that takes to notice by accident.** ⛔ A sentinel arm for "Sentry accepted zero events in N hours" would close it and is blocked on the same secrets decision as #25's GitHub arm — a Sentry token in Vercel env.
