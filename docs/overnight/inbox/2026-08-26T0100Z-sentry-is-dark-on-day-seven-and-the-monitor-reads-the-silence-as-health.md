# 🚨 Sentry is dark on DAY SEVEN — and the monitor has been reading that silence as a clean bill of health

**Filed 2026-08-25 ~17:55 PT (2026-08-26 00:55Z), Claude Code interactive.** Third re-measurement of
[the 08-23 filing](2026-08-23T0250Z-sentry-has-received-nothing-since-08-18-while-production-throws-the-same-error-hundreds-of-times-a-day.md)
and [its addendum](2026-08-23T1930Z-sentry-went-dark-at-a-precise-minute-and-the-burst-before-it-is-the-defect-fixed-today.md).
**The attribution is unchanged and still operator-gated. What is NEW is the duration, two negatives I
VERIFIED rather than inherited, and a second-order defect that is mine to fix and is now fixed.**

---

## 1. The re-measurement, with the control taken in the same minute

| | reading |
|---|---|
| Newest Sentry error event, project-wide (`rip-packs-city/javascript-nextjs`) | **still 2026-08-18**, `last seen 7 days ago` on all six issues |
| Sentry, `lastSeen:-48h`, 7-day period | **no issues found** |
| Vercel runtime errors, same project, last 24 h | **50 error groups**, newest `2026-08-26T00:50:37Z` |

⚠ **The control moved in the minute the reading was taken**, which is what makes this structural
rather than a quiet week: `[candy-mlb] candy_scarcity_board error` last fired **00:50:37Z**, the 300 s
runtime timeout **2,666 events / 266 users** last at **00:35:42Z**, `[wallet-backfill-allday] upsert
err` **1,138 events**, `[pack-detail] pack_realized_ev` **111 / 77 users**. **None of it is reaching
Sentry.**

**Duration: ~7 days 11 hours**, up from the 4 d 17 h in the 08-23 addendum. Three independent
observations across three days, all zero, against a control that moved every time.

## 2. 🚨 THE SECOND-ORDER DEFECT, AND IT IS THE ONE WORTH KEEPING

**The daytime monitor has been logging the darkness as health.** Both 08-25 monitor filings record,
under *"all known / already-filed — continuity only"*:

> ✅ Healthy and unaffected: security 0/0, Vercel last prod deploy READY, **no new Sentry issues in 24h**.

On day seven of a twice-filed outage, a zero from a dark reporter was written down in the **healthy**
column. That is CLAUDE.md's own rule — *"a permanently-red or permanently-zero instrument is
indistinguishable from a broken one at a glance"* — happening to the alerting system itself, and then
being mis-read by the very sweep that exists to catch it.

⛔ **The cause is a gap in the skill, not carelessness.** `rpc-nightly-autonomous-pass/SKILL.md` §2
says *"Run security invariants, `detect_stalled_pipelines`, `get_pipeline_alerts`, trust health,
**Sentry**, and Vercel runtime logs. **Then distrust each**"* — and then lists a distrust bullet for
`public_board_slow_count`, cache-STALE pages, `cron.job_run_details.status`, trust-precompute
freshness, failures-only denominators and `pipeline_runs` retention. **Six instruments named, and
Sentry is not one of them.** A pass following the skill exactly has no instruction that a Sentry zero
needs a corroborator, so it reads it as the good news it looks like.

✅ **FIXED IN THIS TURN** — a seventh bullet, with the discriminator stated as a pair of readings
rather than a warning: *a Sentry zero is only health when the Vercel 24 h error groups are ALSO near
zero; a zero on one against 50 groups on the other is a DARK REPORTER.* Promoted to
`docs/reference/testing-and-ci.md` as well, so it outlives the skill file.

## 3. Two negatives I VERIFIED rather than inherited — both save the next session an attempt

The prior filings said the cause needs the Sentry org's **Stats / Usage** page and that the MCP does
not expose it. I did not re-read that; I re-tested it.

- ✅ **CONFIRMED: the MCP has no usage/quota surface.** Searched the tool catalogue directly
  (`search_sentry_tools`, query *"organization stats usage quota accepted dropped outcomes"*, limit
  12). Every result is orgs / monitors / snapshots / issue-notes / projects / teams / DSNs / alert
  rules / uptime. **There is no stats, usage, outcomes or billing tool.** The filings' claim stands,
  now on a check rather than an assumption.
- ⛔ **NEW, and it closes the obvious workaround: the ingest-endpoint probe CANNOT be run from a
  cloud sandbox.** The decisive test — POST one envelope at
  `.../api/<project>/envelope/` and read the status, since a **429 with
  `X-Sentry-Rate-Limits` would confirm quota and a 202 would refute it** — returns:

  ```
  HTTP_STATUS: 403 Forbidden
  BODY: Host not in allowlist: o…….ingest.us.sentry.io.
        Add this host to your network egress settings to allow access.
  ```

  ⚠ **That 403 is the AGENT PROXY's, not Sentry's, and it must not be read as a Sentry signal** —
  CLAUDE.md's *"diagnose from the ERROR STRING, not from the fact that it failed"*, which here is the
  difference between "the sandbox cannot reach the host" and "Sentry refused the event". **It says
  nothing about the quota hypothesis.** The probe is still the right test; it needs an egress
  allowlist entry for the ingest host, or a run from Trevor's box, where it is a one-command answer.

## 4. What is STILL not established — unchanged, and deliberately not patched over

**Whether the cause is quota exhaustion.** It remains the leading hypothesis on the intact-code +
silent-ingest shape, and it is still readable only from Stats / Usage (accepted vs dropped vs
filtered) or from the ingest probe above. ⛔ **Do not record the cause as settled from this filing
either** — it extends the duration and closes two side-branches; it does not attribute.

⚠ **And the recovery test is unchanged and is the whole point:** *prove a watcher can see a FAILURE.*
Emit one uniquely-tagged error and confirm it lands. "Events started arriving again" is a different
claim from "this reporter can see a failure", and only the second one is worth relying on.

## 5. Operator next steps, in order — two commands, then a decision

1. **Sentry → Stats / Usage**, 08-18 onward: accepted vs dropped. A flatline against a full quota bar
   confirms it; headroom refutes it and the diagnosis needs re-deriving, not patching.
2. **Or, equivalently and faster, from a box with egress:** send one envelope and read the status
   line. `429` + `X-Sentry-Rate-Limits` = quota. `202` = the org accepts events and the app is not
   sending, which is a completely different (and worse) investigation.
3. Only then the `beforeSend` sampling the 08-23 filing specifies — **bounded and visible**, keyed on
   SQLSTATE / fixed transport phrases, never on a route's message text.

⚠ **One related item stays deferred for the same reason and should NOT be picked up first:** the
[two-client-init filing](2026-08-24T1510Z-there-are-two-client-sentry-inits-and-which-one-wins-depends-on-the-bundler.md)
deferred its fix because it *"wants a live Sentry to verify against"*. **That exit condition is
re-tested here and still not met.** Consolidating the inits while ingest is dark would ship a change
whose entire observable effect — `environment`, `release`, replay on client events — is unverifiable,
and would put a Sentry-shaped edit in the blast radius of an outage nobody can yet see into.
