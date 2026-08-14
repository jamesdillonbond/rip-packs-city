# Profile flair + social-preview backlog (Claude Code, 2026-08-13)

Filed from an interactive audit of the profile page, trophy case and the
Twitter/X share path. Four waves shipped the same session (profile unfurl
metadata, OG card branding + flair + legible trophy case, trophy captions,
trophy-case error honesty — see the ledger). Everything below is what was
FOUND and NOT taken, with the measurement that motivates it.

Read the ledger before acting: some of these may have been picked up.

## ⚠ STATUS UPDATE — most of this was drained the same day

After Trevor said "default the RPC username to the Top Shot username, keep
going on the rest", the following were SHIPPED (see the ledger for each):

| # | item | outcome |
|---|---|---|
| 1 | no public profile / no way to find it | **DONE** — handle defaults from the Dapper username, the 16 existing collectors were backfilled (**4/20 → 20/20**), and `PublicProfileCard` puts the live URL on the dashboard |
| 3 | no unequip path | **DONE** — `DELETE /api/rewards/equip` + "Equipped · Take off" |
| 7 | duplicate pin + 96-cap | **DONE** — already-pinned Moments marked `PINNED`, dimmed and inert; the page cap is now disclosed instead of the search blaming the collection. *(no grid preview step still open)* |
| 8 | mobile/keyboard reorder | **DONE** — `←`/`→` controls in Edit Layout; math extracted to `lib/trophy/reorder.ts` and gate-measured |
| 9 | hardcoded Top Shot on the profile | **DONE** — label derived from holdings |
| 10 | no Cache-Control on OG cards | **DONE — all 43** |
| 11 | catchless OG routes | **DONE** — deal/collection/default |
| 12 | unbranded OG cards | **DONE — all 43**, behind one shared loader, with a completeness guard (not a floor) |
| 13 | no trophy-case share surface | **DONE** — `/profile/<u>/trophy-case` + `/api/og/trophy-case/<u>`, linked from the profile |
| 14 | tweet hardcodes one collection | **DONE** — collection-agnostic, names the trophy case |
| 15 | `twitter.site` casing | **DONE** — unified, test asserts agreement not a literal |
| 16 | no metadata tests for /share and /moment | **DONE** — both now have contract tests; `/moment` also gained image dimensions + alt, `/share` a `twitter.description` |
| 2 | cosmetics on a separate page | **DONE** — `/profile/edit` previews the equipped border/banner and links to Rewards |
| 4 | `/profile/edit` has no preview | **DONE** — `ProfileHeaderPreview`, live as you type, sharing `lib/cosmetics.ts` with the public page |

**2026-08-14 — 7 is now fully DONE and 5 is ASSESSED. Only 6 remains.**

| # | item | outcome |
|---|---|---|
| 7 (rest) | grid tab pinned with no preview | **DONE** — a tap SELECTS, only the confirm button writes, and the confirm step **names the trophy it will replace**. The pin is an OVERWRITE with no undo, so a mis-tap on a 72px row silently destroyed a chosen Moment behind a "Trophy pinned" toast. `occupantOfSlot` extracted to `lib/trophy/reorder.ts` — resolving the occupant by array INDEX would have named the *wrong* trophy inside a destructive confirmation, which is worse than naming none. |
| 5 | cosmetic catalogue hardcoded | **ASSESSED — the product decision is NOT taken (still Trevor's), but the latent defect under it is FIXED.** Measuring it first was the point: a cosmetic SKU is a `shop_items` row (a pure DB insert, no deploy) while its appearance ships in the bundle, **nothing joined the two, and both lookups fail soft** — so a SKU inserted ahead of its style was fully redeemable, took the credits, equipped, and rendered as nothing with no error anywhere. `hasCosmeticStyle()` now gates both the Redeem and the Equip button (and fails CLOSED on an unknown slot). Live check: all 6 SKUs have styles today, so it was latent, not live. **This makes going data-driven SAFER either way** — the ordering hazard it would have introduced is now closed. |

**Still open: 6 only** — slab styles are tier-derived (`lib/trophy/slab-style.ts`
maps everything from `tier`); a per-slab frame the collector picks needs a
`slab_style` column on `trophy_moments`. That is a schema change plus a design
decision about what the finishes are, so it wants Trevor rather than a
self-directed pass.

Noted separately while working #7: `tierAccent` has no case for Pinnacle's
`STANDARD` tier, so those tiles fall back to grey — consistently, so it is a
missing design decision rather than a bug.

**One thing FOUND while building #13 and deliberately not taken:** the older
`/api/og/profile/[username]` card reads `trophy_moments` DIRECTLY, whose rows
are pin-time snapshots carrying null tiers and stale prices. The new
trophy-case card reads through `getPublicProfile`, which resolves via
`get_trophy_slab_data_by_username` for live values. So the profile card's tier
borders are drawn from nulls more often than they should be — a small, real
data-quality gap with an obvious fix (point it at the same module), left alone
because it changes the runtime of a card that was already rewritten twice
today.

---

## The measurement that frames all of it

Live counts, 2026-08-13:

| | count |
|---|---|
| `profile_bio` rows | 20 |
| …**with a username** | **4** |
| …with a tagline | 1 |
| …with an avatar | 1 |
| …with a non-default accent | 2 |
| …with an equipped border | 1 |
| …with an equipped banner | **0** |
| `trophy_moments` rows | 16 (6 users) |
| …with a note | **0** (no UI existed — shipped 2026-08-13) |

**A username is what creates `/profile/<username>`.** So 16 of 20 signed-up
collectors have no public profile at all — nothing to flair, nothing to share.
Every other item here is downstream of that number.

---

## P0 — the funnel, not the features

### 1. Nothing tells a collector that a username unlocks a shareable page
`app/dashboard/page.tsx:790` renders "Edit profile" as the fourth of four
identical ghost buttons (Pack History · History · Alerts · Edit profile), with
no indication that setting a username is what creates a public page, and no
preview of what that page looks like.

Suggested: a dismissible dashboard card, shown only while
`profile_bio.username IS NULL`, that claims the handle inline and links
straight to the live profile. Measure by the `with_username` count above.

---

## P1 — personal flair

### 2. Cosmetics live on a different page from every other profile setting
Borders/banners equip at `/rewards` (`app/rewards/page.tsx:571`); everything
else is on `/profile/edit`, which neither links to them nor previews them.

### 3. There is no unequip path at all
`app/api/rewards/equip/route.ts` only ever writes a value — no route and no UI
clears `equipped_border` / `equipped_banner` back to NULL. A collector who
equips a border cannot take it off.

### 4. `/profile/edit` has no preview
Accent colour, avatar URL and tagline are all set blind (`app/profile/edit/page.tsx:399-421`);
the avatar is a raw URL text field with no upload. A live mini-render of the
profile header would make the whole page feel like customisation rather than a
settings form.

### 5. The cosmetic catalogue is tiny and hardcoded
`lib/cosmetics.ts:27-47` — 4 borders, 2 banners, as literal maps. Zero users
have a banner. Worth deciding whether this becomes data-driven before adding
more SKUs.

### 6. Slab styles are tier-derived only
`lib/trophy/slab-style.ts` maps everything from `tier`; there is no user
choice and no `slab_style` column. A per-slab frame/finish the collector picks
is the natural next flair primitive after captions.

### 7. The trophy picker can pin the same Moment into two slots
`components/profile/TrophyPickerModal.tsx:396` pins on click with no
"already pinned" indicator, and the upsert conflicts on `(user_id, slot)` —
not on `(user_id, moment_id)`. Also: a hard cap of 96 candidate Moments
(`:113-117`, no pagination) silently truncates a large collection, and the grid
tab pins immediately with no preview step (the manual-ID tab does have one).

### 8. Mobile owners cannot reorder their trophy case at all
"Edit Layout" is `display: none` under 768px (`app/dashboard/page.tsx:1539-1541`)
and HTML5 `draggable` does not fire on touch. Auto-Arrange is the only option
on a phone. Needs pointer-events-based reordering or an explicit
move-up/move-down control.

### 9. The public profile hardcodes Top Shot on a five-collection platform
`ProfileClient.tsx` prints "NBA TOP SHOT COLLECTOR" in the subtitle and all
four Quick Links point at `/nba-top-shot/*`, regardless of what the collector
actually holds. The wallet rows already carry `collection_id`.

---

## P2 — link previews

### 10. 42 of 43 OG routes set no `Cache-Control`
Only `app/api/og/profile/[username]` sets one. The rest are `force-dynamic`
with no cache header, so every crawler fetch re-renders (satori + DB reads).
X's crawler times out; a slow card is a missing card. The shared renderer
`lib/og/entity-card.tsx:91,134` covers edition/set/series/team/player in ONE
place, so five cards are one change.

### 11. Three OG routes have no try/catch
`app/api/og/deal`, `app/api/og/collection`, `app/api/og/default` — an exception
is a 500, and a 500 is a blank unfurl. (`og/insights/squeeze-check` also lacks
one but is static copy with no I/O.)

### 12. Every other OG card is still unbranded
The 2026-08-13 wave loaded the brand fonts into the profile card only. The
other 42 render in `system-ui`/`sans-serif`. The loader is ~20 lines and
fail-soft; lifting it into `lib/og/` would brand the whole family. **Do not
skip the byte-difference assertion** — a fail-soft font loader passes any test
that only checks "a PNG came out" (learned the hard way; see the ledger).

### 13. There is no trophy-case-specific share surface
The only trophy-case export is a PDF (`app/api/profile/trophy-case/pdf`), and a
PDF cannot unfurl. A `/profile/<username>/trophy-case` page plus its own OG
card would be the natural "share my case" artifact — and the PDF route already
contains the best artwork pipeline in the repo (brand fonts, per-collection
watermarks, branded placeholder tiles) to draw it from.

### 14. The tweet text hardcodes one collection and omits the trophy case
`components/profile/ShareProfileButtons.tsx:79` —
`"My NBA Top Shot collection on @RipPacksCity…"` regardless of what the
collector holds, and it never mentions the trophy case, which is the visual the
card actually leads with.

### 15. `twitter.site` is inconsistent and missing at root
`lib/seo.ts:53` has `creator: '@RipPacksCity'`; `:241` has
`site: '@rippackscity'` (different casing) and it appears nowhere else. Root
`rootMetadata` sets no `twitter.site` at all.

### 16. No test asserts `generateMetadata` output for `/share/[wallet]` or `/moment/[id]`
The profile unfurl got one on 2026-08-13 (`profile-metadata-unfurl.test.ts`)
after shipping a false `$0` for two months undetected. The same class is
untested on both siblings. `/moment/[id]` is the platform's most-shared URL and
its `images: [ogImage]` (`app/moment/[id]/page.tsx:374`) is a bare string with
no dimensions and no alt.
