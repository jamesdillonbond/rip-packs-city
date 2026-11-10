---
name: "rpc-edge-fn-deploy"
description: "Deploy or rotate keys on a Rip Packs City Supabase edge function. Triggers on \"deploy an edge function\", \"rotate a gate key\", \"the cron is 403ing\", \"set a GATE_KEY secret\", or any change to supabase/functions/**."
---

# RPC edge-function deploy & gate-key rotation

Project `bxcqstmqfzmuolpuynti`. Edge functions under `supabase/functions/**` run `verify_jwt=false`
and are called by pg_cron via `net.http_get`. Since 2026-10-13/14 **every pg_cron-dispatched
function is gated by the shared Vault gate** (§0); the env-secret and literal gates below are
LEGACY, kept for the few uncronned functions that still carry them and for the history.

**This skill exists because a single half-done deploy caused a ~40-hour silent outage.**
Read §0 and §1 before touching anything.

---

## 0. ⭐ READ FIRST — the Vault gate (2026-10-13/14). §2–§3 are LEGACY.

**One secret, read by both sides.** pg_cron sends `public.cron_gate_key('<fn>')` (SECURITY DEFINER,
reads Vault secret `cron_gate_key__<fn>`; service_role/postgres only) in the **`x-rpc-gate-key`
header**, and the function checks it with `supabase/functions/_shared/cron-gate.ts`:

```ts
import { cronGate } from "../_shared/cron-gate.ts"
const gateDenied = await cronGate(req, sb, "<own-slug>")   // header first, then ?key=
if (gateDenied) return gateDenied                           // 403 forbidden · 503 gate_unavailable
```

- **Three outcomes, never two:** `ok` · `denied` (no key / wrong key → 403) · `unavailable` (the Vault
  read FAILED → 503 + `retry-after`). A DB blip must not look like a rotation mistake.
- **Each function passes its OWN slug** (pinned by `__tests__/edge-fn-no-hardcoded-gate-keys.test.ts`).
  No env `*_GATE_KEY` is read; there is no dashboard step.
- **An operator script can use the gate too:** it POSTs `rest/v1/rpc/cron_gate_key` with the service-role
  key it already has and sends the result in the header — nobody copies a key (see
  `scripts/refresh-ipfs-catalog.mjs`). A new secret is created in SQL with `vault.create_secret(...)`
  (migration `20261014155620`); take any digest ONCE into a variable — calling `cron_gate_key()` inside a
  counting subquery raised "no vault secret" in the same transaction and rolled the apply back.
- **State 2026-10-14 ~10 AM PT (re-derive before quoting):** 16 functions on the Vault gate (15 cron lanes +
  `ipfs-catalog-loader`, whose operator script reads its key at run time via `cron_gate_key()` with the
  service-role key); **20 pg_cron jobs send the header, 0 send `?key=`**; all Vault gate keys generated in SQL
  and distinct (migrations `20261013143723`, `20261013144028`, `20261014135331`, `20261014155620`). **No
  function with a caller holds a credential literal.** Seven 410 tombstones (`sync-nba-games` + the six R21
  retirements; sources archived redacted in `supabase/retired-functions/`). Still legacy, uncalled:
  `backfill-allday-pack-supply` and `backfill-pack-opens-api` (env gate, no cron, no Vault secret). The old
  env `*_GATE_KEY` secrets are unread; deleting them in the dashboard is optional hygiene.

### Retiring a function nobody calls (proven 2026-10-14 on six)
1. **Census every caller source** — pg_cron (`cron.job.command ILIKE`), repo (`git grep` app/lib/scripts/
   .github/vercel.json/workers), and `function_edge_logs` by `request.pathname` (never `request.url` — it
   holds keys) over 24 h, **with a positive control** (a known-active slug in the same query). cron-job.org
   and anything slower than daily are invisible to that window — the 410 is what surfaces them.
2. Recover the deployed source through the redacted subagent; archive it as
   `supabase/retired-functions/<slug>/index.ts.txt` (`.txt`: no walker, type-checker or deploy picks it up)
   with a header that is the revival recipe.
3. Replace `supabase/functions/<slug>/index.ts` with a stub that imports nothing, reads no env and answers
   `410 {"error":"retired", ...}` (copy `sync-nba-games`). The reachable-tests ratchet exempts it by property
   (`isRetiredTombstone`); the drift checker's tier-1 `inapplicable` list is a dated pin — re-pin it.
4. Full suite, deploy, anonymous probe → 410, and note those probe hits so a later 410 watch can tell them
   from a real caller.

### Rotating a Vault-gated lane — ONE in-database step, nothing ever read out
```sql
SELECT vault.update_secret(id, 'rpc_pls_' || encode(extensions.gen_random_bytes(16), 'hex'))
FROM vault.secrets WHERE name = 'cron_gate_key__<fn>';
```
Cron and function move together, so there is no window. In a migration, mirror `20261013144028`:
assert by digest + shape (`^rpc_pls_[0-9a-f]{32}$`) only, then a **negative control** — capture the
OLD value into a plpgsql variable before the update, replay it via `net.http_get` with the header,
store ONLY the request id (`audit_20261013_rotation_control`), and confirm `403 {"error":"forbidden"}`.
Then the **positive control**: fire each job's own command (below) and read `pipeline_runs` /
`net._http_response`. ⚠ `apply_migration` assigns its OWN version timestamp — read
`supabase_migrations.schema_migrations` afterwards and rename the committed file to match.

### Moving a legacy function onto the Vault gate (the R21 recipe, proven 10-13/14)
1. **No committed source?** Recover it through a **redacted subagent**: it `get_edge_function`s the slug,
   writes the files to the scratchpad with the gate literal replaced by `__REDACTED_GATE_LITERAL__`, and
   reports only lengths / first-4 chars / env NAMES / imports. The value never enters the transcript.
   ⚠ The subagent copies by hand — **read every line** before trusting it.
2. Replace the gate with `cronGate(req, sb, "<slug>")`; use the bare `@supabase/supabase-js` specifier
   (an `esm.sh` URL leaves `edge-fn-drift` unable to classify the function). Fix honesty defects you
   find while there (unread `error`s, `?? 0`, a failed read answered as "done").
3. **Run the FULL vitest suite, not a targeted set** — a NEW function file joins every tree-walking guard's
   population (10-14: `get-fmv-for-editions-is-chunked-under-max-rows` red-CI'd a push a targeted run
   passed). Plus `deno check`/`deno lint` and the Deno harness (§4) — it auto-discovers the new function,
   and its failed-run rule wants a non-2xx or an ok=false row when everything failed.
4. Commit, push, deploy via `edge-fn-deploy.yml` (§4). The cron already sends `cron_gate_key('<fn>')`,
   whose value equals what the old build accepted, so the deploy needs no secret step.
5. Verify as the real caller, then a migration moves the job to the header and rotates (as above).

- 🔎 **The 403 instrument is `net._http_response.status_code` + `content`** — a 403'd function writes NO
  `pipeline_runs` row and `cron.job_run_details` still says `succeeded`. ⚠ **Read `content`:** a
  `<!DOCTYPE html>…Just a moment` 403 is a third party's Cloudflare challenge (e.g. Atlas), not our gate —
  our gate answers `{"error":"forbidden"}`.
- 📌 **Deploy the lane with the FASTEST tick first**: the feedback loop is the cost of being wrong.
- ✅ **Verify without waiting for a tick:** fire the job's own command so the key is never echoed —
  `do $$ declare c text; begin select command into c from cron.job where jobid = <j>; execute c; end $$;` — then read
  `pipeline_runs` (or `net._http_response` for a lane that writes no run row). For a function with no cron
  job, probe from SQL with the header built there:
  `net.http_post(url, body, headers := jsonb_build_object('x-rpc-gate-key', public.cron_gate_key('<fn>')))` —
  send a body the handler rejects (e.g. an empty batch → 400) so the probe proves the gate and writes nothing.
- ⛔ **A gate key is `rpc_pls_` + 32 hex.** Never a password-manager generator: characters outside
  `[A-Za-z0-9_-]` break a `?key=` URL (`&` ends it, `#` truncates it) — the 6 h 38 m Pinnacle outage, 09-20.

### Superseded 2026-09-21 → 10-13: the `rotate_cron_gate_key` rotator (kept for history)
`rotate_cron_gate_key(p_jobids int[], p_new_key text)` (SECDEF, migration `20260921004437`) rewrote the
`?key=` of named jobs from a token-gated rotator edge function reading an allow-listed env secret. It is
obsolete for Vault-gated lanes — rotate the Vault secret instead. Its two helper functions,
`zz-gate-rotate` and `zz-gate-diag`, were confirmed 410 tombstones on 2026-10-14.

## 1. ⛔ (LEGACY env gate) A deploy of a gate-keyed function is a TWO-PART change

⭐ **Does not apply to a Vault-gated function (§0)** — there is no secret to set. It still applies to any
function that reads `*_GATE_KEY` from env; `edge-fn-deploy.yml` refuses those unless `gate_secret_is_set`.

Shipping the code without the secret **looks like success in the deploy log** and fails
closed on every subsequent call.

The 2026-08-12 break, dated to the minute: `backfill-topshot-pack-supply` v25 deployed at
04:16:26Z shipped the env-var gate while `TOPSHOT_PACK_SUPPLY_GATE_KEY` was never set. With
the secret unset the constant is `""` and the hardening correctly rejects everything. Last
successful write 03:33:08Z; 403s on every tick for ~40h; nobody noticed because a 403'd
edge function writes **no** `pipeline_runs` row.

**It happened AGAIN 39 days later, and the tell was the same:** `ingest-pinnacle-mints` v22→v26
deployed 11:30–11:40 AM PT 2026-09-20 (the env-gated repo build) while `PINNACLE_MINTS_GATE_KEY` did
not match what jobids 83/84 send. `{"error":"forbidden"}` on every dispatch from 11:40; last
`pipeline_runs` row 11:42; pg_cron logged `succeeded` throughout. The sentinel's `pg_net_http_403`
row fired but says "WHICH ENDPOINT IS UNKNOWN" — **attribute it by TIMING against `cron.job`
schedules (even minutes = the `*/2` job) or by `function_edge_logs` `version` changes**, never by
reading the command. ⛔ **Before deploying ANY `?key=`-gated function, prove the deployed build
already reads the env var and is currently answering its cron** (a `pipeline_runs` row in the last
cadence) — if the deployed build still carries a hardcoded key, the secret is UNPROVEN and the
deploy is not yours to make unattended.

**Order, always:**
1. **Set the secret first** — a FRESH `rpc_pls_` key the operator generates, then rotate cron onto it (the old "value cron already sends" route is §2's emergency-only fallback). Dashboard →
   Edge Functions → Secrets. ⚠ **The Supabase MCP has no secrets verb; this is
   dashboard-only and can never be completed by an agent session.** (Re-verified 2026-09-20:
   the laptop VM has no `SUPABASE_ACCESS_TOKEN` either — `npx supabase secrets list` asks for
   a login.) ⭐ Better: move the function onto the Vault gate (§0) and skip all of this.
2. Then deploy.
3. Then verify **as the real caller** (§5).

⚠ **Never report a function "rotated/verified" on the strength of a probe you authenticated
yourself.** A hand-issued request with an operator-supplied key proves the function accepts
*that string* — not that the scheduled caller's request passes. Those are different values
whenever cron has not been repointed yet.

## 2. (LEGACY env gate) Restoring a 403ing function — prefer the unconditional instruction

⭐ For a Vault-gated function a 403 means cron and function read DIFFERENT secrets — check that the
function passes its OWN slug and that `cron.job.command` names the same slug; never copy a value.

### ⛔ PRECONDITION — validate the cron's key STRUCTURALLY before copying it anywhere

The instruction below copies a value **out of a cron command**. That value is not guaranteed
to be a key. On 2026-08-15, jobs 15 + 16 were found sending the literal
`<TOPSHOT_PACK_SUPPLY_KEY>` — an unsubstituted template placeholder pasted during the 08-11
repoint, angle brackets and all. **Following §2 verbatim would have installed a trivially
guessable literal as the production gate key, and the 403s would have stopped, so it would
have looked correct.**

```sql
select length(substring(command from 'key=([^&'']+)'))       as key_len,
       substring(command from 'key=([^&'']+)') ~ '^rpc_pls_' as looks_real,
       substring(command from 'key=([^&'']+)') ~ '^<|^PASTE' as looks_like_placeholder
from cron.job where jobid = <id>;
```

**`looks_real` must be true before you copy anything.** If it is not, do NOT set the secret
from cron — instead generate a fresh key **inside the DB** and write it into the cron command
without ever selecting it, then have the operator copy it *out* of `cron.job` into the
dashboard (this inverts the copy direction so there is no template left to substitute):

```sql
do $$
declare v text := 'rpc_pls_' || replace(gen_random_uuid()::text, '-', '');
        j int;
begin
  foreach j in array array[<jobids>] loop
    perform cron.alter_job(j, command := (select regexp_replace(command,'key=[^&'']+','key='||v)
                                          from cron.job where jobid = j));
  end loop;
end $$;
```

⚠ **md5 comparison alone cannot catch this.** A digest tells you cron ≠ secret; it cannot tell
you *why*, and two days were lost to that. **Structural validation is not value disclosure** —
length, prefix and character class are safe to read and are exactly what catches placeholders,
truncation and trailing whitespace.

### The instruction itself

⛔ **EMERGENCY-ONLY since 2026-09-21.** This copies a live, usually BURNED key through a human. Prefer §0.

**Set `<NAME>_GATE_KEY` to the value cron already sends** (once the precondition passes).
Works whether or not the deployed build carries the dual-accept code, needs no cron repoint and
no redeploy.

The `_OLD` route (§3) is correct *only if* the deployed build postdates the dual-accept
change — a fact you have to go check. Prefer the instruction that holds under both
hypotheses.

Read the cron's key without printing it:
```sql
select md5(substring(command from 'key=([^&'']+)')) from cron.job where jobid = <id>;
```

⚠ **This restores service with a compromised credential.** The value cron sends is one of the
keys burned in public git history. Do **not** let "403s stopped" close the rotation.
**A rotation is done when a request succeeds with a key that was never public** — not when a
secret is set.

## 3. (LEGACY env gate) Zero-downtime rotation — the `_OLD` pattern

Every env-gated function supports it (a Vault-gated one needs none of this — §0):

```ts
const GATE     = Deno.env.get("<NAME>_GATE_KEY") ?? ""
const GATE_OLD = Deno.env.get("<NAME>_GATE_KEY_OLD") ?? ""
function gateKeyOk(k) { return !!k && ((GATE!=="" && k===GATE) || (GATE_OLD!=="" && k===GATE_OLD)) }
```

1. Set `<NAME>_GATE_KEY_OLD` = outgoing key, `<NAME>_GATE_KEY` = new key.
2. Deploy — both accepted, **no window, no missed ticks**.
3. Repoint cron one job at a time.
4. **Delete `_OLD`.** No redeploy needed. Only now is it rotated.

Repoint without ever retyping the command:
```sql
select cron.alter_job(<jobid>, command => regexp_replace(
  (select command from cron.job where jobid = <jobid>),
  'key=[^&''"[:space:]]+', 'key=<NEW_KEY>'));
```
The regex terminates correctly on both `&mode=…` and a closing quote. ⚠ Several functions
have **two** cron callers sharing one key — check before assuming 1:1.

## 4. Deploying

### ⭐ FIRST CHOICE since 2026-09-25 — the `edge-fn-deploy` GitHub workflow (no transcription, no local credential)
`.github/workflows/edge-fn-deploy.yml`, `workflow_dispatch` with input `function=<slug>`
(`gh workflow run edge-fn-deploy.yml --ref main -f function=<slug> -f gate_secret_is_set=false`, or the
GitHub MCP's `run_workflow`). It runs the CLI below on a GitHub runner with the repo's
`SUPABASE_ACCESS_TOKEN` / `SUPABASE_PROJECT_ID` secrets and deploys **the bytes committed on `main`** —
so commit + push FIRST, then dispatch.
- Pre-flight: slug must be a real `supabase/functions/<slug>/index.ts`; a function whose
  source reads `*_GATE_KEY` is **refused** unless `gate_secret_is_set` is ticked (§1).
- Post-conditions read back from production and FAIL the run if false: `verify_jwt=false`,
  `status=ACTIVE`, and the drift census (`edge:drift:check --json`) calls the slug `clean`
  (the log line reads `<slug> v<N>: clean`).
- ✅ Proven 2026-09-25 (`enrich-ufc-wallet`, `ingest-topshot-atlas-pool`) and 2026-10-13/14 on 16
  Vault-gate conversions and 6 retirements. It removes the whole MCP-transcription class below (`\uXXXX`
  decoding, hand-copied Cadence addresses) — use the MCP path only if GitHub is unavailable.
- Verification still means the real caller (§5) — a green deploy run proves the bytes, not
  the behaviour. Revert = `git revert` the function's commit, push, dispatch again.
- ⚠ **The workflow's concurrency group CANCELS an in-flight run when another is dispatched** — six
  back-to-back dispatches on 10-14 deployed two. Dispatch one, wait for `completed`, then the next.
- ⚠ **A full vitest run proves only the tree it ran on.** Any edit after it (10-14: a local comment
  stripper added to a test) needs the suite again, or at least every guard that walks `__tests__/`.
- ⭐ **The Deno harness runs in the cloud sandbox** and auto-discovers every function:
  `deno test --config supabase/functions/_tests/deno.json --unstable-sloppy-imports --no-lock --allow-read --allow-env supabase/functions/_tests/`

### CLI (resolves `_shared` deps correctly — what the workflow runs)
```
npx supabase@latest functions deploy <name> \
  --no-verify-jwt \
  --import-map supabase/functions/deno.json \
  --project-ref bxcqstmqfzmuolpuynti
```
- ⚠ **`--no-verify-jwt` is mandatory.** There is no `supabase/config.toml`, so the CLI
  defaults `verify_jwt` to **true**; every gate-keyed function is live with it **false**.
  Omitting it 403s all callers regardless of keys.
- ⚠ **`--import-map supabase/functions/deno.json` is mandatory.** No root `deno.json`, and
  commands run from the repo root, so the map is never discovered and every deploy fails to
  bundle with `Relative import path "@supabase/supabase-js" not prefixed with / or ./ or ../`.
  Same root cause as the documented `edge-deno` CI bug.

**Auth failures, in the order they bite:**
1. A **persistent Windows user env var `SUPABASE_ACCESS_TOKEN`** silently overrides
   `supabase login`. `Remove-Item Env:\SUPABASE_ACCESS_TOKEN` clears it for one session only.
2. `supabase login` may report success while its credential store is not read back on
   Windows. Bypass: set `SUPABASE_ACCESS_TOKEN` to a fresh PAT explicitly.
3. If `projects list` works but every project-scoped call 401s, it is org-level authz
   (member role or enforced MFA) — not fixable by retrying.

⚠ **Confirmed 2026-08-15: traps 1 AND 2 are both live on Trevor's box, and clearing the env
var does not rescue the CLI.** The deploy uploaded all four assets correctly and then 401'd —
and still 401'd with the persistent `SUPABASE_ACCESS_TOKEN` (len 44) cleared via `env -u`.
**Treat the CLI as unavailable and go straight to the workflow (or the MCP fallback)**; do not spend a
session re-litigating the credential path.

### MCP fallback (`deploy_edge_function`)
Works when the CLI does not — different credential path.
`verify_jwt:false`, `import_map_path:"deno.json"`, files `[{deno.json},{index.ts}]`.
- ⭐ **Precondition, proven 2026-09-20 on eleven functions: a REDACTED drift check FIRST.** Spawn a
  subagent that `get_edge_function`s each slug, writes the deployed source VERBATIM under
  `/mnt/user-data/outputs/edge-drift-<date>/<slug>/` (the rollback artifact — never printed), and
  reports only md5 / byte length / `verify_jwt` / bare-specifier + import-map facts / env-var NAMES /
  credential-shaped literals as NAME + first 4 chars. Deploy only the slugs whose deployed md5 ==
  repo (or differ in comments only). That check found 3 of 11 still carrying a hardcoded gate key in
  production — deploying the repo copy over those is the §1 break.
- ⚠ **`_shared`-importing functions are bundled from `supabase/`, not the function dir:** file names
  `functions/<slug>/index.ts`, `functions/_shared/<x>.ts`, `functions/deno.json`;
  `entrypoint_path:"functions/<slug>/index.ts"`, `import_map_path:"functions/deno.json"`. The
  result's `entrypoint_path` then reads `…/source/functions/<slug>/index.ts` — that is the working
  shape (`compute-allday-pack-ev` v52, `topshot-insider-detect-patterns`).
- ✅ **Boot probe right after the deploy:** an anonymous `curl -X POST` to the function URL must
  answer the HANDLER's own 401/403 (`Unauthorized` / `{"error":"forbidden"}`) — a `BOOT_ERROR` /
  503 means the bundle did not resolve. Then the real caller's next `pipeline_runs` row (§5).
- ⭐ **`deno check` runs in the cloud sandbox:** `npm install -g deno@2` (2.9.6 on 2026-09-20), then
  `cd supabase/functions && deno check --config deno.json <slug>/index.ts` and `deno lint` — so a
  type error is caught before CI's `Edge functions (deno check + lint)` job, not by it.
- ⚠ Once a function carries an `import_map_path`, **every later deploy must resupply
  `deno.json`** or it fails with a mangled concatenated path.
- 🚨 **The MCP deploy DECODES `\uXXXX` escapes in transit** (proven 2026-09-24, `sync-nba-projections` v52). A regex like `[\u0300-\u036f]` shipped as two raw combining characters, and nothing errored. `grep -n '\\u[0-9a-fA-F]\{4\}'` every file before deploying. Send each escape as `\u005cuXXXX` (the extra decode restores `\uXXXX`), then confirm the escape survived with a byte round-trip (v53).
- ⛔ **Commit the deployed source in the SAME turn you deploy** — prod ahead of `main` is drift another
  session will "reconcile" or, worse, overwrite with an older build (09-22: a concurrent Claude Code session
  had to pull a Cowork deploy back into the repo). Deploy from the repo file, round-trip the deployed
  `index.ts` md5 against it, then push the commit through whichever push path is up.
- ⚠ **PostgREST clamps a set-returning RPC's result at 1000 rows silently** — any edge function passing an
  id list to one (e.g. `get_fmv_for_editions`) must slice it (≤500); the tell is a counter at exactly 1000.
  A tree-walking guard enforces `.slice(` at every call site.
- ⚠ **Do NOT hand-transcribe large ingest functions.** The three `ingest-*` functions are
  370–514 lines of block-height constants (`SPORK_MAX_HEIGHTS`, `SPORK_FLOOR`) and cursor
  checkpoint arithmetic whose own comments say *"Getting this backwards is silent data loss,
  not an error."* A wrong digit will not crash — it silently mis-walks block ranges.
  If you do transcribe, round-trip with `get_edge_function` and diff before trusting it.

## 5. ⚠⚠ Verification — the `pipeline_runs` positive control

**A 403'd or boot-failed edge function writes NO `pipeline_runs` row.** The contrapositive is
the useful half: **a row carrying an error raised *inside the handler* proves the request got
past the gate.**

```sql
select started_at, ok, left(coalesce(error,''),120)
from pipeline_runs where pipeline = '<name>'
order by started_at desc limit 5;
```

⚠ The pipeline name is often NOT the slug (`ingest-allday-pack-opens` logs `allday-pack-opens-forward`) —
read it from the function source before concluding a lane is silent. A lane that writes no run row at
all is verified from `net._http_response` (status + body) after firing its job.

A Postgres error (e.g. `21000 ON CONFLICT…`) in that column means the gate is open and the
rotation is **not** what is blocking you. On 2026-08-13 this collapsed a believed 8-secret
rotation window down to two commands — after the docs had said "blocked" and been believed.
**Read the instrument, then the doc; when they disagree the instrument wins unless you can
say why it lies.**

⚠ What it proves and does not: it proves *the deployed build's* gate passes. It does **not**
prove a secret exists — the build may be a pre-migration hardcoded one.

Also confirm the deploy did not flip JWT: `list_edge_functions` → `verify_jwt` must be `false`.

## 6. 🔒 Secret safety

⚠⚠ **Supabase edge-function LOGS record full request URLs, including `?key=`.** Reading logs
is **not** a safer alternative to a secret-bearing console page — it is the same leak. The
documented cron-job.org incident is the other half of this class: job-edit pages carry live
`?key=` URLs in the DOM even when the Advanced tab is closed. Query `function_edge_logs` by
`log_attributes['request.pathname']` (no query string), never `request.url`.

⭐ Since 10-14 no pg_cron job sends `?key=`, so new log rows no longer carry a key; older rows still do.

**Safe patterns:**
- Mask in SQL: `regexp_replace(command, 'key=[^&''"[:space:]]+', 'key=***MASKED***', 'g')`
- Compare by digest: `md5(substring(command from 'key=([^&'']+)'))` — never read the value
- ⚠ `get_edge_function` returns **deployed source**, which may contain a hardcoded key.
  Ask for a *fact about* the source, not the source, when you can — or use the redacted subagent (§0).

## 7. Probe hygiene (every false 403 in the 08-10 session was the probe, not the system)

In order: a literal `<PLACEHOLDER>` sent as the key; an empty variable (`Read-Host` does not
accept Ctrl+V in Windows PowerShell — it captures `^V` as one character); a 370-character
clipboard holding unrelated text; a clipboard still holding the *previous* key.

⚠ **The placeholder failure is not confined to probes — the CRON ITSELF held one for 86 hours**
(§2 precondition). And any snippet you hand an operator can reproduce it: three separate
placeholder values were pasted unsubstituted into `cron.job` during the 08-15 repair
(`<TOPSHOT_PACK_SUPPLY_KEY>`, then `PASTE_SECRET_VALUE`, then `PASTE_THE_REAL_KEY_HERE`).
**Every snippet containing a placeholder must refuse to run unsubstituted:**

```sql
if v !~ '^rpc_pls_' then raise exception 'Not substituted (len %, prefix %)', length(v), left(v,8); end if;
```

⚠ **And make the diagnostic a `SELECT`, not a `RAISE NOTICE`.** A `DO $$ … $$` block's notices
**do not surface in the Supabase SQL editor** — it reports "Success. No rows returned" and the
answer is silently lost.

```powershell
$k = (Get-Clipboard -Raw).Trim()
$k.Length          # STOP unless this is the expected length
try { $r = Invoke-WebRequest -Uri "https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/<fn>?key=$k&<params>" -Method POST -UseBasicParsing; "STATUS $($r.StatusCode)"; $r.Content }
catch { "STATUS $($_.Exception.Response.StatusCode.value__)" }
```
`Invoke-WebRequest` throws on 4xx, so a bare call hides the status. `Get-Clipboard` avoids the
`Read-Host` paste failure; `.Trim()` strips the newline password managers append; the command
line contains only `$k`.

**Side-effect-free probe modes** (check the file — they differ):
`&mode=probe` reads one page and writes nothing · `&mode=debugpool` no writes ·
a missing required param returning **400** still proves the gate accepted the key.
⚠ Some functions have **no** probe mode — any authenticated call runs the full job.

## 8. Before you start

1. **Read the function file.** Its header comments carry the rotation instructions, the probe
   modes, and the reason each constant exists. Most of the 08-10 evening was spent
   engineering around a window the code was already built to eliminate.
2. `grep -n "cronGate\|GATE_KEY\|const GATE" supabase/functions/<slug>/index.ts` — Vault gate (§0),
   legacy env gate (§1–§3), or a literal (recover + convert, §0)? Each path differs.
3. Check `cron.job` for **all** callers of that function; some have two.
4. Note that scope may exceed the documented list: functions outside
   `supabase/functions/**` at HEAD have been found using the same burned keys.