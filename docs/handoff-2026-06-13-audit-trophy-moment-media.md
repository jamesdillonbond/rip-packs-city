# Handoff 2026-06-13 — Full-audit findings: moment-hero media 404 + special-serials parity + copy

From the 2026-06-13 evening Cowork full-platform + trophy/top-20 audit. Companion: docs/audits/full-platform-audit-2026-06-13.md. Platform is GREEN; these are correctness/completeness fixes on the moment + trophy surfaces. The trophy-slab live-FMV fix already shipped DB-side (migration audit_20260613_trophy_slab_live_fmv_resolve) — see Item 0.

Order of impact: Item 1 (blank hero on ~30% of premium moment pages) > Item 2 (special-serials parity) > Item 3 (copy) > Item 4 (optional).

---

## Item 0 — ALREADY SHIPPED (DB, Cowork), informational

Migration `audit_20260613_trophy_slab_live_fmv_resolve` rewrote `get_trophy_slab_data(uuid)` to resolve LIVE fmv/tier/circ from the canonical edition (via wallet_moments_cache moment_id -> edition_key -> editions -> latest fmv_snapshot), live-first with frozen fallback, and added an additive `fmv_confidence` key. Root cause: the old `editions` join keyed on `e.external_id = tm.edition_id`, but trophy_moments.edition_id is the inert UUID-pair for TS slabs, so the join failed and every value fell back to frozen pin-time columns (FMV up to 2.6x stale; null tier rendering as "COMMON"; null circ). `get_trophy_slab_data_by_username` delegates to it, so dashboard + public profile are both fixed. Verified live: Deni Avdija ULTIMATE (was COMMON), Lillard Cosmic $425 (was $1,100), Amon-Ra $450 (was $1,045). Security 0/0, grants preserved.

CC follow-up (optional, nice-to-have): the TrophySlab client now receives `fmv_confidence` (HIGH/MEDIUM/LOW/STALE/ASK_ONLY/NO_DATA/null). Surface a small confidence chip on the slab FMV (mirror the moment page's dot) so a STALE/NO_DATA trophy reads honestly instead of looking like a live quote. Purely additive; the key is already in the payload.

Revert (DB): re-CREATE the prior body (frozen columns, `e.external_id::text = tm.edition_id` join) — prior def is in the audit doc.

---

## Item 1 — Moment-page hero renders BLANK on legacy (Series 1-4) editions  [HIGH]

File: app/moment/[id]/page.tsx (the hero `<section className="rpc-moment-hero">`, ~L752-807)

Problem: the hero renders `e.video_url` (else `e.thumbnail_url`) straight from `editions`. Those are the constructed `assets.nbatopshot.com/editions/<set>/<playUUID>/play_..._capture_Hero_2880_2880_Transparent.png` (and `..._Animated_1080_1080_Black.mp4`) URLs. For a large set of older Top Shot editions these assets 404 on the CDN, so the hero is an empty black box. MEASURED on Trevor's top 20: 6 of 21 stored thumbnails 404 — ALL Series 1 editions (LeBron Base Set 2:133, LeBron Metallic Gold 5:133, Harden/Zion/Oladipo Holo MMXX 4:82/4:127/4:142, Lillard Cosmic 8:145). The per-moment CDN form `assets.nbatopshot.com/media/<momentId>/image?width=N` loaded fine for ALL 21 (this is what the trophy slabs already use — their art renders correctly). AllDay is unaffected (its `media.nflallday.com/editions/<id>/media/image` stored form works).

Fix (Top Shot moment pages, kind='moment'): build the hero image from the moment's own nft id and prefer it, with the edition thumbnail as fallback and an onError fallback so the hero is never empty:
- For collection_slug 'nba_top_shot' AND r.kind === 'moment' AND a numeric moment id: heroImg = `https://assets.nbatopshot.com/media/${momentId}/image?width=1080`.
- Keep `e.video_url` as a progressive enhancement IF it loads, but it must not leave a black box when it 404s — set the `<img>` (heroImg) as the always-present base layer, OR drop the autoplay video on TS moment pages and use the image (simpler, and the video URLs 404 on the same legacy editions). Recommend: render the `media/<momentId>/image` `<img>` as the hero for TS moments; attempt the edition video only when present, with `poster={heroImg}` and an onError that hides the video so the poster shows.
- Add `onError` to the hero `<img>` that swaps to the edition thumbnail then to the existing "No media" placeholder — never an empty bordered box.
- The momentId is `r.moment_id` / `ss.nft_id` (already computed as `marketplaceNftId`). Reuse it.
- Leave AllDay/Pinnacle/UFC on `e.thumbnail_url`/`e.video_url` (their stored forms work; Pinnacle uses the 302 image proxy).

Verify: `/moment/134293` (LeBron MetGold), `/moment/25510` (Lillard Cosmic), `/moment/174753` (LeBron Base) — all currently blank — render the moment art after the fix. Spot-check a working one (`/moment/49744949` Clingan) didn't regress.

Note: the same constructed-URL class also feeds entity edition pages (`/<coll>/edition/<key>`) and any grid using `editions.thumbnail_url`. Grids already have an onError placeholder (a1675fc). The edition page hero may have the same blank-box issue for Series-1 editions — worth the same `media/<momentId>` treatment where a representative moment id is available, or at least an onError fallback. Lower priority than the moment page.

Revert: `git revert`.

---

## Item 2 — Special Serials + owners: feature parity gap vs Dapper  [MED]

`special_serial_holders` is EMPTY platform-wide (0 rows / 0 editions). The moment page's `fetchSpecialSerialsForSerial` therefore never returns curated pills; only the inline DERIVED badges (#1 Serial / Low Serial / Last Mint for the viewed serial) ever show. Dapper Market shows a "Special Serials" list with OWNERS for every edition — e.g. LeBron Metallic Gold #258/299: #1 -> Lakers08x24, #23 (jersey match) -> na_mic_tire, #299 (last) -> ticketsftw248. This is exactly the "special serials and their owners" surface Trevor wants.

Two options (product call):
- (a) Minimal: keep the per-serial pills, but populate `special_serial_holders` so #1/jersey/last pills appear when viewing those serials. Needs a backfill deriving first(=1)/last(=circulation)/jersey(=player jersey number, where known) per edition + the current owner from wallet_moments_cache. Jersey numbers aren't reliably in our schema, so jersey_match coverage would be partial.
- (b) Better (Dapper parity): add a "Special Serials" section to the moment/edition page listing #1, #jersey, #last (and #2-10 low) with each holder's @handle (resolveUsernames over wmc owners). This is the higher-value, collector-recognizable feature. Backed by a new RPC `get_edition_special_serials(edition_id)` reading wmc for the canonical edition + resolving owners.

Recommend (b) as a Next-phase build; it's a genuine differentiator and directly serves trophy/grail collectors. Not a quick fix.

---

## Item 3 — "Recent activity" empty-state copy is misleading  [LOW]

File: app/moment/[id]/page.tsx ~L1104. The empty row reads "No sales in the last 30 days." but `get_moment_detail.recent_sales` returns the last ~10 sales ALL-TIME (not 30-day-scoped) — it's only empty when an edition has NEVER traded. Change copy to e.g. "No recorded sales yet." (true for never-traded grails like KD Supernova /10 and Amon-Ra Rookie Revelation, the only 2 of Trevor's top 22 that are genuinely empty). Trivial.

Revert: `git revert`.

---

## Item 4 — Optional: canonicalize trophy_moments.edition_id  [LOW / housekeeping]

4 of Trevor's 6 TS trophy slabs store `edition_id` as the inert UUID-pair (e.g. `2d901e9d…:327bede1…`) rather than the canonical int-pair (`176:7003`). Item 0's RPC now resolves around this via wmc, so it's cosmetic — but a one-time backfill of `trophy_moments.edition_id` to the canonical `editions.external_id` (resolved via wmc moment_id) would make the column trustworthy for any future direct consumer. DB-only, safe. Not required.

---

## Not bugs (verified, do not "fix")
- KD Supernova /10 NO_DATA + Amon-Ra Rookie Revelation empty Recent activity = genuinely never-traded grails. Honest. (Item 0 shows KD's frozen $324.50 as fallback; that's intended.)
- Similar editions = 6 on every one of the 22 audited moments. Parallels populate where they exist.
- /insights/trophies images render (lazy-loaded; not broken).
