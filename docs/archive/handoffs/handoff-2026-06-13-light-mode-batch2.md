# Handoff 2026-06-13 — Light-mode batch 2 (dashboard + auth-gated monoliths)

Light mode is LIVE for everyone (dark default). Public entity pages + share/profile/TopNav/MomentDetailModal are already cleaned and PROTECTED by `scripts/check-brand-tokens.mjs`. This batch finishes the **deferred debt**: the dashboard + the big auth-gated monolith pages, which still hardcode dark chrome and render unreadable in light. Source: Cowork read-only audit (Explore), 2026-06-13.

## The 3 literal vocabularies (a file can be clean in one, broken in another — check all three)
1. **Inline-style / CSS hex+rgba**: `background:"#080808"`, `color:"#fff"`, `rgba(255,255,255,0.55)`, `#0d0d0d`, `#09090b`.
2. **Tailwind color utilities**: `text-white`, `text-white/55`, `bg-white/5`, `bg-black`, `bg-zinc-900`, `text-black`. (CSS-value greps can't see these — grep class strings too.)
3. **Brand literals**: `'#E03A2F'`, `'Barlow Condensed'`, `'Share Tech Mono'` → must be `var(--rpc-red)` / `var(--font-display)` / `var(--font-mono)`.

## Token map (from app/rpc-tokens.css — these flip under [data-theme="light"])
- page bg → `var(--rpc-bg)` · primary text → `var(--rpc-text-primary)` · secondary/muted text → `var(--rpc-text-secondary)` · card surface → `var(--rpc-surface)` · raised surface → `var(--rpc-surface-raised)` · borders → `var(--rpc-border)`.
- Inline styles: swap the literal for `var(--rpc-*)`. Tailwind utilities: use arbitrary-value token classes e.g. `text-[color:var(--rpc-text-primary)]`, `bg-[var(--rpc-surface)]`, `border-[color:var(--rpc-border)]` — or a scoped `[data-theme="light"]` override in the file's styled block.

## Items (priority order)

**0. VERIFY FIRST — do NOT blind-edit `app/layout.tsx`.** The audit flagged `<body className="...bg-black text-zinc-100">` as a "blocking root issue," but light mode already works on public pages, so the root is most likely already handled (token-driven body or a `[data-theme="light"]` override). Load `/insights` or an entity page in light mode and confirm the page bg actually flips. **Only** touch the body classes if the root is genuinely dark-stuck — changing a working root risks breaking the whole site. If a fix IS needed, prefer a `globals.css` `[data-theme="light"] body { background:var(--rpc-bg); color:var(--rpc-text-primary); }` override rather than ripping the Tailwind classes.

**1. `app/dashboard/page.tsx` (~60 literals) — biggest item, Trevor's main screen (auth-gated).** The cascade root is the wrapper at ~L670/L680 `background:"#080808"; color:"#fff"` — fix that first (it cascades to all children). Then the embedded CSS `.rpc-section-title { color: rgba(255,255,255,0.7) }` (~L685), spinner border `rgba(255,255,255,0.2)/#fff` (~L689), and the run of inline `color:"rgba(255,255,255,0.85|0.55|0.5)"` (L710/724/741/758/814/930), `background:"#0d0d0d"` (L824), `background:"#080808"` cards + `border:"1px solid #27272a"` (L861/871/877). Swap each to the token map above. `color="#fff"` string at L793 → token.

**2. `app/(collections)/[collection]/collection/page.tsx` (~25 literals).** Tailwind `text-white` run (L1806-1807, 2037, 2043, 2074, 2305, 2371, 2407, 2448-2454, 2543) → `text-[color:var(--rpc-text-primary)]`. The `bg-white px-1 py-0.5 text-black` pill (L2378) → `bg-[var(--rpc-surface-raised)] text-[color:var(--rpc-text-primary)]`. Inline `background:"#09090b"; color:"#fff"` input (L2560) → tokens. Radio label `"#fff"/"#71717a"` (L2566) → `var(--rpc-text-primary)`/`var(--rpc-text-secondary)`. (Accent-bg badges like L2261/2621 `background:accent,color:"#fff"` are fine — white on a colored fill is intentional.)

**3. `app/(collections)/[collection]/analytics/page.tsx` (~20 literals).** Tailwind `text-white` run (L373, 474, 586, 644, 698, 754, 860, 925, 1016, 1232-1240, 1655, 1703, 1943-1983, 2054) → token class. `bg-black text-white` input (L1893) → `bg-[var(--rpc-surface)]`. `bg-zinc-900 text-white` button (L1989) → `bg-[var(--rpc-surface-raised)]`.

**4. `app/(collections)/[collection]/sniper/page.tsx` (~5 literals).** Thumbnail hover-preview `background:"#000"; color:"#fff"` (L35-36) → tokens (high-visibility: turns white-on-white in light on hover). Deal-card `color:"rgba(255,255,255,0.9)"` (L1486, 1723) → `var(--rpc-text-secondary)`. The `var(--rpc-surface, rgba(255,255,255,0.03))` fallback (L2101) is acceptable (token-first) but tighten if trivial.

**5. Pack dist client components.** The page `app/(collections)/[collection]/pack/dist/[distId]/page.tsx` itself is a server component and reads clean — the ~64 literals memory flagged are in the **imported client components**. Grep `components/packs/*` and `components/entity/*` for the 3 vocabularies and clean the ones the dist page renders.

## Don't touch
- `TeamHero` / `TeamLogo` — whites sit on team-color gradients via a `dark` prop, not the app theme (deliberate exclusion; already documented).
- `FmvHistoryChart` recharts `stroke` — documented brand-exception (SVG presentation attrs can't take a CSS var).
- Anything already in the `check-brand-tokens.mjs` PROTECTED / NEUTRAL_PROTECTED lists (overview, sniper-brand, analytics-brand, collection-brand, CrossCollectionPortfolio, TopNav, CollectionSwitcher, MomentDetailModal, share, profile).

## After cleaning each file
Add it to the `scripts/check-brand-tokens.mjs` guard list (the NEUTRAL list for the 3 vocabularies on cleaned surfaces) — that's the regression fence, extend it per file. Then `node scripts/check-brand-tokens.mjs` must pass.

## QA
Toggle light mode (header/footer toggle or `?theme=light`), load each cleaned surface, confirm readable (no white-on-white, no near-black-on-black). Screenshot dashboard + collection + analytics + sniper in light. Note: the audit labeled collection/sniper "PUBLIC" but per `proxy.ts` `isPublicPath` only the **singular** entity segments + `/overview` are anon — collection/sniper/analytics tabs are auth-gated. Either way they need fixing for logged-in users; dashboard + collection are the priority.

## Revert
`git revert <commit>` per file/batch. Pure presentational token swaps — no logic touched.
