---
name: rpc-edge-fn-deploy
description: Deploy or rotate keys on a Rip Packs City Supabase edge function. Triggers on "deploy an edge function", "rotate a gate key", "the cron is 403ing", "set a GATE_KEY secret", or any change to supabase/functions/**. Encodes the mandatory CLI flags, the MCP fallback, the zero-downtime _OLD pattern, the pipeline_runs positive control, and the secret-safety rules for ?key=-gated functions.
---

# RPC edge-function deploy & gate-key rotation

Project `bxcqstmqfzmuolpuynti`. Edge functions under `supabase/functions/**` are gated by
`?key=` and run `verify_jwt=false`. They are called by pg_cron via `net.http_get`.

**This skill exists because a single half-done deploy caused a ~40-hour silent outage.**
Read §1 before touching anything.

---

## 1. ⛔ A deploy of a gate-keyed function is a TWO-PART change

Shipping the code without the secret **looks like success in the deploy log** and fails
closed on every subsequent call.

The 2026-08-12 break, dated to the minute: `backfill-topshot-pack-supply` v25 deployed at
04:16:26Z shipped the env-var gate while `TOPSHOT_PACK_SUPPLY_GATE_KEY` was never set. With
the secret unset the constant is `""` and the hardening correctly rejects everything. Last
successful write 03:33:08Z; 403s on every tick for ~40h; nobody noticed because a 403'd
edge function writes **no** `pipeline_runs` row.

**Order, always:**
1. **Set the secret first** — to the value cron already sends (see §2). Dashboard →
   Edge Functions → Secrets. ⚠ **The Supabase MCP has no secrets verb; this is
   dashboard-only and can never be completed by an agent session.**
2. Then deploy.
3. Then verify **as the real caller** (§5).

⚠ **Never report a function "rotated/verified" on the strength of a probe you authenticated
yourself.** A hand-issued request with an operator-supplied key proves the function accepts
*that string* — not that the scheduled caller's request passes. Those are different values
whenever cron has not been repointed yet.

## 2. Restoring a 403ing function — prefer the unconditional instruction

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

## 3. Zero-downtime rotation — the `_OLD` pattern

Every gate-keyed function already supports it:

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

### CLI (preferred — resolves `_shared` deps correctly)
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
**Treat the CLI as unavailable and go straight to the MCP fallback**; do not spend a session
re-litigating the credential path.

### MCP fallback (`deploy_edge_function`)
Works when the CLI does not — different credential path.
`verify_jwt:false`, `import_map_path:"deno.json"`, files `[{deno.json},{index.ts}]`.
- ⚠ Once a function carries an `import_map_path`, **every later deploy must resupply
  `deno.json`** or it fails with a mangled concatenated path.
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
`?key=` URLs in the DOM even when the Advanced tab is closed.

**Safe patterns:**
- Mask in SQL: `regexp_replace(command, 'key=[^&''"[:space:]]+', 'key=***MASKED***', 'g')`
- Compare by digest: `md5(substring(command from 'key=([^&'']+)'))` — never read the value
- ⚠ `get_edge_function` returns **deployed source**, which may contain a hardcoded key.
  Ask for a *fact about* the source, not the source, when you can.

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
2. `grep -rn "GATE_KEY" supabase/functions` — confirm the exact secret name.
3. Check `cron.job` for **all** callers of that function; some have two.
4. Note that scope may exceed the documented list: functions outside
   `supabase/functions/**` at HEAD have been found using the same burned keys.
