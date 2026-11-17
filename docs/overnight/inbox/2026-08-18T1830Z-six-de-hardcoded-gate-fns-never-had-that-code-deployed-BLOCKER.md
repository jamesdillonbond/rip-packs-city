# Six of the eight "de-hardcoded" gate functions never had that code deployed — their secrets are inert

**Filed:** 2026-08-18 ~18:30Z · **Class:** BLOCKER, and a correction of my own plan from ~40 min earlier.
**Re-derived:** 2026-08-18T19:19Z — every figure below reproduces exactly (see "Re-derivation" at the end).

## ⛔ Do not rotate cron jobs 20, 55, 56, 83, 84, 44

I told Trevor these were "six easy rotations — mechanical, each independently verifiable, you just
paste." **That was wrong, and rotating them would have produced a fail-closed 403 on every tick** —
the exact 86 h / 4.5 d silent-outage shape already twice in this record.

## The error in my reasoning

I chained three links and only checked two:

1. the secret exists in Supabase (✅ verified — Trevor's secrets list)
2. the **repo** source reads that secret (✅ verified — `Deno.env.get("<FN>_GATE_KEY")`)
3. → therefore the **deployed** source reads that secret (❌ **never checked**)

Link 3 does not follow, and in six of eight cases it is false. This is the same shape as the
`get_unmapped_resolver_targets` orphan error yesterday: asserting a consumer exists because the
producer's properties look right.

## What is actually deployed

`e66884f79` — *"fix(edge): dual-accept gate keys so the owed rotation has no broken intermediate"* —
landed the secret-reading + `_OLD` dual-accept shape for eight functions at **2026-08-12T03:57Z**
(committed `2026-08-11T20:57:51-07:00`). Deploy times against that line:

| function | last deployed | deployed >= 08-12T03:57Z? | cron jobs | key len |
|---|---|:--:|---|--:|
| `backfill-topshot-pack-supply` | 2026-08-15T18:10Z | ✅ | 15, 16 | **40** ✅ rotated |
| `compute-pinnacle-pack-ev` | 2026-08-15T20:27Z | ✅ | 42 | **40** ✅ rotated |
| `ingest-allday-pack-opens` | 2026-08-07T17:56Z | ❌ | 20, 55 | 27 |
| `ingest-topshot-pack-opens-history` | 2026-08-07T17:17Z | ❌ | 56 | 27 |
| `ingest-pinnacle-mints` | 2026-07-30T01:00Z | ❌ | 83, 84 | 28 |
| `compute-golazos-pack-ev` | 2026-07-18T15:36Z | ❌ | 44 | 26 |
| `backfill-pack-opens-api` | 2026-08-11T00:30Z | ❌ | *(none)* | — |
| `backfill-allday-pack-supply` | 2026-08-11T00:33Z | ❌ | *(none)* | — |

⚠ `backfill-pack-opens-api` and `backfill-allday-pack-supply` are **also stale**, by ~3.5 h. That is
the kind of near-miss that reads as "done" in a summary.

## 👉 The corroboration that makes this more than a timestamp argument

**The only two crons carrying a rotated 40-char key are the only two functions deployed after
08-12.** Two independent facts, never wired together before now, agreeing exactly: a rotation
succeeded precisely where the deployed code could read a secret, and nowhere else. That is not how a
coincidence behaves.

## Independent proof for two of the six (does NOT rest on `updated_at`)

`compute-golazos-pack-ev` and `ingest-pinnacle-mints` are deployed with **`import_map: false`**, yet
their repo sources import `@supabase/supabase-js` by **bare specifier**, which cannot resolve without
`supabase/functions/deno.json`. Had the repo source been deployed, they would **boot-fail**. They are
not boot-failing (jobid 84 dispatches every 2 min; 0 × 403 in 6 h). Therefore deployed ≠ repo, proven
without reference to any timestamp. This is `edge-fn-drift-checker`'s "proven" class — 31 functions —
landing for the first time on a load-bearing operational conclusion rather than a fleet statistic.

## ⚠ Measurement limits, stated plainly

- `updated_at` proves **when** the deployed source last changed, not **what** it contains. For the
  four with `import_map: true` the "deployed ≠ repo" claim rests on the timestamp alone.
- Positive control that `updated_at` tracks deploys at all: `resolve-allday-rip-dist-api` reads
  `2026-08-18T15:03Z`, matching a deploy I performed and timed myself.
- **I deliberately did NOT read the six deployed sources.** Fetching them pulls a live gate literal
  into a transcript — the leak vector this project's own runbook amendment (2026-08-18) names. The
  cheap certainty was available and I declined it on purpose.
- It remains *possible* a pre-08-12 hand-deploy read a single-key secret. It cannot have read `_OLD`,
  because that shape did not exist before `e66884f79`.

## The path that works — it is the one already proven on jobid 26

Do not deploy the repo source to these six. **Open question gating that cheaper route:** 6 of the 8
are deployed **with** an import map, but the one deploy I made through the Supabase MCP came back
`import_map: false`. If MCP deploy cannot attach `deno.json`, deploying repo source to a
bare-specifier function **boot-fails it** — turning a working stale function into a dead one.

The proven sequence (jobid 26, today) sidesteps that entirely, because it deploys the *deployed*
source with one token changed:

1. Trevor pastes the function's deployed source **with the gate literal redacted** (exactly as he did
   for `resolve-allday-rip-dist-api`).
2. I de-literalise it to `Deno.env.get("<FN>_GATE_KEY")` + `_OLD`, commit it, deploy it.
3. Trevor sets `<FN>_GATE_KEY` to the **current** cron key (untranscribed copy-out) → **zero
   outage**, because the key in `cron.job` does not change.
4. *Then* rotate, with the `_OLD` window available and a revert path that exists.

Step 3 is the part worth keeping: separating "make the secret live" from "change the key" means the
rotation stops being a flag-day. Every previous attempt merged them, which is why the exposure window
existed at all.

## ✅ Closed by the same work: jobid 26 is verifiably healed on live cron traffic

Not just my manual probe. `net._http_response` at minute :17:

| tick | result |
|---|---|
| 13:17:30Z | **403** `{"error":"forbidden"}` — my rotation, secret not yet set |
| 14:17:37Z | **403** `{"error":"forbidden"}` |
| 15:17Z | no dispatch — pg_cron `job startup timeout` |
| 17:17:34Z | **200** `{"note":"none"}` |
| 18:17:31Z | **200** `{"note":"none"}` |

The outage was exactly two ticks. ⚠ `cron.job_run_details` reports **`succeeded`** for both 403 ticks
— dispatch ≠ outcome. Anyone auditing this from `job_run_details` alone would have recorded a clean
run through the outage.

---

## Re-derivation (2026-08-18T19:19Z, independent session)

Re-ran `list_edge_functions` and converted every `updated_at` epoch against the `e66884f79` cutoff
(`2026-08-12T03:57:00Z`). **All eight rows reproduce to the minute**, as does the positive control
(`resolve-allday-rip-dist-api` = 2026-08-18T15:03:41Z).

The `import_map` split also reproduces exactly, and it is the load-bearing half: the **only two**
functions of the eight deployed with `import_map: false` are precisely `ingest-pinnacle-mints` and
`compute-golazos-pack-ev` — the two the boot-fail argument names. The other six are `import_map: true`.
That is an independent instrument agreeing with the timestamp argument, not a restatement of it.

Also re-confirmed: the repo copy of `supabase/functions/resolve-allday-rip-dist-api/index.ts` is
committed at `b70d4582` and contains **no gate literal** — only `Deno.env.get(...)` for both keys.

**Unchanged conclusion: ⛔ do not rotate jobs 20, 55, 56, 83, 84, 44.**
