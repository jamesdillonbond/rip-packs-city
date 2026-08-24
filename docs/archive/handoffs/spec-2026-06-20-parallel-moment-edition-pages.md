# Spec — parallel-aware Moment Edition pages (2026-06-20)

Build spec for presenting Top Shot SubEdition parallels on the public entity/edition pages. Downstream of Stage B (needs the `::` parallel editions cataloged). Trevor's design decision: **page-per-parallel backbone + a "Parallels" comparison module tying them together — NOT a pure in-page toggle.**

## Why this design (rationale, for context)
- Each parallel IS its own edition after the re-key (own circulation, own serials 1..N, own FMV, own market, **own artwork**). A page-per-edition is 1:1 with the model; a single toggle page fights it.
- Different artwork per parallel means a shared page has no honest single hero/OG image — own pages each render their correct art and share card.
- SEO: own URLs let each parallel rank for its own name + art + price (how collectors search); a toggle hides N-1 parallels behind client state Google can't index. RPC's SEO lever is internal linking, which the parallels module supplies.
- Lowest friction: parallels are already keyed `setID:playID::subID`, and the edition route takes the slug — each parallel becomes its own page automatically once cataloged. Standard stays `setID:playID`.
- The toggle's only real value (comparison) is recovered by the parallels module without sacrificing the per-parallel URL.

## 1. Routing + the `::` slug
- Pages live at `/<collection>/edition/<slug>`. Slug = `setID:playID` (Standard) or `setID:playID::subID` (parallel, e.g. `233:8121::20`).
- VERIFY the `::` slug round-trips: Next URL-encodes the segment (`::` → `%3A%3A`); the page + `generateMetadata` must `decodeURIComponent(rawSlug)` before calling `get_edition_detail` (same class as the existing single-colon decode fix `bf3f4f6`). Confirm `get_edition_detail` matches the full `::` external_id.
- Sitemap (`app/sitemap.ts`) enumerates editions → it will pick up `::` rows once cataloged; verify the slug is emitted encoded and resolves anon.

## 2. Per-parallel page content
- **Hero art**: that parallel's OWN `editions.thumbnail_url` / `video_url` (the Stage-B catalog must write per-parallel art — see the CC prompt). Distinct per parallel.
- **Title / H1**: `"<player> — <set>"` plus a parallel chip when `subedition_id` is set: the `subedition_name` (e.g. "Jukebox", "Hexwave") + `· /<circulation_count>`. Standard shows no chip (or "Standard").
- **Stats**: that parallel's own FMV, circulation, serial range, market/asks — no blending.
- **JSON-LD** (Product): `offers.price` = that parallel's FMV; `name` includes the parallel.
- **OG**: that parallel's own `/api/og/edition/<slug>` (its art).
- **Canonical**: SELF-canonical to its own `::` URL. Do NOT canonicalize parallels to the Standard — they're distinct editions; canonicalizing would de-index them.

## 3. The "Parallels" module (the tie-together) — on every parallel page
- A strip of sibling cards: all editions sharing the same `setID:playID` base, any `subID`.
- **Siblings query — NEW, do not reuse `get_edition_parallels`.** That existing function is a DIFFERENT notion (same play, different *set*). This module is same `setID:playID`, different *subedition*. Add a new fn e.g. `get_edition_subedition_siblings(p_external_id)` or resolve in-route via `split_part(external_id,'::',1)` to get the base, then select all editions whose base matches (`external_id = base OR external_id LIKE base||'::%'`), filtered to the collection. Returns: external_id, subedition_id, subedition_name (NULL→"Standard"), circulation_count, thumbnail_url, latest FMV.
- Each card: parallel name, its OWN thumbnail (different art), circulation, current FMV, link to its page. Current parallel highlighted.
- On the Standard/base page this is the full **parallel ladder** (e.g. Standard $23 · Hexwave $42 · Jukebox $66) — the headline intelligence feature; surface it prominently there.
- Only render the module when ≥2 siblings exist. Doubles as the internal-link graph for SEO.

## 4. SEO / near-duplicate guardrails (parallels share player/play + similar art)
- Distinct `<title>`/`<h1>` per parallel (parallel name in both).
- Distinct art + OG per parallel.
- Genuinely distinct stats (circ/FMV/serials differ) — they are not true duplicates.
- Self-canonical each; the parallels module makes the relationship explicit to crawlers.
- Breadcrumb reflects the parallel.

## 5. Data dependencies (from Stage B)
- One `editions` row per parallel: `setID:playID::subID`, with `subedition_id`, `subedition_name`, per-parallel `circulation_count`, and its OWN `thumbnail_url`/`video_url`.
- Per-parallel FMV: `fmv_snapshots` keyed to the `::` edition_id.
- These don't exist until Stage B catalogs + remaps — so this build slots in AFTER Stage B.

## 6. Edge cases
- Standard-only plays (no parallels): no module (or self-only). Module appears only with ≥2 siblings.
- Partially-cataloged play (some parallels not yet cataloged): show what exists; don't 404 the play.
- Parallel art not yet backfilled: fall back to the play's base art with a subtle note, but prefer per-parallel.
- `get_edition_detail` must accept the `::` slug (step 1).

## 7. QA (rpc-insights-qa / brand)
Entity pages are public SEO surfaces: verify anon-public reachability of the `::` URLs, JSON-LD, OG (200 image/png), sitemap inclusion, brand tokens, `security_invoker` on any new view/fn + grants, and the `::` slug round-trip end-to-end. Smoke a parallel page (e.g. a Traoré `::` once cataloged) and the base-page ladder.
