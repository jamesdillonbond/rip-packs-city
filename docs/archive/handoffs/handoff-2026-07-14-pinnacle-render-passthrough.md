# Handoff 2026-07-14 — pinnacle-proxy render passthrough (+ optional badge residual drain)

## Context

Cowork shipped the trophy-case PDF export end-to-end today (deploys through `1b74b62`, all READY; full trail in `docs/overnight/ledger.md`). Two items remain that Cowork cannot ship because they need wrangler / a local Node run on Trevor's machine. Everything else — `pinnacle_render_cache` + `badge_icon_cache` tables, the PDF route's cache-first reads, the badge coverage drain (3,163 → 55 missing rows), and the set-149 PK-collision fix in `app/api/admin/backfill-badges-from-sets/route.ts` — is already live. HEAD at time of writing: `1b74b62` on `main`.

Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.

---

## Item 1 (P1): `pinnacle-proxy` worker — GET `/render/<renderId>` passthrough

**Why.** `assets.disneypinnacle.com` (signed Pinnacle render URLs) 403s ALL datacenter egress — Vercel, Supabase edge, everything (documented in `app/api/public/pinnacle-image/[renderId]/route.ts`, which therefore 302s the *browser* to a fresh signed URL). That means no server-generated surface (trophy-case PDF, future OG cards) can embed Pinnacle art. Today's interim fix is a manual browser harvest into `pinnacle_render_cache` (one render cached: `LEV2-LION-CARE-S6`). Cloudflare Workers egress is the one untested lane that may pass the CDN's filter — if it does, Pinnacle art becomes hands-off forever.

**STEP 0 — VERIFY THE PREMISE BEFORE WRITING CODE.** From any quick worker (or a `wrangler dev --remote` session), fetch a fresh signed URL and check the status. Get a signed URL by running the same GQL the pinnacle-image route uses (copy `MEDIA_QUERY` + `resolveSignedUrl` from `app/api/public/pinnacle-image/[renderId]/route.ts`), or simply `Invoke-WebRequest -MaximumRedirection 0 https://www.rippackscity.com/api/public/pinnacle-image/LEV2-LION-CARE-S6` and read the `Location` header. If the worker fetch of that signed URL returns 403, **stop — the whole item is moot**; note it in the ledger ("CF workers also blocked") and keep the browser-harvest path as the permanent fill.

**File touched:** `workers/pinnacle-proxy/index.js` (verified to exist; currently a single-route worker: `POST /graphql` → `public-api.disneypinnacle.com/graphql`, auth `X-Proxy-Secret` vs `env.PROXY_SECRET`, CORS preflight handled). `workers/pinnacle-proxy/wrangler.toml` needs no change.

**Change.** Add a GET route alongside the existing POST handling:

- `GET /render/<renderId>?v=front|quarter` with the same `X-Proxy-Secret` auth as the POST route (do NOT make it public — it's a paid-egress amplifier).
- Validate `renderId` against `/^[A-Za-z0-9-]{3,64}$/` (mirror the SSRF guard in the pinnacle-image route).
- Resolve a fresh signed URL in-worker via the studio-platform GQL (`https://api.production.studio-platform.dapperlabs.com/graphql`, `searchPinnacleEditions` filtered by `render_id`, media name `Front_Transparent` or `Front_Quarter_Transparent` — copy the exact query and media-pick logic from `app/api/public/pinnacle-image/[renderId]/route.ts` rather than re-deriving it).
- Fetch the signed asset from the worker and stream the bytes back with the upstream content-type. A 30–60s `cf: { cacheTtl: 1800 }` or simple pass-through is fine; the consumer caches durably in the DB anyway.
- Keep the existing `POST /graphql` behavior byte-identical.

**Deploy:** `wrangler deploy --config workers/pinnacle-proxy/wrangler.toml` (workers deploy via wrangler, never via git push — see memory `worker-deploy-drift`).

**Smoke:**

```powershell
Invoke-WebRequest "https://pinnacle-proxy.tdillonbond.workers.dev/render/LEV2-LION-CARE-S6" -Headers @{"X-Proxy-Secret"="<secret>"} -OutFile simba.png
# expect: PNG magic bytes, ~2.9MB (2880×2880)
```

**Consumer wiring (phase 2, only after the smoke passes).** A small Vercel cron, e.g. `app/api/cron/pinnacle-render-cache-fill/route.ts` (new file), that: finds render_ids referenced by trophy-pinned Pinnacle slabs (`trophy_moments` joined to `pinnacle_editions`/wmc — verify the actual join shape) that are missing from `pinnacle_render_cache`, calls the worker with `TS_PROXY_SECRET`… **note the secret domain**: this worker's `PROXY_SECRET` belongs to the `TS_PROXY_SECRET` rotation domain per CLAUDE.md "Worker auth surfaces" — reuse the env var the other worker callers use, don't mint a new one. Downscale before caching (the PDF route already contains the pure-JS decode/downscale pipeline — `decodeToRgba` / `downscaleRgba` / `encodePng` in `app/api/profile/trophy-case/pdf/route.tsx`; consider extracting to `lib/pdf-img.ts` if reused) and upsert `{render_id, mime, b64, bytes}` with the service-role client. Schedule daily in `vercel.json` (21 crons currently; `maxDuration` well under 800s).

**Revert:** worker — redeploy the previous `index.js` from git history (`git show <prior>:workers/pinnacle-proxy/index.js` + `wrangler deploy`); cron — `git revert` the commit and remove the `vercel.json` entry.

**Expected verification:** `npx tsc --noEmit` clean (if the cron lands), Vercel deploy READY, smoke above returns PNG bytes, and after one cron tick `SELECT render_id, bytes FROM pinnacle_render_cache` shows every trophy-pinned render. The PDF picks the rows up with zero further changes.

---

## Item 2 (P2, optional, no code change): drain the 55-row badge residual

**What.** After today's coverage drain, exactly **55** canonical TS editions still lack a `badge_editions` row (verified live via SQL: canonical int-pair editions LEFT JOIN badge_editions on `collection='nba_top_shot'`), spread across sets `100,102,109,114,120,140,152,169,174,218,254,255,260,264,265,68` — the "no recoverable GQL set-uuid / not returned by the set walk" class.

**How.** The fallback tool already exists and was built for exactly this: `scripts/backfill-badges-from-moments.mjs` (verified to exist; resolves a known moment_id per edition from wmc/moments/sales, reads edition badges via `getMintedMoment(momentId){play{tags} setPlay{tags}}`; **ignores** `data.badges` which are serial badges). It hits `public-api.nbatopshot.com` directly, so it must run from Trevor's machine (residential egress), with the usual env (`SUPABASE_URL` + service key; check the script's `readFileSync` env pattern at the top of the file).

```powershell
node scripts/backfill-badges-from-moments.mjs --dry   # inspect counts first
node scripts/backfill-badges-from-moments.mjs         # write
```

**Note:** the PK-collision fix (`1b74b62`) applies to the sets route; if this script also carries `id: <gql uuid>` into its rows, apply the same `crypto.randomUUID()` change there before the write run (inspect the script — don't assume either way).

**Revert:** `DELETE FROM badge_editions WHERE collection='nba_top_shot' AND updated_at > '<run start>'` scoped to the run window (verify count first — expect ≤55).

**Expected verification:** the missing-count query drops from 55 toward the truly-unindexable remainder; spot-check one recovered edition's page shows badges.

---

## Guardrails (standing)

- Direct-to-`main`, no branches, no PRs. If a `claude/*` branch is pre-checked-out, switch to `main` first.
- Commit via PowerShell `git` on Windows (Git Bash `git commit` can silently no-op). Re-verify the push: `git rev-list --count origin/main..HEAD` → expect 0.
- `curl` fails silently in Git Bash for Vercel REST — use PowerShell `Invoke-WebRequest`.
- Vercel Pro `maxDuration` hard cap is **800s** — anything higher sends the deploy to ERROR invisibly.
- CRLF: don't string-replace-patch on Windows; full-file writes or `findIndex` on split lines.
- Never echo `PROXY_SECRET`/`TS_PROXY_SECRET` values; wrangler secrets are operator-set.

**End state:** worker passthrough live (or the premise disproven and logged), an optional daily cron keeping `pinnacle_render_cache` filled hands-off, badge residual ≤ the truly-unindexable tail, all on `main` with deploys READY.
