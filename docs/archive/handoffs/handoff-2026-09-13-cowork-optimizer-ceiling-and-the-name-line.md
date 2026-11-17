# Handoff → Cowork · 2026-09-13 (PT) — closing out verification `2026-09-12(h)`

**From:** Claude Code (cloud session) · **For:** Cowork
**Input:** your `2026-09-12(h)` — *"the optimizer leg works, rendered end-to-end from production"*
**Output:** docs + one comment-only code change. **No DB, no behaviour change, nothing user-visible shipped.**

**One sentence:** your two open items are resolved as far as they can be from a cloud
session — the `/_next/image` ceiling is **measured at ≈14,469** and corroborates the earlier
≈14.3k estimate, the player-name finding is **real but was scoped to the wrong card** and is now
**rendered and verified** rather than argued — and along the way I published four wrong things and
caught all four myself, which is most of what is worth reading here.

---

## 1. Your open item — the `/_next/image` unit cost

**The count half is measured. The price half is Trevor's, and it is one glance.**

| leg | distinct `(source, w=640, q=75)` |
|---|---|
| Top Shot statics | 8,408 |
| Top Shot IPFS → our proxy | 2,361 |
| Disney Pinnacle | 2,600 |
| LaLiga Golazos | 575 |
| UFC Strike | 518 |
| trophy double-keys (see §4) | +7 |
| **NFL All Day** | **0** — origin pre-sizes all 6,190, `ogOptimizedTarget` correctly skips |
| **Candy MLB** | **0** — `arweave.net` absent from `remotePatterns` |
| **total** | **≈14,469** |

⭐ **This corroborates the same night's earlier ≈14.3k estimate rather than replacing it** — three
legs match to within four rows, the IPFS leg matches exactly. The only real delta is Pinnacle,
stated there as a bound (`≤2,412`) and now measured at 2,600.

🔵 **The better question underneath, and it is cheaper than the price.** `next.config.ts › images`
declares only `remotePatterns`, so `minimumCacheTTL` is Next **16.2.9**'s default — read from the
installed package, not memory: **14,400 s = 4 h**. Effective TTL is the max of that and the
upstream `Cache-Control`. ⛔ **I could not measure that header.** Egress to the art CDNs *and* to
our own domain returns an explicit **`connect_rejected — organization policy`** from the agent
proxy. **So whether ≈14,469 is one-time or recurring is open, and it decides whether the count
matters at all.** If it recurs, an explicit long `minimumCacheTTL` is the lever — the art is
edition-keyed or content-addressed and effectively immutable.

**→ Over to you / Trevor:** Usage → Image Optimization. You have egress; I do not.

---

## 2. Your other open item — the unnamed hero card

**Real. Scoped to the wrong card, in the direction that makes it bigger. And now verified.**

You compared `trophy-case/[username]` (renders `player`) against `profile/[username]` — but those
are **two different cards, not two layouts of one**. The profile card renders **only serial + tier
at every grid size, 1 through 6**. ⭐ **`player_name` is already on the row and already fetched;
its sole appearance in that route's render path is a `console.log` at line 580.**

So it is not *"should the hero match the grid"* at 4 of 7 collectors — it is **"should the profile
card name players at all", at 7 of 7**.

🚨 **And I was wrong that this needed a session with egress.** I recorded that blocker twice. It
conflated the **art** with the **geometry**: the art needs egress, the text layout does not, and the
whole risk here is text layout. `next/og` renders offline. **Four cases verified as PNGs and looked
at:**

| case | tile | string | result |
|---|---|---|---|
| hero | 240×317, 14px | `Victor Wembanyama` (17ch, longest pinned) | ✅ own line above `#46 / 199 RARE` |
| six-up | 130×172, 10px | same | ✅ fits, legible |
| hero, worst tail | 240×317 | 37-char UFC title | ✅ clean ellipsis, one line |
| six-up, worst tail | 130×172 | same | ✅ clamps, no wrap, no mid-glyph slice |

Budgets (TTF-derived **0.540em**, the figure the caption guard already pins): hero **30** chars,
six-up **22**. Across **21,234** named editions, **9** exceed the hero budget (all UFC Strike,
longest 48) and **221** exceed the six-up one — so the existing `nowrap` clamp stays required.

⛔ **Not shipped, and the blocker is now honest and singular: it is Trevor's product call.** You
filed it that way and you were right; measurement cannot settle it. Everything measurement *can*
settle is done, and the four PNGs went to him.

**→ If he says yes:** one strip in `app/api/og/profile/[username]/route.tsx` reusing `t.player_name`,
plus the `nowrap`/ellipsis the tiles already carry.

---

## 3. ⭐ Two harness gotchas you will want, because they bite Cowork too

Promoted to [`tooling-gotchas.md`](reference/tooling-gotchas.md). Either alone makes an OG probe a
**confident lie**:

1. ⛔ `import { ImageResponse } from "next/og"` **fails under plain node** — use
   `./node_modules/next/og.js`, repo as cwd.
2. 🚨 **`brandFonts()` FETCHES the TTFs from `${BASE_URL}/fonts/…` and a blocked fetch degrades
   SILENTLY to `sans-serif`.** A probe calling it measures a face the product never ships, with no
   error anywhere. **Read `public/fonts/ShareTechMono-Regular.ttf` off disk** — production serves
   those same bytes. ⭐ This is CLAUDE.md's own `brandFonts()` harness-divergence trap met from the
   opposite direction: there, *no* fonts made `→` cost no fetch; here, *no* fonts would have
   silently changed the glyph advance the entire question turns on.

**What this unblocks for both of us:** any caption / badge / serial-strip layout question is now
answerable from a no-egress session with a rendered PNG — the instrument this repo trusts.
**What it still cannot answer:** whether a given upstream's art loads, its byte size, or anything
about the live route's data. Those stay yours.

---

## 4. 🚨 The four things I published wrong, and how each was caught

Worth more than the numbers, and the pattern is consistent: **the cheap wrong answer was the one
that looked fine.**

1. **The population trap — and the wrong number was the flattering one.** Pinnacle first measured
   from **`pinnacle_editions`** (570 rows, 270 distinct art urls) → a confident **≈12,130**, which
   read as a *16% improvement* on your estimate. The sitemap reads **`pinnacle_catalog`** — 2,600
   rows, **9.6× larger**. ⭐ Nothing about ≈12,130's shape said it was wrong; only re-deriving the
   predicate did. The stale `~2,079 rows` comment beside that query is now marked as a dated sample.
2. **Errors that cancel, invisible to every guard.** The two Top Shot legs shipped as 8,401 / 2,368
   because I **derived one by subtracting the other from a measured total**, taking the subtrahend
   from a query counting **rows, not distinct urls**. Truth: 8,408 / 2,361. ⭐ **The subtotal and
   grand total were right the whole time and the errors cancel — which is why nothing reddened.
   A total that agrees with itself is not evidence that its parts do.**
3. **A load-bearing claim bounded by a population, not by the code.** "Entity cards add ~zero" is
   true (they and the edition card pass `thumbnail_url` raw). It was incomplete about the **trophy**
   cards: both pass `hiResThumb(...)`, whose `?width=640` lands **inside** the optimizer's `url=`,
   so a Top Shot static on a trophy tile is a **different key**. Measured: **7 of 22** pinned
   trophies double-key. ⭐ The 7 is not the point — the claim held only because trophies are 22
   moments.
4. **My fix for (3) named a file the web UI depends on.** I recommended *"apply `hiResThumb` to
   render endpoints only"*. ⚠ **`hiResThumb` is not an OG helper** — `components/TrophySlab.tsx`
   uses it for the web slab, where `width=640` is the whole point (stills are stored at
   `width=180`). It belongs in `ogOptimizedTarget` instead. ⭐ **Declined on SIZE, not evidence:**
   the bare static url is the shape the edition and moment cards already use and *you* verified both
   render real art — but **7 keys out of ≈14,469 is 0.05%, and an eligibility count is not a gain
   count.** Exit condition: if Trevor's glance says the bill is real, this is first and the evidence
   is in hand.

---

## 5. ⚠ A new ledger shape, found by a hook rather than a person

Promoted to [`ledger-discipline.md`](reference/ledger-discipline.md). **A `Shipped:` line has a
shelf life, and the session that wrote it is the one that falsifies it.** My entry opened
`Shipped: … No code, no DB` — **true when written**; two commits later the same session shipped a
`.ts` comment fix and the line under-reported its own blast radius.

⭐ **No defective write is involved — an accurate entry plus ordinary later work equals an
inaccurate one — so every existing defence is blind to it:** heading count unchanged, swallowed
count unchanged, resolver never runs, and **nothing in CI reads a `Shipped:` line**. The cost is the
revert path: a reader reverts one docs commit and leaves the code commit live.

**Rule: re-read every `Shipped:` line you wrote this session against the real commit range before
ending the turn, and correct it IN PLACE.** ⭐ It caught itself on first application — the 09-13
entry said four files and the §2 probe made it five.

---

## 6. Also worth knowing

- ✅ **Your `imageConfigDefault` suggestion was already shipped** in `__tests__/og-img-data.test.ts`
  as of `0f9196dac` — including the Accept case asserting
  `imageConfigDefault.formats.filter(f => accept.includes(f))` is **empty**, a property that
  survives a future Next release adding a format.
- **Nothing was promoted to CLAUDE.md.** It has **36 characters** of headroom and the parent rules
  for everything learned here are already in it (*"a control's population must be the set the
  property is true of"*, *"diff the SET not the count"*, the `brandFonts()` harness trap). The
  instances live in the register and reference docs instead.
- 🤝 **Two concurrent sessions, no collision.** The ledger conflicted once and was resolved with
  `scripts/resolve-ledger-rebase-conflict.mjs` rather than by hand (+1 exactly, swallowed still 3,
  zero markers). ⭐ My docs-only tip landed on a code commit — the trap CLAUDE.md warns about — and
  the **new deploy gate (#97) handled it correctly**, diffing against the last *deployed* sha. My
  `lib/sitemap-data.ts` commit was its first real test and built: `2007d3ae6` READY, apex aliases
  attached, `lambdaRuntimeStats` present.

---

## Open, stated rather than quietly dropped

| # | item | blocked on |
|---|---|---|
| **#95** | `/_next/image` **price** per transformation | **Trevor** — Usage → Image Optimization |
| **#95** | upstream `Cache-Control` → is ≈14,469 one-time or recurring? | **egress** (org policy) — Cowork or desktop |
| **#96** | should the profile card name players? | **Trevor** — product call; all measurement done, PNGs sent |
| **#95 §4** | unify the 7 trophy double-keys in `ogOptimizedTarget` | **declined on size**; revisit only if the bill is real |

**Register:** `#95`, `#96`. **Session log:** `docs/sessions/2026-09.md`, 09-12(h) entry.
**Ledger:** 2026-09-12 `🔵 MEASUREMENT+CORRECTION` and 2026-09-13 `📗 DOCS`.
**Revert:** every commit independently; none has a DB half.
