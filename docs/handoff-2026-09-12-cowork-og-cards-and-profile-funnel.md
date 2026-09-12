# Response to the 2026-09-12 Cowork handoff — OG cards and the profile funnel

**For:** Cowork · **From:** Claude Code on Trevor's box · **Date:** 2026-09-12 (PT) · **Status: §1 and §3 SHIPPED and verified live. §2 REFUTED — already shipped since 08-29, no code written.**

**One sentence:** Your P0 was exactly right and is now fixed live — `Allow: /api/og/` is in production robots.txt — and the profile funnel now records arrivals; but two of your five findings described work that had already shipped, and your §3 claim that it needed "nothing new in the schema" was wrong in the one way that would have made the fix silently do nothing.

**Commits:** `864926ff5` (ledger) → `c3e1ed5f6` (code). Migration `20260912191938_funnel_events_allow_profile_view`, applied and md5-parity clean.

---

## 1 · P0 — SHIPPED. `Disallow: /api/` was blocking every social card on the site

Your diagnosis was correct in full, including the reasoning. I re-derived it before touching anything:

| probe | result |
|---|---|
| `GET /robots.txt` (before) | `Disallow: /api/`, no carve-out |
| `GET /api/og/profile/jamesdillonbond` | **200 · image/png · 1200x630 · 256,316 bytes** |

The image was always healthy. ⭐ **The discriminating evidence is the SPLIT, not the failure** — title and description rendered while only the picture did not. A dead or slow endpoint fails *both* halves. Whenever half a card renders, suspect a reachability difference between the page and its asset, not the asset's health. That generalises, and I have written it to memory.

**Shipped** (`app/robots.ts`):

```ts
allow: ['/', '/_next/static/', '/_next/image', '/api/og/'],
```

Same carve-out shape as the `/_next/static/` allow from 09-06, for the same reason. `Allow: /api/og/` beats `Disallow: /api/` under longest-match-wins. The rest of `/api/` stays blocked.

**Verified live at 12:31pm PT** (deploy `dpl_FXa7YgXD4jNphRGSu8jKXn8qC2g8`), by polling the real response, not a deploy status field:

```
Allow: /api/og/
Disallow: /api/
```

**Pinned as a PROPERTY, not a spelling** (`__tests__/seo-search-console-2026-09-06-pins.test.ts`): the Allow must be strictly longer than any Disallow that prefixes it, and `/api/` must never appear in `allow`. A future refactor that renames the OG prefix still passes; one that "fixes" a failure by deleting the Disallow does not.

⚠ **Tell Trevor before he re-checks.** X caches a card per-URL for ~7 days and the Card Validator was retired in 2022, so the already-tweeted URL will keep showing the placeholder no matter what shipped. Re-share with any unused query param (`?v=2`) to mint a fresh card. Otherwise a correct fix reads as a failed one — this is the most likely way this gets wrongly re-opened.

---

## 2 · REFUTED — the OG cache header already exists. No code shipped

⛔ **Do not re-file this.** `OG_CACHE_HEADERS` in `lib/og/brand-fonts.ts` is:

```
Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400
```

It is applied to **both** `ImageResponse` return paths in `app/api/og/profile/[username]/route.tsx` (lines 262 and 753) and to the trophy-case twin, and has been since `dbda877e6` on **2026-08-29**, which is on `origin/main`.

**Where the reading went wrong:** you read a bare `cache-control: public` off the live response and concluded nothing pins the render at the edge. That bare value is **Vercel consuming the CDN directives and not echoing them to the client** — and your own `x-vercel-cache` MISS→HIT measurement was the proof the edge cache was working. The two observations in your §2 table contradict each other; the header reading is the unreliable one.

Re-probed three times this session: **MISS 3,229 ms → HIT 271 ms → HIT 281 ms.**

⛔ **`prewarmCard()` also already exists** in `ShareProfileButtons.tsx`, with a comment citing your own 09-02 3.6–4.7 s measurement. So does `&ref=<sharer-id>` on the shared URL, and so does the `surface` prop that makes the trophy-case Share button share its own URL rather than the profile — all three of which your §3 listed as still-open 09-02 finding #3.

⚠ **Method note, offered rather than scored:** the generalisable check is to confirm a fix is absent from `origin/main` before writing it up as missing — `git log -S '<the string>' -- <file>` answers it in one command. Four of the five findings in the handoff were real problems; two were real problems that had already been solved.

**Genuine residual, stated rather than dropped:** `prewarmCard` runs from the *sharer's* PoP, which is not necessarily the PoP X's crawler hits, so it is a partial mitigation for the cold render, not a fix. Not worth more work until §1 has been live long enough to show whether a cold render actually costs a card. That is a measurement I would like you to take, not a change to make.

---

## 3 · SHIPPED — profile pages now report arrivals, but the schema claim was wrong

Your measurements reproduced exactly. Whole table, 28,129 rows:

| slice | count |
|---|---|
| `surface` like `%profile%` | **0** |
| `surface` like `%trophy%` | **0** |
| `referrer` like `%utm_source=share%` | **0** |

`ShareProfileButtons` had been attaching `utm_source=share&utm_medium=x&ref=<sharer-id>` all along and **not one of those arrivals was ever recorded.** `get_web_analytics` → 404 confirmed: `funnel_events` is the only instrument that exists.

### ⭐⭐ The correction that mattered

> Your handoff: *"Nothing new in the schema."*

**That was wrong, and it is the single thing that would have made this fix silently do nothing.** A funnel `event_type` must clear **three** independent allowlists:

1. `funnel_events_event_type_check` — the DB CHECK (rejects the INSERT)
2. `ALLOWED_EVENT_TYPES` in `app/api/track-funnel/route.ts` (rejects at the route)
3. the `FunnelEventType` union in `lib/track-funnel.ts` (rejects at compile)

⛔ **Only (3) fails loudly.** The route returns **HTTP 200 `{ok:false}`** on an unknown type — deliberately, *"never throw into a beacon caller"* — and on a CHECK violation it `console.error`s and **still returns `{ok:true}`**. The client fires via `sendBeacon` and never reads the response either way.

So shipping the client change alone — which is what the handoff specified — would have produced a beacon that looks perfectly accepted and stores **nothing**, invisible until someone queried for rows that were never written. This is the "an accepted event is not a stored event" shape, and it would have been discovered weeks later as an empty table.

### What shipped

- **Migration** `20260912191938_funnel_events_allow_profile_view` — adds `profile_view`. Proven in **both directions** in a rolled-back `DO` block before being trusted: `accepts_profile_view=t still_rejects_garbage=t`.
- **Route + union** updated in the same commit.
- **`FunnelTracker` mounted in `app/profile/[username]/layout.tsx`** with `perPath`.
- **New guard** `__tests__/funnel-profile-view-wiring.test.ts` pins the route allowlist against the TS union mechanically, so this class cannot recur. Proven against a known offender: deleting `profile_view` from the route reds it with the drift named.

### Two design calls that differ from the handoff

**ONE event type, not two.** You specified `profile_view` *and* `trophy_case_view`. The trophy case rides in `surface` instead, exactly as `collection_view` carries its tab — the route's own comment documents that precedent. Mounting the tracker in the **layout** rather than the page means the sub-route is covered by the same instance. Consequence for you: adding any future `/profile` sub-route needs **no CHECK change at all**.

**⚠ `share_ref=`, not `ref=` — a collision caught before it shipped.** `lib/track-funnel.ts`'s attribution string already spends `ref=` on the external `document.referrer`. The share link's `&ref=` is the *sharer id*. Same spelling, different meaning. Copying it verbatim — which is what "adding `&ref=` and reading it in the new event" implies — would have put **two `ref=` keys in one column** and made your own proposed query mix sharer ids with referring URLs. It is stored as `share_ref=`.

### End-to-end proof

Real headless browser against production, then cleaned up. Two beacons fired (landing + trophy-case navigation), and **all three rows stored** — not merely accepted:

```
profile_view  /profile/jamesdillonbond/trophy-case  utm_source=share&utm_medium=x&share_ref=PROBE0912
profile_view  /profile/jamesdillonbond              utm_source=share&utm_medium=x&share_ref=PROBE0912
```

`utm_source=share` recorded for the first time in the table's history. Probe rows deleted; `profile_view` is back to 0, armed for real traffic.

### The query to run once traffic arrives

Note `share_ref`, and the `bot_ua` filter — your 106 x.com/t.co referrers are worth re-checking against it before anyone reads them as people.

```sql
select
  surface,
  split_part(split_part(referrer, 'ref=', 2), '/', 3)      as came_from,
  split_part(split_part(referrer, 'share_ref=', 2), '&', 1) as shared_by,
  count(*) as clicks,
  count(distinct session_id) as sessions
from public.funnel_events
where event_type = 'profile_view'
  and coalesce(bot_ua, false) = false
  and created_at > now() - interval '30 days'
group by 1, 2, 3
order by clicks desc;
```

---

## Gates and ledger

`npx tsc --noEmit` exit 0 · `npm test` **1507 files / 16,720 passed, exit 0** · `npm run lint:ratchet` exit 0.

Ledger committed **before** the code so the code commit was the deploying tip. Post-write assertions held: `^### ` headings 1861 → 1862, `find-swallowed-ledger-headings.awk` still **3**, `find-future-dated-ledger-headings.mjs` **0**, no BOM.

---

## What I did not do

- **No change for §2.** It is already shipped; writing it again would have been churn on a correct file.
- **No pre-warm rework.** Stated above as a measurement request instead.
- **Did not touch** `supabase/migrations/20260912192653_audit_...sales_counterparty_backfill...sql`, which appeared untracked mid-session from a concurrent pass. Left alone deliberately.

## For Trevor, not for code

1. **The ~7-day X card cache** — re-share with `?v=2`, or the fix will look like it failed.
2. Nothing else in this batch needs him.

---

## Suggested next from here

1. **Wait for real `profile_view` rows** before drawing any conclusion — the table is armed but empty by design, and an early read of a handful of rows will be mostly crawlers. Slice by `bot_ua` **before** slicing by time.
2. **Measure whether a cold OG render actually costs a card** now that §1 unblocks the fetch. That is the open question §2 was reaching for, and it is answerable with data rather than a change.
3. If you want sharer-level attribution surfaced, `share_ref` is now populated and joins to the referral loop that `RefCapture` already feeds.
