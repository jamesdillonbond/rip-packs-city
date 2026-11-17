# All 14 pg_cron HTTP jobs put their gate key in the URL, none use a header — and the standing credential probe is structurally blind to them

**Filed 2026-09-02 ~04:0x PT (11:0xZ), Claude Code cloud session. NOTHING CHANGED** — the fix is
two-sided and the half that must go first is an edge deploy.

Found while re-running the deep-audit register's `VERIFIED-CLEAN` probes (see §4 — one of them
failed, for an unrelated and benign reason, which is what put me in `cron.job`).

## 1. The count

Measured with a projection that selects **no command text**, so no key value can be echoed:

| | |
|---|---:|
| pg_cron jobs total | 104 |
| …that dispatch over HTTP (`net.http_*`) | **14** |
| …that put a credential in the URL (`?key=` / `?token=` / `?secret=`) | **14 — all of them** |
| …of which ACTIVE | **13** |
| …that pass a credential as a HEADER instead | **0** |

Across **11 edge functions**: `backfill-allday-dist-opened`, `backfill-allday-pack-sales`,
`backfill-topshot-pack-sales`, `backfill-topshot-pack-supply` (×2), `compute-golazos-pack-ev`,
`compute-pinnacle-pack-ev`, `ingest-allday-pack-opens` (×2), `ingest-pinnacle-mints` (×2),
`ingest-topshot-pack-opens-history`, `resolve-allday-pull-editions`, `resolve-allday-rip-dist-api`.
**Every one is `postgres`-owned**, so unlike the `cron_heavy` fleet they ARE alterable from a session.

## 2. Why it matters, and why this is not a new mechanism

**Supabase edge-function logs record the FULL request URL.** A credential in the query string is
therefore written into the log store on every tick, for as long as the schedule runs. That is exactly
the defect fixed hours earlier on `/api/cron/sales-serial-backfill`, which was building
`…/functions/v1/sales-serial-backfill?token=${INGEST_SECRET_TOKEN}` and is now sending an
`Authorization` header (ledger 2026-09-02). **This filing is the pg_cron leg of the same pattern, at
fourteen times the count**, and it was not looked at then.

⛔ **I did NOT read the edge-function logs to confirm the leak.** CLAUDE.md's rule is explicit —
*reading them IS the leak* — and the mechanism is already established in this repo's own record. The
count above is the finding; log evidence would add nothing and would cost what it measures.

## 3. 🚨 Why the standing credential probe never saw this

The register's `VERIFIED-CLEAN` row **"No hardcoded credentials"** greps
`eyJhbGciOiJ`, `sb_secret_`, `sk-ant-`, `AKIA`, `ghp_`, `github_pat_`, `re_` and **`rpc_pls_`** —
the exact prefix these gate keys use — and reports **0 real hits**. It is correct and it is blind:
**it greps `origin/main`, and a pg_cron command lives only in the database.** Fourteen live
credentials sit outside every scope that probe covers.

⭐ **The transferable point: a credential probe is bounded by its CORPUS, not by its pattern list.**
This one has the right regex and the wrong search space. The same blindness covers `cron.job.command`,
Vercel env, edge-function secrets and anything else that is configuration rather than code — and the
row's "0 real hits" reads as an estate-wide all-clear.

## 4. ⓘ The probe failure that led here was benign, and its row needs correcting anyway

`pg_cron has no disabled/orphan jobs` expects **no inactive rows** and is stamped `93 / 93`. Live:
**104 / 103** — one inactive job, `jobid 16 rpc-backfill-pack-pool`.

**Deliberate, and already recorded**: the ledger notes it PAUSED during the
`public-api.nbatopshot.com` 530/`1033` outage, alongside `topshot-moments-hydrator` STOPPED and
`offers-sweep` breaker-throttled. ⚠ **That outage is still live** — `error code: 1033` is still
accruing on `sales_serial_backfill_failures` at +245 per 6 h as of this session — so the pause is
still correct.

👉 **But the row as written turns a correct, documented pause into a probe failure**, and the
register's own instruction is *"if a probe fails, that becomes a finding and earns a full
investigation."* The next auditor will re-walk this. The row should read: *no inactive rows OTHER
than those with a ledger-recorded pause and a stated revival condition — currently exactly one,
jobid 16, revived when the Top Shot legacy endpoint returns.*

## 5. The remedy, in the only order that works

1. **Edge functions first.** Each currently gates on the query param; flipping the cron command alone
   takes 13 pipelines down. Redeploy them to accept the key from a header **and** the query param
   (dual-accept), so the two halves can land independently. ⛔ **Edge deploys are operator-gated**
   (known-issues #23 / register R64), so this step is not mine.
2. **Then the cron commands**, and they can be rewritten **without the value ever leaving the
   database** — no key needs to pass through a session, a transcript or a migration file:

   ```sql
   -- illustrative shape; verify per job before running. `command` is read and
   -- rewritten in place, so the credential is never selected or retyped.
   SELECT cron.alter_job(
            jobid,
            command := regexp_replace(
              command,
              '\?key=([^''&]+)',                       -- capture, then relocate
              ''')::text', 'g')                        -- ← see the note below
          )
   FROM cron.job
   WHERE command ~ '[?&]key=' AND username = 'postgres';
   ```
   ⚠ The replacement above is deliberately left as a **shape, not a runnable one-liner**: moving a
   captured group from a URL into `net.http_get(..., headers := jsonb_build_object(...))` needs the
   call rewritten, not just the string patched, and that is worth doing one job at a time with the
   post-state checked against `net._http_response`. **Do not batch it.**
3. **Then drop query-param support** from the functions.
4. **Then ROTATE the keys — and note this is ALREADY an open P1, which changes what steps 1–3 are
   worth.** Register **D2b** ("Gate-key rotation") is open, and the 2026-08-15 run-2 handoff is
   explicit that the last intervention on these very jobs was *"service restoration, not rotation —
   **the value is burned in public git history**"* (the defeated 2026-08-03 purge, known-issues #22).
   👉 **So the URL exposure is a SECOND channel on keys that are already public.** Relocating them to
   a header is necessary and **not sufficient**: it stops the log store filling, it does not un-log
   what is there, and it does nothing about the git history. **Rotation is the step that closes both
   this filing and D2b**, and doing it without first landing steps 1–3 would immediately re-publish
   the new value into the logs.
   ⚠ **And read D2b before touching any key:** it records that `rpc_pls_` does NOT discriminate
   rotated from original — **LENGTH does** (40 = rotated, 21–28 = original) — and that *the leak
   vector is the rotation procedure itself*.

## 6. Falsifier / re-derive

```sql
SELECT count(*) FILTER (WHERE command ~ '[?&](key|token|secret)=') AS in_url,
       count(*) FILTER (WHERE command ILIKE '%headers%')           AS via_header
FROM cron.job WHERE command ILIKE '%net.http_%';
```
**Expected after step 2: `in_url = 0`, `via_header = 14`.** If `in_url` falls without `via_header`
rising, jobs were deleted rather than fixed — check the schedule inventory before calling it done.
