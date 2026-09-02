# The deploy tool's *safe* default was the outage — and a green pipeline proved nothing about the secret

**Filed 2026-09-02 00:45Z (2026-09-01 17:45 PT) · cloud autonomous pass · edge-function drift sweep**

Two findings from redeploying the drifted edge fleet. Both are about an instrument reading green while
saying nothing about the thing you care about.

---

## 1. `deploy_edge_function` hardens a function when you say nothing

`mcp__Supabase__deploy_edge_function` declares `verify_jwt` as **required, default `true`**, and its own
description urges you to enable it. Omit the field and the deploy **succeeds** — and flips the function
from `verify_jwt: false` to `true`.

Every gate-keyed RPC edge function runs with `verify_jwt: false` and does its own auth (an
`INGEST_SECRET_TOKEN` bearer header, or a `?key=` gate). Turning JWT verification on puts the Supabase
gateway in front of the handler, so **every existing caller 401s before the function's own code runs**.

The nasty part is the reporting. **A 401'd edge function writes no `pipeline_runs` row.** So the failure
mode is not an error anywhere — it is a function that quietly stops appearing in its own instrument and
reads as *dormant*. That is precisely the shape of the 2026-08-12 break (~40 h silent outage on
`backfill-topshot-pack-supply`), reached by a completely different route: that one shipped a gate without
its secret, this one would have shipped a gate the callers cannot satisfy.

**It cost nothing, and the reason is procedural, not clever.** The rehearsal target was picked to be the
quietest thing in the fleet — `seed-topshot-pack-distributions`, no cron caller, no in-repo caller, zero
runs in seven days. The response came back `verify_jwt: true`, the mistake was visible in one field, and
it was repaired in the same minute. Starting with `pinnacle-nft-resolver` (**854 runs / 7 days**) would
have made it a live outage discovered by absence.

> **Rehearse a fleet-wide mechanical change on the quietest instance.** Not on a copy, not in staging —
> on the real fleet's least-trafficked member, where the blast radius of an unknown-unknown is zero.
> The value is not that the rehearsal *tests* anything; it is that it makes the first unknown cheap.

Pass `verify_jwt: false` explicitly on every deploy, and **read it back off the response** rather than
assuming the request was honoured.

---

## 2. A green `pipeline_runs` can prove the opposite of what it looks like

Two functions were left for Trevor because they are gate-keyed and their deploy is genuinely two-part.
The obvious sanity check argues they are *fine*: `ingest-pinnacle-mints` logged **2,726 runs / 2,726 ok**
in seven days, `compute-golazos-pack-ev` **12 / 12**. If the gate secret were missing, surely they would
be failing?

No. A redacted-report subagent read the deployed sources and found that **both deployed builds gate on a
hardcoded string literal compiled into the deployed artifact**, while repo HEAD reads
`GOLAZOS_PACK_EV_GATE_KEY` / `PINNACLE_MINTS_GATE_KEY` from the environment and **fails closed when
unset**. The green runs prove that *cron's `?key=` matches the literal in the old build*. They say
nothing whatsoever about whether the secret exists — and deploying repo HEAD without setting it first is
the 08-12 break, exactly.

**The generalisation:** when the deployed artifact and the repo disagree about *where a credential comes
from*, health telemetry from the deployed artifact cannot be evidence about the repo version. The
instrument is measuring a different program.

Two supporting notes, both from the skill's own §2 precondition, run without ever selecting a key value
(length, prefix, md5 only): all three crons pass `^rpc_pls_` and none is an unsubstituted placeholder —
and jobs **83 and 84 share one key**, so one secret covers both. Their key lengths are **26 and 28**, not
the 40-char rotated form, meaning these are still the publicly-burned originals. Setting the secret to
"whatever cron already sends" would restore parity by **re-installing a compromised credential**. Since
repo HEAD supports the `_OLD` dual-accept pattern, the same operator visit can do a real rotation with no
window instead. That is what the handoff now asks for.

---

## 3. A smaller one, for the trap collection

`ingest-pinnacle-mints` first read as a live silent outage: crons 83/84 firing **2,576 times in 3 days**
and **zero** `pipeline_runs` rows. It was my query. The function self-logs as
`ingest-pinnacle-mints-forward` and `ingest-pinnacle-mints-backfill` — never its own slug.

**Enumerate the `pipeline:` literals in a function's source before concluding anything from an empty
`pipeline_runs` result.** An empty result is equally consistent with "it is not running" and "I asked
for a name nothing writes", and only one of those is an incident.

---

**Net:** PROVEN import-map drift **18 → 2**, the 2 remaining being exactly the ones that need a secret
set before they can be deployed. `edge-fn-drift` should stop driving the Pipeline Sentinel to CRITICAL
on the tier-1 arm; the tier-2 content census still needs a Management PAT to run at all.
