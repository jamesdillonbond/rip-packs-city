# Handoff — anon telemetry 405s, home page has no canonical, Pack Sniper ships an empty server table

**Date:** 2026-08-23 09:36 PT · **From:** weekly surface QA (`rpc-surface-qa`), run from Claude Code on Trevor's box · **For:** whoever ships next

## Context

This run had a real browser (local Playwright + Chromium) and DB access, so it could do two things the
Cowork run structurally cannot: read the **served HTML** separately from the hydrated DOM, and reach a
**true 390px viewport** (Cowork's `resize_window` bottoms out at 738px).

All three findings below are route/`.tsx`/`proxy.ts` changes. **Nothing here is shipped.** Finding A
touches `proxy.ts`, which is explicitly off-limits to autonomous shipping and wants a human decision on
the abuse trade-off before it lands.

HEAD at time of writing: `34a42c11`. Note another session was committing concurrently during this run.

---

## Finding A — every anonymous telemetry beacon is dropped with a 405 (P1, instrument is dead)

**Severity: highest of the three.** This is the top-of-funnel instrument behind the 50-WAU
monetization gate, and it has never worked for anonymous visitors.

### What was observed

Every page load on production — home, insights, pack pages, moment pages, at both viewports — logs
exactly one console error:

```
Failed to load resource: the server responded with a status of 405 ()
```

Capturing the request shows what it is:

```
405  POST  https://www.rippackscity.com/login?next=%2Fapi%2Ftelemetry   (resourceType: ping)
```

`lib/telemetry/track.ts` beacons `POST /api/telemetry`. `proxy.ts`'s `isPublicPath` does not allow
that path, so an anonymous POST is **302'd to `/login`**, and the login page has no POST handler →
**405**. `navigator.sendBeacon` failures are silent by design (`track.ts`: "Failures are silent.
Telemetry never blocks UI"), so nothing has ever surfaced this.

### Why it matters more than a stray console error

`app/api/telemetry/route.ts` is explicitly written to record anonymous traffic — its header says it
falls back to `"anon"` "for fully unauthenticated callers", and the body sets `let walletAddress = "anon"`.
**That branch has never executed in production.**

### DB confirmation, with controls in both directions

```
identity_bucket                    rows   first_seen   last_seen
wallet (authed)                     306   2026-07-23   2026-08-23   <- positive control: the table IS written
user:<uuid> (authed, no wallet)       6   2026-08-08   2026-08-08
anon (unauthenticated)                0   —            —            <- never once, in a full month
```

The positive control matters: the pipeline is healthy and writing today, so zero `anon` rows is not a
dead pipeline — it is precisely what the 405 predicts. Authed users carry the session cookie, so the
proxy lets them through; anonymous users get redirected and their beacon dies.

This is the "unfalsifiable instrument" shape CLAUDE.md warns about: the failure's output is silence.

### Fix, and the decision it needs

Add `/api/telemetry` (POST) to `isPublicPath` in `proxy.ts`.

**This is a genuine judgement call, not a mechanical fix** — opening the endpoint to anon means anyone
can write `usage_events` rows. The route already normalizes `feature` (lowercased, `[^a-z0-9_-]`
stripped, capped at 80 chars) and caps metadata at 4096 bytes, so the blast radius is row-count spam
rather than injection. Worth deciding whether it ships with a rate limit. That trade-off is why this
is a handoff and not an auto-ship.

**Do not "verify" the fix by watching the console alone** — confirm an `anon` row actually lands in
`usage_events` after deploying.

---

## Finding B — the home page emits no `<link rel="canonical">` and no `og:url` (P2, SEO)

### What was observed

Live head audit of `/`:

```
canonical : null
og:url    : null
link rels : stylesheet, preload, icon, apple-touch-icon, preconnect, dns-prefetch
```

Every other page checked this run has one — `/insights`, `/insights/pack-sniper`,
`/nba-top-shot/edition/124:4493`, `/pinnacle/moment/<render_id>`, `/nba-top-shot/pack/dist/4184`.
The home page is the only surface missing it.

### Root cause

`app/layout.tsx:13` is `export const metadata: Metadata = rootMetadata`, and `rootMetadata`
(`lib/seo.ts:26`) sets `metadataBase`, `title`, `openGraph` and `twitter` but **no `alternates`**.
Collection pages get theirs from the builder at `lib/seo.ts:212` (`alternates: { canonical }`).
`app/page.tsx` exports no metadata of its own, so home inherits the gap.

### Recommended fix — and a footgun to avoid

Add a metadata export to **`app/page.tsx`**, not to `rootMetadata`:

```ts
export const metadata: Metadata = { alternates: { canonical: "/" } }
```

⚠ **Do not put `alternates.canonical` on `rootMetadata`.** Next resolves metadata by inheritance, so a
root-level canonical would be inherited by every descendant that does not set its own — pointing a pile
of pages at the homepage. That is strictly worse than the current gap. Scoping it to `app/page.tsx`
avoids the question entirely.

Adding only `alternates` also sidesteps the documented shallow-merge trap (`lib/seo.ts:174`): because
this export does not redefine `openGraph`, the root's block survives intact. If you also want `og:url`,
you must restate the whole root `openGraph` object, not just add `url`.

---

## Finding C — Pack Sniper's server-rendered table is empty, defeating the board's stated SEO purpose (P2)

### What the page promises

`app/insights/pack-sniper/page.tsx` header comment:

> This puts the ranked table AND the per-row drill-down links (`/<collection>/pack/dist/<distId>`) into
> the raw server HTML so the unique content is crawlable.

### What the served HTML actually contains

Fetched with a Googlebot UA, counting markers in the raw response body:

```
/insights/pack-sniper   status=200  bytes=64380
  /pack/dist/ links   : 0
  packDetail= refs    : 0
  dapper.market refs  : 0
  'PARTIAL DATA'      : false      <- not a failure; the fetch SUCCEEDED and returned nothing
```

Meanwhile the hydrated DOM renders **84 rows**. So a crawler sees a board with zero deals; a human sees
a full one.

### Root cause — the 2026-07-09 client fix was never applied to the server half

The server component hardcodes the filter (`page.tsx`, in `fetchInitial()`):

```ts
getPackDeals("nba-top-shot", { limit: 200, includeHighVariance: false })
```

The client defaults the opposite way — `include_high_variance=true` — which is correct and deliberate
per the 2026-07-09 reconciliation, on the reasoning that *"defaulting to hide would render an empty
board whenever every listed pack is high-variance, which is common."*

**That is exactly what is happening on the server right now.** Direct API A/B:

```
TS  include_high_variance=false  (what the SERVER fetches) -> deals=0
TS  include_high_variance=true   (what the CLIENT fetches) -> deals=84
    stats: matched=84  highVariance=84   <- all 84 matched TS packs are high-variance
```

No-change control, so this is the filter and not a broken API:

```
AD  include_high_variance=false -> deals=30
AD  include_high_variance=true  -> deals=95
    stats: matched=95  highVariance=65
```

The client fix **masked** the server bug: because users see a full board, nobody noticed the HTML was
empty. Only a crawler — or a served-HTML measurement — can see it. `/insights/pack-sniper` is in the
sitemap and linked from both the `/insights` hub and the footer, so this is lost organic reach on a
board that was built for it.

### Fix

Change `includeHighVariance: false` → `true` in `fetchInitial()` so the server view matches the client
default. High-variance packs are already flagged in the row rendering, so this does not present lottery
packs as honest deals.

No hydration risk: `initialDeals` seeds `useState`, and the client refetch happens in `useEffect`, so
this is a state update rather than a server/client text mismatch.

**Verify by grepping the served HTML for `/pack/dist/`, not by loading the page in a browser** — the
browser shows the client-fetched rows either way and will look fine while the bug is fully intact.

---

## Also worth knowing (no handoff needed)

- **`/insights/serial-premiums` was live-degraded during this run** — `PARTIAL DATA · 1 of 1 section
  could not be loaded (Serial premiums)` with 0 rows. That is the honesty layer working correctly, not
  a defect. Consistent with the known disk-IO saturation. Flagging only so it is not mistaken for new.
- **`Math.random()` used as a React key** at `app/insights/squeeze-check/page.tsx:206` and
  `app/insights/tc-report/page.tsx:268` (`<tr key={r.edition_key ?? Math.random()}>`). Cosmetic in a
  server component — keys are not serialized, so there is no hydration exposure — but it defeats
  reconciliation whenever `edition_key` is null. Low priority; a stable index-based key is the fix.
- **A transient "This moment didn't load" was observed once** on `/moment/<id>` (1 of 6 loads), then
  5/5 clean on re-probe. The fallback copy is exemplary — *"This says nothing about whether the moment
  exists — only that we couldn't read it"* — with `robots: noindex, follow`. Working as designed.
