# Filter controls — the shared dropdowns, search boxes and their traps

Written 2026-10-21 (PT) from four rounds of work on Trevor's ask: *"the filters need to
have a typing spot when there's a ton of options, like on the teams filter"* → *"keep
digging and improving these filters, using best practices"*. Ledger entries for each
round are dated 10-21; this page is the durable summary.

## What to use

All under `components/filters/`; matching lives in `lib/filter-match.ts`.

| need | component | notes |
|---|---|---|
| single choice, any length | **`FilterSelect`** | native `<select>` up to `SEARCHABLE_SELECT_MIN` (8) options — the OS picker is the best control for a short list — and `SearchableSelect` above it. `fill` for a grid cell. |
| single choice, always searchable | `SearchableSelect` | WAI-ARIA combobox + listbox. Prefer `FilterSelect`. Omit `allValue`/`allLabel` for a pick-one list with no "All" row; `groupOf` gives `<optgroup>`-style `role="group"` sections (options in group order; a query also matches the heading and keeps group order). |
| multi choice (chip) | **`MultiSelect`** | market Set / Series / Team / Badges. Search box above 8 options; `aria-multiselectable`; picks pinned to the top **at open time** (re-sorting on each toggle moves rows under the pointer). |
| free text with suggestions | **`Autocomplete`** | market Player box. The typed text IS the filter; a suggestion replaces it with the catalog spelling. |
| show what is active | `ActiveFilterPills` | one removable pill per multi-select value ("Team: Portland Fire ×"). |
| free-text search over rows | **`textIncludes(haystack, q)`** | accent- and case-blind; identical to `toLowerCase().includes` for ASCII. |
| rank a long option list | `filterOptions(options, q, labelOf?)` | every word must match; label-prefix, then word-prefix, then anywhere. |

Where they are used (2026-10-21): Sniper Team/Franchise + Studio (`SniperFilterBar`),
market multi-selects + Player box + pills (`MarketClient`), wallet collection Player /
Set / Series (`CollectionFilterBar`), editions grid Team / Set / Series / Rarity /
Parallel / Badge (`EditionsGridPaginated`), the Panini Sets page Product picker
(`PaniniSetProgress`, 106 products across 6 sports on 2026-10-22 — grouped by sport;
native `<optgroup>`s at 8 or fewer). The profile favourite-team picker was left
native on purpose — a once-per-account setting, not a filter.

Keys (all three popups): ↓/↑ move · Enter picks (MultiSelect: toggles, stays open) ·
Escape closes and returns focus to the trigger · Tab closes · ↓ on a closed trigger
opens. Space toggles in MultiSelect only when the search box is empty (a query may hold
spaces). The search box focuses on open with a **mouse** (`pointer: fine`) but not on
touch, where the keyboard would cover half the list.

## ⛔ The traps — each was live or caught in a real browser

1. **Never put a popup trigger inside a `<label>`.** A browser forwards a click on any
   non-interactive descendant of a label (an option row) to the label's first control —
   the trigger — so a pick RE-OPENED the Sniper Team list (live 10-21 from ~8:53 to ~11:28 AM PT;
   confirmed in Chromium with a 3-line page). **jsdom does not implement this
   forwarding, so no click test can see it**: it is pinned structurally in
   `sniper-team-franchise-filter.test.tsx` (`trigger.closest("label")` is null,
   mutation-proved). Wrap visual labels in a `<div>`; the controls carry their own
   accessible names.
2. **On a phone, `window.innerWidth` is the LAYOUT viewport and grows to fit overflow.**
   With a right-edge panel open it read 534 px on a 390 px screen, so the keep-on-screen
   nudge came out at −8 px and the page scrolled sideways. Measure with
   `document.documentElement.clientWidth`.
3. **A `transform` does not remove overflow.** Chrome still counted a `translateX`-ed
   panel's untransformed box as page width (scrollWidth stayed 534). Apply the nudge as
   a layout offset (`left`), as `useKeepInViewport` does.
4. **A `<span>` per plain text run breaks the accessible name** — the name walk trims at
   element edges, so a highlighted "Luka **Dončić**" was named "LukaDončić". Plain runs
   are bare text nodes in `HighlightedLabel`.
5. **`x.toLowerCase().includes(q)` is accent-SENSITIVE.** "doncic" found nothing for
   Luka Dončić at fifteen search and filter sites. Banned at zero by
   `__tests__/a-search-box-matches-accented-names.test.ts` (tree walk over app/,
   components/, lib/; silent about the two-step `hay = x.toLowerCase(); hay.includes(q)`
   form — use `textIncludes`).
6. **The market's player match is accent-sensitive in the database** (`ilike '%q%'` in
   every arm: the Top Shot / All Day / Golazos RPCs' `p_player` and the PostgREST table
   arms). Resolved 10-21 (#207) **in the route, without a DB change**, by
   `lib/market/player-match.ts` — and only when the ordinary search came back EMPTY, so a
   search that matched costs nothing extra and is never altered:
   - **catalog arms** (Top Shot, All Day, Golazos): the typed text is resolved against
     `get_market_filter_options` (≈115 ms, memoized per instance for an hour). Exactly one
     name matching only accent-blind → the arms re-run with it and the response carries
     `playerResolved: { from, to }`; the page shows *"No exact match for “luka doncic” —
     showing Luka Dončić"* with **Use this spelling**. Never a silent swap (CLAUDE.md's
     substitution rule). Two or more candidates → no guess.
   - **table arms** (Pinnacle, Candy, Panini — they page in code): `withAccentFallback`
     retries with an accent-tolerant ilike (vowels + c n s z y → `_`, typed `%`/`_`
     escaped) and keeps only rows `textIncludes` confirms. ⚠ That widened pattern
     cannot be formed for a short name whose every letter can carry an accent ("acuna",
     "agustin" — fewer than 2 literal characters): live 10-23, Candy "acuna" answered 0
     listings while "Acuña" answered 5. Since 10-23 the route's retry also covers the
     table arms through `resolve_player_name` (single label, reported as
     `playerResolved`), after the in-arm fallback has had its turn. Rarer accent carriers (ł ř ğ)
     are not widened.
   - **the Sniper** (`/api/sniper-feed`, closed 2026-10-22): the same accent-sensitive
     match in its Top Shot pool and the All Day / Golazos RPCs ("doncic" → 0 deals live,
     "Dončić" → 96). Same rule through the shared `lib/market/catalog-player.ts`; the page
     shows the same `PlayerResolvedNote`.
   - **the page**, for what the route cannot decide (ambiguity): the Player
     `Autocomplete` suggests the catalog spelling, and an empty search offers *"Did you
     mean …"* for names differing only by accents (`accentOnlyMatches`).
   - **Other callers (closed the same night, #207):** `/api/market-analytics` (player
     search), the public special-serial owners board, and the concierge's team-deals and
     wallet-breakdown tools now take the spelling from `resolve_player_name` — the
     platform's accent-, alias- and namesake-aware resolver — via
     `singleRetryLabel` (`lib/concierge/player-identity.ts`): only when it names ONE
     person with ONE label. The two routes retry only an EMPTY answer and report
     `playerResolved` / `meta.player_resolved`; their pages say "showing …". The other
     concierge player tools were already resolved through the same resolver.
   - **Verified in real Chromium at 390 px on the real components** (MarketClient,
     SniperFilterBar, with the app's compiled Tailwind): 73-team list, type-to-filter,
     multi-pick stays open, outside tap closes, pill, Autocomplete, the "showing" note +
     Use this spelling, and the Sniper pick that no longer re-opens; page width 390
     throughout. ⚠ Without the app's CSS the harness reported a false 400 px overflow —
     compile `app/globals.css` (Tailwind v4 PostCSS) into any such harness.
   - **Platform-wide (2026-10-22, Trevor: "apply all of this logic throughout the
     platform").** One rule, three tools, all in `lib/search/`:
     - **a person's name** → `retryEmptyPlayerSearch` (`player-search-retry.ts`): an EMPTY,
       non-failed answer is retried once with `resolve_player_name`'s single label
       (`singleRetryLabel`; a cross-collection read retries only when every collection
       agrees), reported as `player_resolved` / `playerResolved` and shown with
       `components/filters/PlayerResolvedNote`. On: the public Deals, First Mint,
       Squeeze, Offer Spread, Candy MLB and Panini Squeeze boards (API + page note),
       `/api/edition-search`, the concierge's listing search, special-serial listings,
       edition-floor search and `search-deals`. A retry that fails or throws leaves the
       original empty answer — it may only ever improve one.
     - **text that is not a person** (pack titles, Pinnacle character names) →
       `accentInsensitiveRegex` / `retryEmptyWithAccentRegex` (`accent-regex.ts`): each
       letter becomes the class of every character `foldForMatch` folds to it, joiners
       optional, run with PostgREST `imatch` (`~*`). EXACT — no over-match — so a page's
       count, sort and paging stay right ("clasico" → 23 "ElClásico" packs; "walle" →
       WALL•E). On: `/api/packs` search and the four Pinnacle concierge searches.
     - **names a user types that are later compared for EQUALITY** →
       `canonicalPlayerNames`: a deal alert's `player_names` match `lower(x) = lower(…)`
       when the alert runs, so a typed "luka doncic" would never fire. Saved as the
       resolver's spelling, and the page says which. The Alerts player typeahead leads
       with the resolver's names and matches any word's start ("jok" → Nikola Jokić).
     - **site search** (`rpc_search_catalog`) already folded accents (`unaccent`) but
       KEPT joiners, so "walle" / "wall-e" missed WALL•E (1 of 9,079 players carries • or
       ·). Since `20261023135624` the player arm also matches the whole query against a
       joined name with joiners read as "-" or dropped — gated on the name carrying one,
       so every other result is byte-identical (10 control queries, md5-compared).
     - **site search, team & set arms** match the RAW query (trigram indexes), so none of
       the 12 accented team / set labels was findable without its accent ("atletico",
       "cadiz", "malaga", "clasico", "idolos"…). Not fixed in the hot function: `/api/search`
       reads `public.search_accented_labels()` (12 rows, ~30 ms, memoized 1 h —
       `lib/search/accented-labels.ts`) and, for a query that matches a label ONLY
       accent-blind, re-runs with the exact label and LEADS with its team / set row. ⚠ The
       label test is accented LETTERS (`[À-ÖØ-öø-ɏ’‘]`), not "non-ASCII": Panini set names
       carry a "·" separator and the first version returned 2,829 rows.
     - ⚠ **Rebuild the query for the retry.** A supabase-js builder mutates in place: a
       second `.ilike` on the same builder STACKS on the first and the retry can never
       match. Every retry above takes a `run(…)` that builds afresh.
     - **Guards:** `__tests__/a-player-search-survives-a-missing-accent.test.ts` (every
       `player_name` / `character_name` ilike and non-null `p_player` sits within 40 lines
       of a retry/resolver, or is SANCTIONED with a reason — per occurrence), and the
       widened `a-search-box-matches-accented-names.test.ts` (`.toLowerCase().includes(`
       with ANY non-literal argument). Both proved with planted defects.
6b. **NFD does not decompose every accented letter.** ø ł đ ħ ı ß æ œ þ survive
   `normalize("NFD")` + stripping marks, so "sorloth" missed Alexander Sørloth; the
   catalog also stores the curly ’ ("Aiden O’Neill") and joiners (WALL•E).
   `foldForMatch` maps them explicitly (as Postgres `unaccent` does). Measured
   2026-10-21 over every edition / Candy / Panini / Pinnacle name: ø 2, ’ 5, ģ 1,
   • 1 — and no ł ř ğ at all, so the table-arm pattern widens g and the apostrophe
   but leaves l / r literal.
7. **No per-option counts on the market.** Its options merge the catalog with facets of a
   window capped at 1,000 fetched rows, so a count would read as a census it is not
   (CLAUDE.md: a window is not a census).

## Verifying — what a sandbox can and cannot see

- **jsdom (vitest)** proves keys, ARIA wiring and state — `component-filter-selects.test.tsx`,
  `lib-filter-match.test.ts`, the market / sniper suites. It is blind to traps 1–3.
- **Real Chromium on the components, without the app:** build a 20-line React page that
  imports the components with Vite (`build({ root, resolve: { alias: { "@": <repo>,
  react: <repo>/node_modules/react, "react-dom": <repo>/node_modules/react-dom } } })`),
  serve `dist/` with `python3 -m http.server`, and drive it with Playwright
  (`executablePath: "/opt/pw-browsers/chromium"`, `devices["iPhone 13"]` at 390 px for
  touch). Assert `document.documentElement.scrollWidth === 390` with a panel open. Run
  the scripts from inside the repo (a copy) so `playwright` resolves.
- **The served bundle:** `www.rippackscity.com` is blocked to curl/Chromium here, but
  `pg_net` reaches it (tooling-gotchas.md, 2026-09-13): `net.http_get` the page, pull the
  `/_next/static/immutable/chunks/*.js` paths out of `content` with `regexp_matches`,
  `net.http_get` each, then `content LIKE '%Type to filter %'`. ⚠ `net.http_get` times out at 5 s by default — pass `timeout_milliseconds := 60000` for heavier API calls (`/api/market-analytics?detail=full` failed without it). Include a NEGATIVE
  control (a string from an unshipped change) so a hit means something.
- **Re-verified 2026-10-23 ~9:30 AM PT (iPhone 13, 390 px, prod):** the Sniper's "Loading teams…"
  placeholder is in the DOM during the first feed read (529 ms) and gives way to the searchable Team
  control (734 ms); the Panini Sets Product picker opens on 106 products in 6 sport groups, "basketball"
  narrows to 2 groups / 50, a pick closes the list and loads `?product=…`; width 390, no page errors.
  ⚠ Do not slow `/api/sniper-feed` with `page.route` to "see" the placeholder — that run showed neither
  state; sample the DOM every 200 ms instead.
- **The live site in a real phone browser:** a Vercel Sandbox reaches www.rippackscity.com
  (`create_sandboxes_v4`, `networkPolicy: allow-all`; Playwright needs
  `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64` and `sudo`; run long steps in the
  background and poll in < 55 s calls). Done 2026-10-22 ~1:10 PM PT on prod `c882416cc`,
  iPhone 13 at 390 px — all passed, no page errors, width 390 throughout: Top Shot market
  Team (73 options, "port" → Portland Fire / Portland Trail Blazers, pick stays open,
  outside tap closes, pill "Remove Team filter: Portland Trail Blazers", `?team=` in the
  URL), Player box "jokic" → Nikola Jokić; Golazos `?player=alexis sanchez` → "No exact
  match … showing Alexis Sánchez" + Use this spelling, "sorloth" → Alexander Sørloth;
  Sniper Team searchable, not inside a `<label>`, closes after a pick. ⚠ Two script traps
  that read as product bugs: a "tap outside" near the bottom of a phone viewport hits the
  **bottom nav** and navigates away (tap the page heading instead); the Sniper's filters sit
  behind **⚙ FILTERS** on a phone, and its Team control gets real options only once deals
  load — since 10-22 a disabled, `aria-busy` "Loading teams…" (Franchises on Pinnacle; none
  on UFC) holds its place during the first read (`teamPending`); a failed read still hides it.
