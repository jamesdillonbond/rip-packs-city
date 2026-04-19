# INGEST_SECRET_TOKEN Rotation Runbook

This token gates every ingest / cron / backfill endpoint in the app. It lives in
three places that must be kept in sync:

1. **Vercel** prod env var `INGEST_SECRET_TOKEN` — consumed by the Next.js app.
2. **GitHub Actions** repo secret `INGEST_SECRET_TOKEN` — consumed by every
   workflow in `.github/workflows/*.yml` that does `curl -H "Authorization:
   Bearer ${{ secrets.INGEST_SECRET_TOKEN }}"`.
3. **cron-job.org** — ~23+ external cron jobs whose `Authorization: Bearer ...`
   header carries the literal token value. These live outside the repo.

Rotating means updating all three in a tight window so cron jobs don't 401 for
long. The app and GitHub Actions use env/secret references, so they flip the
moment the backing value changes + a redeploy ships. cron-job.org entries hold
the literal, so each must be hand-edited.

---

## When to rotate

- Token has been pushed to a public repo (this repo is public on GitHub).
- A contributor with access leaves.
- Routine: every 90 days.

## Before rotating — pre-rotation audit

Run the grep audit below to check the old token has not been hardcoded anywhere
it shouldn't be. In well-behaved code the token should appear only as
`process.env.INGEST_SECRET_TOKEN` (or `Deno.env.get("INGEST_SECRET_TOKEN")` in
edge functions) and never as a literal.

```bash
# Every reference to the env var name
rg -n "INGEST_SECRET_TOKEN"

# Every literal copy of the current token value (replace with current)
rg -n "rippackscity2026"
```

Literal hits found in the pre-rotation audit on 2026-04-19 — all of these will
need to be edited in the same rotation PR because they bake the old value into
the file:

**Shell / PS1 scripts**
- `backfill.sh:2` — `TOKEN="rippackscity2026"`
- `scripts/backfill-cost-basis.sh:7`
- `scripts/backfill-cost-basis.ps1:6`
- `scripts/run-bulk-classify.sh:10` (token in URL)

**GitHub Actions workflow with literal Bearer (not secret ref)**
- `.github/workflows/pinnacle-owner-discovery.yml:42,55`

**Supabase edge functions with literal auth check**
- `supabase/functions/pinnacle-owner-discovery/index.ts:211`
- `supabase/functions/pinnacle-nft-resolver/index.ts:257`
- `supabase/functions/scan-pinnacle-wallet/index.ts:74`
- `supabase/functions/seed-allday-pack-distributions/index.ts:22`

**Next.js routes with `?? "rippackscity2026"` fallback**
- `app/api/allday-seed-editions/route.ts:158`
- `app/api/cron/stale-fmv-monitor/route.ts:20`
- `app/api/fmv-recalc/route.ts:137`
- `app/api/fmv-backfill/route.ts:79`
- `app/api/profile/achievements/route.ts:36`

**Next.js routes with non-env const (different var name, same literal)**
- `app/api/backfill-player-names/route.ts:4` — `EDGE_FN_TOKEN`
- `app/api/classify-unknowns/route.ts:20` — `TS_PROXY_SECRET` fallback
- `app/api/allday-listing-cache/route.ts:21` — `FLOWTY_PROXY_TOKEN`
- `app/api/listing-cache/route.ts:17` — `FLOWTY_PROXY_TOKEN`
- `app/api/golazos-listing-cache/route.ts:24` — `FLOWTY_PROXY_TOKEN`
- `app/api/topshot-listing-cache/route.ts:22` — `FLOWTY_PROXY_TOKEN`

  These four `FLOWTY_PROXY_TOKEN` constants and the `TS_PROXY_SECRET` fallback
  happen to reuse the same literal but are semantically distinct tokens.
  Rotation of `INGEST_SECRET_TOKEN` should NOT change them unless Trevor also
  wants to rotate those. Flag during review.

**Docs**
- `CLAUDE.md:30` (seed-wallet-refresh URL example)
- `CLAUDE.md:310` (token value note)

**Action during rotation**: scrub literals → env var references; update CLAUDE.md
examples to show placeholder `<TOKEN>` instead of the live value.

---

## Generate the new token

```bash
openssl rand -hex 24
# → 48-char hex string
```

Save it to a password manager. Do **not** commit it to the repo.

---

## Part 1 — Vercel env var + redeploy

Project IDs:
- `projectId`: `prj_YBJ6Utl32GfyBOIzbsp3kbshJh96`
- `teamId`: `team_YWGCVToPBJSS60NgVh8jiCFV`

**Option A — Vercel dashboard (fastest, manual)**
1. https://vercel.com/rip-packs-city → Settings → Environment Variables
2. Find `INGEST_SECRET_TOKEN`, edit, paste new value, save (Production scope).
3. Deployments tab → latest prod deploy → Redeploy (uncheck "use existing build
   cache" is fine either way; env vars inject at runtime).

**Option B — Vercel REST API (scripted, PowerShell)**

Remember: from this repo, env var writes go through PowerShell `Invoke-WebRequest`
because `curl` in Git Bash silently fails against the Vercel API.

```powershell
$headers = @{
  Authorization = "Bearer $env:VERCEL_TOKEN"
  "Content-Type" = "application/json"
}

# 1. List env vars to find the id
Invoke-WebRequest -Uri "https://api.vercel.com/v10/projects/prj_YBJ6Utl32GfyBOIzbsp3kbshJh96/env?teamId=team_YWGCVToPBJSS60NgVh8jiCFV" `
  -Headers $headers | Select-Object -ExpandProperty Content

# 2. PATCH the INGEST_SECRET_TOKEN entry by its id
$body = @{ value = "<NEW_TOKEN>"; target = @("production") } | ConvertTo-Json
Invoke-WebRequest -Method PATCH `
  -Uri "https://api.vercel.com/v10/projects/prj_YBJ6Utl32GfyBOIzbsp3kbshJh96/env/<ENV_ID>?teamId=team_YWGCVToPBJSS60NgVh8jiCFV" `
  -Headers $headers -Body $body

# 3. Trigger a redeploy so the value is picked up
$deployBody = @{
  name = "rip-packs-city"
  gitSource = @{ type = "github"; repoId = "1188272071"; ref = "main" }
} | ConvertTo-Json
Invoke-WebRequest -Method POST `
  -Uri "https://api.vercel.com/v13/deployments?teamId=team_YWGCVToPBJSS60NgVh8jiCFV" `
  -Headers $headers -Body $deployBody
```

Verify: `curl -H "Authorization: Bearer <NEW_TOKEN>" https://rip-packs-city.vercel.app/api/ingest`
should return a normal ingest response, not 401.

---

## Part 2 — GitHub Actions repo secret

https://github.com/jamesdillonbond/rip-packs-city/settings/secrets/actions
→ `INGEST_SECRET_TOKEN` → Update → paste new value.

All `.github/workflows/*.yml` that do `secrets.INGEST_SECRET_TOKEN` pick up the
new value on their next scheduled or manually-triggered run. No redeploy needed.

Smoke-check: open Actions tab, manually dispatch `rpc-pipeline.yml` (or wait for
its next 20-min tick), confirm it returns 200 not 401.

---

## Part 3 — cron-job.org (23+ entries, manual)

Login: https://cron-job.org with the account tied to Trevor's Vercel team.

For each job:
1. Edit the job.
2. Headers tab → find `Authorization: Bearer rippackscity2026`.
3. Replace with `Authorization: Bearer <NEW_TOKEN>`.
4. Save.

There is no bulk edit — each job must be done individually. Budget ~20 minutes.

Jobs that should exist (at least — check dashboard for the full list):
- Seeded wallet pre-cache (every 6h)
- Ingest (every 20min) — *may be GitHub Actions instead, check both*
- Pipeline trigger variants
- Sales indexer
- FMV recalc / backfill
- Listing cache refreshes (topshot, allday, golazos, pinnacle, ufc)
- Check-alerts
- Badge sync
- Weekly digest / support report

**Verification after updating cron-job.org**
- Open each job's History tab, wait for next scheduled run (or hit "Test run").
- A 200 means the new token is accepted.
- A 401 means either the job still has the old header or Vercel hasn't
  redeployed with the new env var yet.
- Expect a brief window where some jobs 401 if the cron-job.org edits outrun
  the Vercel redeploy. Watch for it; it resolves itself once both sides match.

---

## Rollback

If the rotation breaks something:
1. Re-set the Vercel env var back to the old value and redeploy.
2. Revert GitHub secret.
3. cron-job.org headers are still on the new value, so old-token jobs will 401
   until you manually revert them too — this is the painful step and the reason
   rotation happens rarely.

Better: keep the old token valid for ~15min after rotation by adding a temporary
`or` check in the auth helper. Not currently implemented — future improvement.

---

## Future improvements

- Add a multi-token auth path in the Next.js routes so rotation becomes a
  graceful cutover (old + new both valid for N minutes).
- Migrate cron-job.org entries to GitHub Actions where possible so they read
  from a single `secrets.INGEST_SECRET_TOKEN` and rotation collapses to one
  place.
- Delete the hardcoded literals listed in the audit above so the next rotation
  is a 3-surface flip instead of a 20-file PR.
