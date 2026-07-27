# Handoff 2026-07-27 — three production alerts, root-caused and measured

## Context

Cowork triaged three alerts Trevor received on 2026-07-27. **Nothing has been shipped** — all three
fixes are route/component code, which Cowork cannot push. No migrations were applied; no DB rows were
written. Every claim below is backed by a measurement recorded inline.

HEAD at investigation time: `a1896d6673635a7400df309952d6c994c9f75918`
(*docs(ledger): flag ALLDAY-DECODE-LEG-EFFICACY queued fix as a regression risk*).

Priority order below is by blast radius, not by alert severity. Item 2 is the one costing money right now.

---

## Item 1 — `allday-unmapped-resolver`: both resolvers are pinned to a static window, and it is the *unresolvable* window

**Files:**

- `app/api/cron/allday-resolve-unmapped/route.ts` (candidate query ~L163-171, `CANDIDATE_LIMIT = 400` L47, `ON_CHAIN_MAX = 60` L51)
- `app/api/cron/allday-resolve-unmapped-tail/route.ts` (candidate query ~L106-107, `CANDIDATE_LIMIT = 600` L41, `MIN_AGE_DAYS = 7` L47)

Both files verified present; line numbers are from HEAD above.

### Root cause

Both routes select candidates with a bare `ORDER BY sold_at DESC LIMIT n` and **no cursor, offset, or
attempt-tracking of any kind** (`p_cursor_before: null, p_cursor_after: null` in both `logRun` calls is
the tell). `unmapped_sales` has no `last_attempt_at` column — confirmed against
`information_schema.columns`, the table has 18 columns and none of them track attempts.

Consequence: an unresolved row keeps `resolved_at IS NULL` forever, so **every tick re-selects the exact
same rows**. The live resolver sees the same newest-400 (385 distinct nft_ids), the tail resolver sees the
same newest-600 of the >7-day rows. Between them they can reach at most ~1,000 of ~28,000 open nft_ids.
Everything else has never been attempted and, under current code, never can be.

This is not a transport fault. `onchain_err` is `0` on every run; the failures are `onchain_nil` —
the borrow succeeding and returning "not here".

### Measurements

Identical `extra` payload on every consecutive run (`candidates: 385`, `onchain_attempted: 60`,
`onchain_nil: 60`, `onchain_resolved: 0`, `promoted: 0`) — the static-window signature.

Verified the head is static, and matches the pipeline's own reported `candidates`:

```sql
SELECT count(DISTINCT nft_id) FROM (
  SELECT nft_id FROM unmapped_sales
  WHERE collection_id='dee28451-5d62-409e-a1ad-a83f763ac070'
    AND resolved_at IS NULL AND price_usd > 0
  ORDER BY sold_at DESC LIMIT 400) t;
-- 385  ← exactly the `candidates: 385` reported by every run
```

Health trend from `pipeline_runs` — this is a decay, not a step change:

| day | runs | ok | promoted |
|---|---|---|---|
| 07-24 | 45 | 44 | 45 |
| 07-25 | 94 | 92 | 216 |
| 07-26 | 95 | 58 | 59 |
| 07-27 | 52 | 4 | 13 |

`allday-unmapped-resolver-tail` over 48h: 16 runs, 9 failed, **0 promoted, 0 on-chain resolved.**

### The decisive measurement — the reachable rows are the dead ones

Replicated the route's own Stage 1 + Stage 2 (same `BORROW_MOMENT_SCRIPT`, same `EXCLUDED_ADDRESSES`,
same `AllDay.Deposit.to` decode) against Flow mainnet REST, on two random samples of 25 open rows:

| sample | resolved on-chain |
|---|---|
| **head** (what both routes retry every ~20 min) | **0 / 25** |
| **outside both windows** (never attempted) | **12 / 25 (48%)** |

Then checked whether those 12 successes are reachable by either scheduled route:

```sql
-- probed nft_ids vs the tail route's own selection window
-- result: reachable_by_tail_route = 0 for all 25, resolved and unresolved alike
```

**All 25 probed rows — including all 12 that resolved in seconds — sit outside both routes' windows.**

Extrapolating the 48% rate across the 27,584 unreachable distinct nft_ids: **~13,000 AllDay moments are
on-chain-resolvable right now and no scheduled job can ever select them.**

### Note for the ledger — this resolves an open question

The 2026-07-27 ledger entry judged the "3,599 decode_attempted → 0 resolved" window to be *"most
plausibly a backlog-composition artifact… the remaining rows are genuinely unresolvable via decode."*
That is **correct for the window the resolver can see, and wrong as a statement about the backlog.**
The head is genuinely dead (0/25 confirms it); the backlog behind it is 48% live. The ledger's own
suggested remedy — *"skip decode for rows already probed"* — is exactly right, and is a cursor.

The REGRESSION WARNING on `ALLDAY-DECODE-LEG-EFFICACY` stands and is unaffected by this item: do **not**
re-narrow the decode leg's firing condition. This item only changes *which rows get selected*, never the
leg-gating logic.

### Suggested fix (shape, not prescription)

Add attempt-tracking so the window rotates. Two options, in preference order:

1. **No migration** — stamp attempts into the existing `resolution_hint` jsonb
   (e.g. `resolution_hint->>'onchain_probed_at'`), and add
   `.or('resolution_hint->>onchain_probed_at.is.null,resolution_hint->>onchain_probed_at.lt.<now-7d>')`
   to both candidate queries. Cheapest, reversible by ignoring the key.
2. **With migration** — add `unmapped_sales.last_onchain_attempt_at timestamptz` + partial index on
   `(collection_id, resolved_at, last_onchain_attempt_at) WHERE resolved_at IS NULL`, order by it
   `NULLS FIRST`. Cleaner, and the index keeps the selection cheap.

Either way, keep `sold_at DESC` as the *secondary* sort so the 07-26 recency intent is preserved. Do not
raise `ON_CHAIN_MAX` — the budget is fine, it is being spent on the wrong rows.

Expect: `onchain_resolved` non-zero within one tick, `candidates` no longer pinned at 385,
`still_unresolved` falling instead of flat.

### Revert path

Revert the single commit. If option 2 is taken, the inverse migration is
`DROP INDEX IF EXISTS <name>; ALTER TABLE unmapped_sales DROP COLUMN IF EXISTS last_onchain_attempt_at;`
— capture it in the migration header per `rpc-migration`.

### Verification

`npx tsc --noEmit` clean · deploy READY · then, 30 min after deploy:

```sql
SELECT started_at, ok, extra->>'candidates' AS candidates,
       extra->>'onchain_resolved' AS resolved, extra->>'promoted' AS promoted
FROM pipeline_runs WHERE pipeline='allday-unmapped-resolver'
ORDER BY started_at DESC LIMIT 5;
```

Pass = `candidates` varies between runs **and** at least one run reports `onchain_resolved > 0`.
A run where `candidates` is still exactly 385 means the cursor is not being applied.

---

## Item 2 — `/api/public/ipfs-media/[cid]` streams videos that the edge cache silently refuses to store

**This is the Fast Data Transfer alert (50×, 0.02 GB → 1.01 GB per 5 min). It is a real, ongoing cost leak.**

**Files:**

- `app/api/public/ipfs-media/[cid]/route.ts` (whole file, 61 lines)
- `components/MomentHeroMedia.tsx` (the `<video>` at L84-89)
- `app/moment/[id]/page.tsx` (L768 image candidates, L985 `videoUrl={proxyIpfsUrl(e.video_url)}`)

All three verified present.

### Root cause

The route sets `Cache-Control: public, max-age=86400, s-maxage=31536000, immutable` and its header
comment reasons that "the first request warms the Vercel edge and every subsequent load is a fast,
cached same-origin hit." **That is true for images and false for videos**, because the objects exceed
Vercel's maximum cacheable response size. The route has no size ceiling — it streams
`upstream.body` straight through whatever its length.

Measured against production, same URL three times each:

| object | size | attempt 1 | attempt 2 | attempt 3 |
|---|---|---|---|---|
| `QmSzQor91…` (image/png) | 3.38 MB | MISS | **HIT** | **HIT** |
| `bafybeig6qixajykzf7…` (video/mp4) | **17.56 MB** | MISS | **MISS** | **MISS** |

The delivered response header also comes back as `cache-control: public, max-age=86400, immutable` —
`s-maxage` stripped — with `age: 0` on every video request. So **every single video view costs a full
17.5 MB of Fast Data Transfer, forever, with zero amortisation**, plus a full ipfs.io round-trip.

The amplifier is `components/MomentHeroMedia.tsx:84-89`:

```tsx
<video
  poster={currentImg ?? undefined}
  autoPlay
  loop
  muted
```

No `preload="none"` and no `preload="metadata"` — unlike the grid tiles, which *do* gate on hover
(`EditionsGridPaginated.tsx:315,355`). So every `/moment/[id]` render downloads the entire video
immediately, whether or not anyone watches it.

Blast radius:

```sql
SELECT c.slug,
       count(*) FILTER (WHERE e.video_url ~* 'ipfs') AS ipfs_video_urls
FROM editions e JOIN collections c ON c.id = e.collection_id GROUP BY 1;
-- nba_top_shot 10270 · ufc_strike 516 · (allday/golazos/candy 0)
```

**10,786 editions** route a video through this proxy. `/moment/[id]` served 472 requests in the 4h
window sampled — none of which could be cached.

### Suggested fix (shape, not prescription)

Three changes, each independently useful; 1 and 2 are the ones that stop the bleeding.

1. **Cap what the proxy will stream.** `HEAD`/`Range: bytes=0-0` the upstream first, or read
   `content-length`; above a threshold (~8 MB is safely under the cache ceiling; 3.38 MB is proven to
   cache, 17.56 MB is proven not to) **302-redirect to the upstream ipfs.io URL instead of proxying**.
   Vercel then transfers zero bytes for that object. The redirect is safe — `CID_RE` has already
   validated the CID, so the SSRF guard still holds.
2. **Add `preload="none"` to `MomentHeroMedia`'s `<video>`** and keep `poster`. The poster image
   *does* cache. Video then transfers only on real play intent. This alone removes the large majority
   of video bytes, since a crawler never presses play.
3. **Correct the route's header comment** — it currently asserts an edge-cache guarantee that does not
   hold for its largest objects, which is what made this invisible.

While in the file: `AbortSignal.timeout(25_000)` (L42) can never fire, because the platform kills the
function first — see item 3.

### Revert path

Revert the single commit. All three changes are self-contained in the two files; no schema, no config,
no env var.

### Verification

`npx tsc --noEmit` clean · deploy READY · then:

```powershell
$u = "https://www.rippackscity.com/api/public/ipfs-media/bafybeig6qixajykzf7nsl6o6m6bks6irso7nlkgiu77vku3knl5vzngyve"
1..3 | % { (Invoke-WebRequest $u -MaximumRedirection 0 -SkipHttpErrorCheck).StatusCode }
```

Pass = `302` (redirect path taken), **or** `200` with `x-vercel-cache: HIT` on attempts 2-3 if a
different approach is chosen. A third consecutive `MISS` means the fix did not take.
Then confirm Fast Data Transfer on the Vercel dashboard returns toward the 0.02 GB / 5 min baseline.

---

## Item 3 — the 504s: the route's 502 fallback is unreachable

**File:** `app/api/public/ipfs-media/[cid]/route.ts` (L42, L44-48). Same file as item 2 — fold into one commit.

### Root cause

The route intends to fail soft:

```ts
signal: AbortSignal.timeout(25_000),
} catch {
  // Gateway timeout/fault — 502 so the <img> onError can advance to the next
  // candidate / placeholder.
  return new NextResponse(null, { status: 502 });
}
```

But the observed platform error is:

```
GET /api/public/ipfs-media/QmSzQor91… 504 [error/serverless-middleware]
Error: Your function was stopped as it did not return an initial response within 25s
```

The abort is set at exactly the platform's own cutoff, so **the platform always wins and the `catch`
never runs**. The `<img onError>` candidate-advance chain the comment describes is dead code for
precisely the slow-gateway case it was written for — the browser gets a 504 with no body instead.

Lower the timeout to ~8-10s so the abort fires first and the 502 fallback actually works. This also
bounds the damage from item 2: a slow 17.5 MB fetch currently occupies a function for the full 25s.

### Measurements

5xx on this route, from `pipeline`-independent Vercel runtime logs grouped by `statusCode`:

| window (UTC) | 504s |
|---|---|
| 12:25–13:05 | **205** |
| 13:50–14:40 | 2 |

**The burst has already subsided on its own** — consistent with ipfs.io recovering, not with anything
in the codebase changing. Alert-wise this one is self-resolved; the reason to still fix it is that the
soft-fail path is proven not to work, so the next gateway wobble reproduces it exactly.

### Revert path

Revert the single commit (shared with item 2).

### Verification

Covered by item 2's check. Additionally, `Vercel → runtime logs, statusCode 504, route
/api/public/ipfs-media/[cid]` should stay at 0 through the next ipfs.io slow period.

---

## Not a defect — checked and cleared

- **`/profile/<0x…>` enumeration.** A client is walking Flow addresses against `/profile/` at roughly
  one every 25s, all returning `found=false`. Verified this does **not** trigger a wallet backfill:
  `app/api/public/profile/[username]/route.ts` performs three Supabase reads and nothing else. The only
  anon-reachable backfill trigger is `POST /api/public/queue-wallet`, whose sole caller is
  `app/share/[wallet]/ShareEmptyState.tsx:75`. Noted only because it looks alarming in the logs.
- **The `wallet-backfill*` burst (11:56–13:29 UTC, 135 runs × 6 lanes).** All `ok=true`,
  all `rows_to_write: 0` / `skipped_cached: N`, `terminated_reason: no_more_moments`. This is the
  `seed-wallet-refresh` cohort sweep behaving correctly. It is **not** the Fast Data Transfer source —
  the timing overlap is coincidental.

---

## Guardrails

- **Direct to `main`. No branches, no PRs** (CLAUDE.md non-negotiable). If a `claude/*` branch is
  pre-checked-out, `git checkout main` first.
- **Commit via PowerShell `git`** on Windows — Git Bash `git commit` can silently no-op. Re-verify with
  `git rev-list --count origin/main..HEAD` (expect `0`).
- **`curl` fails silently in Git Bash for Vercel REST** — use PowerShell `Invoke-WebRequest`.
- **Vercel Pro `maxDuration` hard cap is 800s** — anything higher sends the deploy to ERROR invisibly.
  Both resolver routes are at 300; leave them there.
- **CRLF:** do not string-replace-patch on Windows. Use full-file writes, or `findIndex` on split lines.
- Per CLAUDE.md conventions, land these as **full file replacements**, not patches.

**Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any
disagreement — adapt to the actual file shape.** Line numbers here are from
`a1896d6673635a7400df309952d6c994c9f75918` and will drift.

---

## Expected end state

Two or three commits on `main`, deploys READY, and:

- `allday-unmapped-resolver` reporting a **varying** `candidates` count with `onchain_resolved > 0`,
  and `still_unresolved` falling from ~50k for the first time since 07-26.
- Fast Data Transfer back toward the 0.02 GB / 5 min baseline, with video CIDs either redirected or
  no longer fetched on page load.
- `/api/public/ipfs-media/[cid]` returning a fast 502 instead of a 25s 504 when ipfs.io is slow.
