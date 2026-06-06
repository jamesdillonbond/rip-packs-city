# Handoff — Pinnacle image + catalog backfill via on-chain Cadence (premise: GQL is DEAD)

## Context / premise correction (read first)

- Goal: close the Pinnacle image + catalog gaps surfaced during the Dumbo wallet warm. His Pinnacle holdings: 55 editions, only 25 with real thumbnails, and 3 not in `pinnacle_editions` at all. Platform-wide has the same gap.
- DO NOT reach for the Pinnacle public GQL. The header of `app/api/cron/pinnacle-metadata-backfill/route.ts` documents that `public-api.disneypinnacle.com` returns 404 from every IP we control (re-verified 2026-05-16 via `pinnacle-proxy`). Flowty's per-NFT REST (the other historical image source) is also dead (marketplace shut 2026-05-13). There is currently NO working off-chain image fetch for Pinnacle. A "GQL re-fetch" handoff would be dead on arrival — that's why this is framed around on-chain.
- What populates `pinnacle_editions` today: the on-chain Cadence backfill (that same route) reads `mint_count` / `edition_key` / `variant` / `printing` / `royaltyCode` off Flow mainnet via `Pinnacle.getEdition` + `Pinnacle.getShape(id).getMetadata()`. It does NOT read or write `thumbnail_url`.
- The `"placeholder_thumbnail_path"` literal in ~half the rows is NOT written by our code (grep across the repo: 0 matches). It's an upstream placeholder Pinnacle itself served when the old fetch last ran; `NULL` = never fetched. So images are absent, not corrupted.
- No code change shipped by Cowork here. After thumbnails land, Cowork re-denormalizes `wmc.image_url` from `pinnacle_editions.thumbnail_url` (nothing auto-populates `wmc.image_url`).

## The viable path: extend the on-chain Cadence read

The existing `pinnacle-metadata-backfill` already proves Cadence reads work for Pinnacle (it fills `mint_count` reliably, 0 fails/48h). The shape metadata dict it reads — `Pinnacle.getShape(id).getMetadata()` — currently has only `"RoyaltyCodes"` extracted (route ~line 95). That dict very likely also carries display fields (image/thumbnail URL, character/title, set, franchise). If it carries an image URL, we populate `thumbnail_url` on-chain with no GQL.

### Step 1 — VERIFY first (mandatory, do not skip)

- Per CLAUDE.md "Cadence Work": use the Cadence MCP to fetch the deployed Pinnacle contract source at `0xedf9df96c92f4595` and inspect `Shape` / `getShape` / `getMetadata()` — enumerate EXACTLY which keys `getMetadata()` returns, and whether any is a real image/thumbnail URL (and which keys carry character/title/set/franchise).
- Sanity-read one of Dumbo's art-less pins on-chain to see the actual dict values. Wallet `0x37a7e864611c7a85` holds these art-less sample editions: `20CS-SEV1-ALIN:Standard:1` (Chestburster / Alien), `PAS-SEV2-CARS:Standard:1` (Mater / Cars), `STAR-SEV1-SWMB:Standard:1` (Sy Snootles / Star Wars).
- If `getMetadata()` exposes NO image URL: STOP. Pinnacle images are genuinely unavailable on-chain AND via every off-chain source we have. Record that conclusion in the route header + `docs/overnight/ledger.md` and do not fabricate. This is a real possible outcome — report it rather than force it.

### Step 2 — if an image key exists, implement (extend the existing route; no new infra)

File: `app/api/cron/pinnacle-metadata-backfill/route.ts`

- Extend the `PINNACLE_METADATA_SCRIPT` struct (`PinInfo`) + Cadence `main()` to also return the image URL (and character/set/franchise if present) from the shape metadata dict — adapt to the exact key names Step 1 found. Re-verify the Cadence compiles against the live contract via the Cadence MCP before shipping (it's a template literal — CRLF/edit gotchas apply).
- Add a Q4 job: `pinnacle_editions` where `(thumbnail_url IS NULL OR thumbnail_url NOT LIKE 'http%')` AND a sample wmc row exists for the key → update `thumbnail_url` (and names) ONLY when the on-chain value is a real `http%` URL. NEVER write a placeholder string.
- Add a catalog-create job: wmc Pinnacle `edition_key`s with no `pinnacle_editions` row → INSERT from the on-chain read (`edition_key`, `character_name`, `set_name`, `franchise`, `variant`, `printing`, `mint_count`, `thumbnail_url`). Reuse `buildEditionKey()`. Catches Dumbo's `WDAS-LGEV3-MNF:Quinova:1` + the uncatalogued tail.
- Keep the per-tick caps small and the soft-deadline (route is `maxDuration=30`, chunked at 50/wallet) — this is a slow drip, not a bulk job.

## Verify

- `npx tsc --noEmit` clean; deploy READY; manual GET of the route with the bearer token returns `image_filled > 0` (add the counter to the response + `log_pipeline_run` extra).
- Dumbo (Supabase `bxcqstmqfzmuolpuynti`): his Pinnacle real-image editions rise from 25/55; specifically the three sample keys above gain a `thumbnail_url`, and `WDAS-LGEV3-MNF:Quinova:1` gains a `pinnacle_editions` row.
- Platform: `SELECT count(*) FROM pinnacle_editions WHERE thumbnail_url LIKE 'http%'` rises run-over-run.
- Ping Trevor / leave a note so Cowork re-denormalizes `wmc.image_url` for affected wallets afterward.

## Guardrails

- Direct to `main`, no branch/PR (CLAUDE.md non-negotiable). PowerShell `git` on Windows (Git Bash commit can silently no-op); re-verify push with `git rev-list --count origin/main..HEAD` = 0.
- Cadence MCP verification BEFORE editing the `.cdc` template literal is mandatory. Production reads keep routing through Flow REST / the proxy layer — do not swap to a direct node.
- Never write placeholder / non-`http` thumbnail values; never fabricate an image.
- `maxDuration` stays 30; never raise past 800 (silent ERROR deploys).
- Your direct inspection + the Cadence MCP win over this doc — adapt to the real contract shape; if the premise here is wrong, correct it.

## Revert

- `git revert <commit>`. Data is additive (new thumbnails / catalog rows); no destructive change to undo.

## End state

- `pinnacle-metadata-backfill` also fills real thumbnails + creates missing catalog rows from on-chain data — OR, if on-chain carries no image, a documented dead-end with the GQL/Flowty/on-chain reasons recorded so nobody re-litigates it. Dumbo's Pinnacle image coverage climbs from 25/55; platform Pinnacle art coverage rises every run.
