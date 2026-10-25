# Text colour — how RPC keeps text readable in both themes

Built 2026-10-17/18 (known-issues #194, closed). Read this before painting TEXT with any colour that is not already a `--rpc-text-*` token. The one rule underneath everything: **fills keep their colour in both themes; only TEXT gets a theme-aware shade.** That is how a tier, a brand red or a collection accent still "reads identically" (the light block's Phase-0 rule in `app/rpc-tokens.css`) while its text clears WCAG AA (4.5:1).

## Which tool for which value

| You are painting text with… | Use | Where |
|---|---|---|
| the brand red | `var(--rpc-red-text)` (`#FF4D40` dark / `#B52A21` light) | token |
| a tier or semantic colour (`--tier-rare`, `--rpc-success` …) | its twin `var(--tier-rare-text)` / `var(--rpc-success-text)` | tokens (dark = the fill, except rare/challenger/info a shade lighter; light = a text-safe shade) |
| a collection accent, a hex, an `rgb()` literal, or a variable holding one | `accentText(value)` | `lib/accent-text.ts` — brand red → `--rpc-red-text`, a fill token → its twin, anything else → `color-mix` toward `--rpc-accent-text-mix` by `--rpc-accent-text-amt` (12 % white dark / 55 % black light) |
| a chip STYLE object whose text sits on its OWN translucent tint | `textSafeChip(style)` | `lib/accent-text.ts` — wraps only `color`, only when the background is a translucent tint; an opaque fill is left alone |
| a label ON an accent FILL (a button) | `labelOn(fill)` | `lib/accent-text.ts` — white on the brand red, `#0B0B0D` on every other accent |
| the FILL under that label (a button, an active tab) | `accentFill(fill)`, or `var(--rpc-red-fill)` / `var(--rpc-red-fill-hover)` directly | `lib/accent-text.ts` + token — the brand red becomes `#D93529` (white 4.68:1; `#E03A2F` is 4.36:1), every other accent passes through. Decided 2026-10-24. |
| a DATA-defined fill (a team's primary colour) | `readableFill(fill)` then `readableOn(fill, preferred)` | `lib/accent-text.ts` — a mid-tone colour no label reads on (Rayo Vallecano) is darkened just enough for white |
| a Tailwind palette text utility (`text-emerald-400` …) | nothing — it is overridden in light theme | generated block at the end of `app/rpc-tokens.css` ("LIGHT THEME — Tailwind palette TEXT utilities") |
| muted / secondary copy | `var(--rpc-text-muted)` / `var(--rpc-text-secondary)` | tokens. ⛔ never `--rpc-text-ghost` (1.78:1 — decorative only) and never white-alpha below 0.5 |

## Where NOT to apply them (each one broke something on 10-18)

- **Never at a value's DEFINITION** (`tierChip().color`, a lib map, a data row `{ label, color }`): the same value usually also feeds a border, a gradient, a bar or a dot. A `color-mix()` string with a hex-alpha suffix (`${c}33`) is invalid CSS — the pack hero's border vanished on prod for ~20 min. Wrap at the TEXT consumer.
- **Never on an SVG presentation attribute** (`<polyline stroke>`, a `<Sparkline color>` prop): attributes cannot resolve `var()` / `color-mix()`.
- **Never in OG image routes, `lib/og/**`, email HTML (`lib/emails/**`) or `app/global-error.tsx`**: Satori and mail clients resolve neither, and global-error may render without the token stylesheet.
- **Never on text that sits on a fixed fill that does not change with the theme** — the trophy slab's silver plate (`#C8C8C5`) uses a theme-independent `color-mix(…, #000 65%)`; Recharts tooltips (dark `contentStyle`) keep their light text.
- **Text on a red fill stays `#fff` — on `--rpc-red-fill`, never on `--rpc-red`** (2026-10-24: the pre-launch white-on-`#E03A2F` exception is retired; `--rpc-red` stays for accents, borders, bars, dots and the wordmark). Hover goes DARKER (`--rpc-red-fill-hover`), not to the lighter `--rpc-red-hover` (white 3.29:1).

## Guards (all tree walks; a planted defect proves each)

- `__tests__/text-color-uses-text-safe-tokens.test.ts` — bans `color: var(--rpc-red | --por-red | --rpc-text-ghost)` (direct and as a same-line ternary branch) and `color: rgba(255,255,255,<0.5)`; counted suppressions only (a decorative watermark, a disabled send arrow).
- `__tests__/red-fill-contrast.test.ts` — both fill tokens clear 4.5:1 under white, `labelOn` on `accentFill` clears it for every registry accent, `readableFill` fixes Rayo, and a tree walk bans `background: var(--rpc-red…)` + white text on one line in `app/` and `components/` (planted defects in three spellings).
- `__tests__/accent-text-contrast.test.ts` — every registry accent, every twin and `labelOn` clear 4.5:1 in both themes on every canvas, a raised card and the colour's own 15 % tint — read from the CSS and `COLLECTIONS`, so a new accent or a weaker token fails.
- `__tests__/tailwind-palette-text-has-a-light-theme-rule.test.ts` — every `text-<hue>-300/400/500` (and variants) and dark badge fill `bg-<hue>-800/900/950` the app uses has a light-theme rule.
- `e2e/a11y.spec.ts` (E2E DOM Smoke → `a11y-audit`) — axe on production routes in both themes; the accepted white-on-red signature is the only exclusion.

## Measuring

Static guards cannot see a parent's fill or a computed colour. The instrument is axe on production in BOTH themes (`?theme=light`), plus a computed-style probe on any FILL you touched (a contrast count cannot see a border that stopped rendering). The 10-18 end state: 68 of 70 route × theme checks clean (25 anonymous + 10 signed-in routes); the 2 are the login `.rpc-live-pill` read mid-flicker.

## 2026-10-25 — the fallback spelling, and what the guard cannot see

- ⚠ **`var(--rpc-red, #E03A2F)` is the same fill red as `var(--rpc-red)`, and the guard missed it.** `text-color-uses-text-safe-tokens.test.ts`'s regex required the `)` straight after the token name, so 14 text sites written with a fallback (share card, its empty state, dashboard alerts + notifications) passed it while axe read 4.45:1 on the live share card. Both `BANNED` regexes now accept an optional `, fallback`; planted against the old tree, it reds. **A guard over a CSS value must match every spelling of the value** — fallback, whitespace, ternary branch.
- `opacity` on muted text is a contrast change the guard cannot see: the share card's "market closed" date at `opacity: 0.8` read 4.34:1 dark / 3.89:1 light. Remove the opacity; pick a text token.
- The 7 px `@RIPPACKSCITY` handle in the `/analytics` and `/my-teams` layouts was `text-red-500/60` (2.46:1) — a Tailwind class, also outside the guard's `color:` scope. Now `text-[color:var(--rpc-red-text)]`.
- Instrument: `e2e/a11y.spec.ts` (6 h, both themes, `color-contrast` GATED) — 32 routes since 10-25, including the share card, edition, player, market-cap, pack-reality and `/analytics`.
