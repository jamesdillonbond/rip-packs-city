# Gate-key rotation (D2b) — progress, hard-won mechanics, and scope expansion

Session: 2026-08-10, Cowork + Trevor interactive. Supersedes the *procedure* half of
[handoff-2026-08-09e-edge-gate-key-rotation.md](handoff-2026-08-09e-edge-gate-key-rotation.md);
that doc's inventory and ordering rationale still stand.

**Status: 3 of 8 functions rotated. Nothing is half-broken.** Every function either has a
NEW key with NEW code, or an OLD key with OLD code. All pg_cron jobs are running.

---

## 🔴 READ FIRST — the outgoing keys are in a chat transcript

While diagnosing, I called the Supabase **edge-function logs** specifically to *avoid*
reading a secret-bearing page (cron-job.org job pages carry live `?key=` URLs in the DOM —
the documented 2026 leak). **That was a bad call: edge logs record full request URLs,
including `?key=` query strings.** The outgoing gate keys are therefore in that
conversation transcript.

Incremental harm is low — these are the already-burned keys being rotated — but it
**raises the priority of finishing the rotation** rather than leaving it half-done.

⚠ **Durable lesson: "read the logs instead of the console" is NOT a secret-safety win when
the credential travels in the URL.** Any log surface that records request URLs is a
secret-bearing surface for `?key=`-gated functions. The safe reads are DB queries with an
explicit `regexp_replace(... 'key=***MASKED***' ...)`, which is what was used for every
`cron.job` inspection in this session.

---

## What is DONE

| # | function | pg_cron | state |
|---|---|---|---|
| 1 | `backfill-pack-opens-api` | none | ✅ v19 deployed, probe 200 with new key, `verify_jwt:false` |
| 2 | `backfill-allday-pack-supply` | none | ✅ v16 deployed, live run 200 / 3,196 rows upserted |
| 3 | `backfill-topshot-pack-supply` | **15, 16** | ✅ v25 deployed, `mode=debugpool` 200, **cron 15+16 repointed to the new key** |

All three deployed via the **Supabase MCP** (`deploy_edge_function`), not the CLI.

⚠ **Known drift on #3:** the deployed copy is missing a 12-line comment block from repo
lines 8–19 (the 2026-06-28 `mode=pool` notes). **Code is byte-identical** — verified by
`get_edge_function` round-trip. `edge-fn-drift.yml` will flag this function, correctly.
A CLI redeploy from repo restores parity.

## What is NOT done

| function | pg_cron | why it stopped |
|---|---|---|
| `ingest-allday-pack-opens` | 20, 55 | 514 lines; `SPORK_MAX_HEIGHTS` 11-element block-height array, cursor/spork checkpoint arithmetic |
| `ingest-topshot-pack-opens-history` | 56 | same class |
| `ingest-pinnacle-mints` | 83, 84 | 370 lines; `SPORK_FLOOR`, chunk/lag constants |
| `compute-pinnacle-pack-ev` | 42 | imports `../_shared/pack-ev-supply-weighted.ts` |
| `compute-golazos-pack-ev` | 44 | same `_shared` dep |

**Why I refused to hand-transcribe the first three:** their own comments state
*"Getting this backwards is silent data loss, not an error."* A single wrong digit in a
block-height constant would not crash — it would silently mis-walk ranges on a cursored
ingest. And the round-trip verification that made #3 safe **degrades exactly where risk
rises**: eyeballing 514 lines across two tool outputs is where a digit gets missed. A check
that is weakest when it matters most is not a check.

⚠ **Do not run the cron SQL for jobids 20, 42, 44, 55, 56, 83, 84.** Those functions still
run old code with old hardcoded keys; repointing their cron would 403 them indefinitely.

---

## 🔑 THE BIG ONE — all 8 functions already support zero-downtime rotation

Every one of the eight has a `*_GATE_KEY_OLD` fallback:

```ts
const GATE     = Deno.env.get("<NAME>_GATE_KEY") ?? ""
const GATE_OLD = Deno.env.get("<NAME>_GATE_KEY_OLD") ?? ""
function gateKeyOk(k) { return !!k && ((GATE!=="" && k===GATE) || (GATE_OLD!=="" && k===GATE_OLD)) }
```

Their own comments spell out the procedure: *"set …_OLD to the OUTGOING key: both are then
accepted, so the pg_cron ?key= values can be repointed one job at a time instead of
atomically. Finish by DELETING the _OLD secret — no redeploy needed."*

**This eliminates the deploy window entirely.** The correct order for the remaining five:

1. Read the outgoing keys (masked-safe query below is for *inspection*; you need the real
   values locally to set the secrets).
2. Set `<NAME>_GATE_KEY_OLD` = the OUTGOING key, for each of the five.
3. Deploy — both keys now accepted, **cron keeps working, zero missed ticks**.
4. Repoint cron at leisure, one job at a time.
5. **Delete the `_OLD` secrets.** *That* is when the burned keys actually die.

Keeping burned keys alive for an extra hour costs nothing — they have been public for
weeks. An outage costs more. **The whole evening was spent avoiding a window the code was
already built to eliminate.**

---

## CLI mechanics — four distinct blockers, in the order hit

Each was a different real problem. Solved ones are marked.

1. ✅ **Stale `SUPABASE_ACCESS_TOKEN` (44 chars) overriding `supabase login`.** Set
   persistently as a Windows user env var; present in Git Bash and every new PowerShell.
   Silently defeated two login attempts. `Remove-Item Env:\SUPABASE_ACCESS_TOKEN` clears it
   **for one session only**. ⚠ Still set persistently — remove via System Properties →
   Environment Variables.
2. ✅ **`supabase login` credential store not read back on Windows.** "You are now logged
   in" then 401 on everything. Bypass: set `SUPABASE_ACCESS_TOKEN` to a fresh PAT explicitly.
3. ✅ **Missing import map → bundle failure on all six.**
   `Relative import path "@supabase/supabase-js" not prefixed with / or ./ or ../`.
   **Same root cause as the documented `edge-deno` CI bug**: no `deno.json` at repo root,
   commands run from repo root, so `supabase/functions/deno.json` is never discovered.
   **Fix: `--import-map supabase/functions/deno.json` on every deploy.**
4. ❌ **UNRESOLVED — project-level authz.** With a fresh full PAT:
   `projects list` **works** (and lists `bxcqstmqfzmuolpuynti`), but every project-scoped
   call — `secrets list`, `functions deploy` — returns **401**. Org `jhlagicpvkslogidxczg`
   is plan `pro`, single org, and the Supabase MCP reads it fine, so nothing is structurally
   wrong. Likely an org member role or enforced MFA on PAT-based project operations.
   **Ask Supabase support verbatim:** *"PAT authenticates and `projects list` succeeds, but
   all project-scoped API calls 401 on a Pro org where I am owner."*

### Working deploy command (once #4 is resolved)

```
npx supabase@latest functions deploy <name> \
  --no-verify-jwt \
  --import-map supabase/functions/deno.json \
  --project-ref bxcqstmqfzmuolpuynti
```

⚠ **`--no-verify-jwt` is mandatory on every one.** There is no `supabase/config.toml`, so
the CLI defaults `verify_jwt` to **true**; all 8 are live with `verify_jwt: false`, and
flipping it 403s every caller regardless of keys. Confirmed against `list_edge_functions`.

✅ The CLI **does** resolve `_shared` deps correctly — it uploaded
`supabase/functions/_shared/pack-ev-supply-weighted.ts` alongside both `compute-*` entrypoints.
That is the reason to finish via CLI rather than MCP.

### MCP deploy mechanics (the fallback that worked)

`deploy_edge_function` with `verify_jwt:false`, `import_map_path:"deno.json"`, and files
`[{name:"deno.json"},{name:"index.ts"}]`.

⚠ **Once a function carries an `import_map_path`, every later deploy must supply
`deno.json` again** — omitting it fails with a mangled concatenated path.

---

## ⚠ SCOPE EXPANSION — D2b covers more than 8 credentials

Live edge logs show **four more functions**, none in D2's list of eight, being invoked with
`rpc_pls_*` keys:

- `backfill-allday-dist-opened`
- `backfill-allday-pack-sales`
- `backfill-topshot-pack-sales`
- `resolve-allday-rip-dist-api`

Two of those four **share one key value**, so the runbook's "8 distinct keys, per-function
isolation preserved" premise is incomplete.

Separately, **`enrich-ufc-wallet` receives a 64-character hex `token=` as a URL query
parameter** — a different credential from the gate keys, and a live instance of sweep A's
P2-3 finding (shared bearer secrets in query strings, which land in access logs).

**Why D2's grep missed them:** it searched `rpc_pls_` literals under `supabase/functions/**`
at HEAD. These were either de-hardcoded in repo without a redeploy, or never in scope.
Either way, **the deployed fleet uses more burned keys than the audit found.**

**Honest exposure count is ≥12 credentials, not 8.** The eight remain the right first
tranche; D2b's scope needs widening.

*Re-probe:* `get_logs(service:"edge-function")` and grep the URLs for `rpc_pls_` — ⚠ but see
the transcript warning at the top: that output contains live secrets.

---

## Verification queries (safe — mask the key)

```sql
-- inspect any cron job without exposing the key
select jobid, jobname,
       regexp_replace(command, 'key=[^&''"[:space:]]+', 'key=***MASKED***', 'g') as command_masked
from cron.job where jobid in (15,16,20,42,44,55,56,83,84) order by jobid;

-- repoint one job (swaps ONLY the key; never retype the command)
select cron.alter_job(<jobid>, command => regexp_replace(
  (select command from cron.job where jobid = <jobid>),
  'key=[^&''"[:space:]]+', 'key=<NEW_KEY>'));
```

The regex is validated against all nine real commands — it terminates correctly on both
`&mode=…` (seven jobs) and a closing quote (jobs 42/44).

**Job→function→secret map:**

| jobid | function | secret |
|---|---|---|
| 15, 16 ✅ | `backfill-topshot-pack-supply` | `TOPSHOT_PACK_SUPPLY_GATE_KEY` |
| 20, 55 | `ingest-allday-pack-opens` | `ALLDAY_PACK_OPENS_GATE_KEY` |
| 56 | `ingest-topshot-pack-opens-history` | `TOPSHOT_PACK_OPENS_HISTORY_GATE_KEY` |
| 83, 84 | `ingest-pinnacle-mints` | `PINNACLE_MINTS_GATE_KEY` |
| 42 | `compute-pinnacle-pack-ev` | `PINNACLE_PACK_EV_GATE_KEY` |
| 44 | `compute-golazos-pack-ev` | `GOLAZOS_PACK_EV_GATE_KEY` |
| — | `backfill-pack-opens-api` ✅ | `PACK_OPENS_API_GATE_KEY` |
| — | `backfill-allday-pack-supply` ✅ | `ALLDAY_PACK_SUPPLY_GATE_KEY` |

**All 8 new secrets are already set and verified** — names confirmed present, and one value
confirmed byte-for-byte against a live function via a temporary diagnostic build.

---

## Operator cleanup owed

1. **Remove the persistent stale `SUPABASE_ACCESS_TOKEN`** (System Properties → Environment
   Variables). It has silently overridden two logins.
2. **Revoke the PAT** created 2026-08-10 if it was issued without an expiry.
3. **Rotate the credential exposed in the transcript** — i.e. finish this rotation.
4. Consider whether `enrich-ufc-wallet`'s query-param token warrants moving to a header.

---

## Method notes worth keeping

⚠ **Every 403 in this session was the probe, never the rotation.** In order: a literal
`<PLACEHOLDER>` sent as the key; an empty variable (`Read-Host` does not accept Ctrl+V in
Windows PowerShell — it captures `^V` as one character); a 370-character clipboard holding
unrelated text; and a key read from a clipboard that still held the previous key.
**Always `$k.Length` before spending a request** — it caught three of the four.

✅ **Reliable Windows pattern for handling a key without touching shell history:**
```powershell
$k = (Get-Clipboard -Raw).Trim()
$k.Length          # must be 48
```
`Get-Clipboard` avoids the `Read-Host` paste failure; `.Trim()` strips the trailing newline
password managers append; the command line contains only `$k`.

⚠ **`Invoke-WebRequest` throws on 4xx**, so a bare call hides the status. Use:
```powershell
try { $r = Invoke-WebRequest -Uri "..." -Method POST -UseBasicParsing; "STATUS $($r.StatusCode)"; $r.Content }
catch { "STATUS $($_.Exception.Response.StatusCode.value__)" }
```

**Good probe targets** (auth-only, no side effects): `backfill-pack-opens-api` with
`&collection=topshot&mode=probe` (reads one page, writes nothing);
`backfill-topshot-pack-supply` with `&mode=debugpool` (no writes).
⚠ `backfill-allday-pack-supply` has **no** probe mode — any authenticated call runs the full
backfill. Idempotent, but it writes.
