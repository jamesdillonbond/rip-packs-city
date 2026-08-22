> # ✅ RESOLVED 2026-08-22 — DECIDED AND SHIPPED. Do not re-open as an open question.
>
> Trevor delegated the call. **Option 1 + option 3, together:** the 44px floor now binds NAVIGATION and
> primary actions, and the in-view filter controls are **EXEMPT IN WRITING** in `RPC_DESIGN_SYSTEM.md` §9.
> Shipped: `.rpc-coll-tab` 35px → 44px (grew the box), and `.rpc-tap44` — an invisible `::after` that
> raises only the hit area — on the collection switcher pills (30px), the theme toggle (30×30) and the
> anon Sign-in pill (20×60). `e2e/mobile-layout.spec.ts` hit-tests the property so it cannot regress.
>
> ⚠ **The ~70 filter-row controls were deliberately NOT changed.** That is the written exception, not
> debt: RPC is a scanning tool and a mis-tapped filter is re-tapped in place. **Do not "fix" it without a
> measurement showing mis-taps cost something.**

# 86 distinct mobile controls are under the 44px tap-target floor — a DESIGN decision, not a bug list

**Filed 2026-08-22 11:36 PT (18:36Z), Claude Code interactive. MEASURED, nothing shipped from this
file.** One item from the same sweep WAS fixed and pushed (`MobileNav`, §4) because it was
provably hit-area-only; everything below changes how the product LOOKS and is therefore Trevor's call.

---

## 1. Why this exists at all

`components/WalletSearchBand.tsx` shipped rendering **350px** tall on a phone against the **~100px** its
own header comment specified, and lived for four weeks with `tsc`, eslint, both coverage gates and every
guard green — because the MARKUP was correct and only the LAYOUT was wrong. Nothing in this repo measures
layout.

So I built the missing instrument: `npm run dev` + Chromium at a phone viewport, reading real
`getBoundingClientRect()` boxes. It found the band bug in minutes. This filing is the second thing it
found.

## 2. The instrument, and exactly what it cannot see

Local dev build, **non-working Supabase credentials**, Chromium 390x844 and 320x844, 8 routes
(`/`, `/insights`, `/nba-top-shot/{overview,collection,market,sniper,play}`, `/login`).

⚠ **Boundary, and it is a big one:** data-driven regions render their error/empty branch, so every
control that only exists once rows load — moment-card actions, table row buttons, pack tiles — is
**outside this measurement**. The real population is a floor, not a total. A follow-up wants a seeded
local DB or a signed-in production run.

⚠ Also outside it: anything below the fold that mounts lazily, and any control whose size depends on
text this build has no data to render.

**Good news first, since a null result still costs something to establish:** page-level horizontal
overflow is **0px on all 13 routes tested, at both 390px and 320px**. That defect class is clean.

## 3. The finding

**86 distinct controls under 44px tall** (§9 / WCAG 2.5.5 floor). Per route:
`/` 24 · `/insights` 23 · `/overview` 42 · `/collection` 70 · `/market` 58 · `/sniper` 45 · `/play` 40 ·
`/login` **0**.

Clustered, because these are five decisions and not 86:

| cluster | count | measured height | what it is |
|---|---|---|---|
| `.rpc-filter-button` | 12 | **31px** | the collection filter row (Player / Series / Set / Rarity …) |
| `.rpc-chip` | 9 | **27px** (7), 42px (2) | tier + tool chips |
| `.rpc-coll-tab` | 7 | **35px** | the PRIMARY tab bar — Overview / Collection / Market / Sniper / Play |
| `.rpc-filter-select` | 5 | **36px** | the All Players / All Sets / All Series selects |
| `.rpc-filter-toggle` | 3 | **31px** | BADGES / HAS OFFER / LISTED toggles |

Notable singles:

* **`Sign in` pill — 20px x 60px, on 5 routes.** The shortest control measured anywhere, and it is the
  anon visitor's only visible path to an account (`components/AnonSignInPill.tsx`).
* **Theme toggle — 30px x 30px, on 12 routes.** `components/ThemeToggle.tsx` sets `width: 30, height: 30`
  explicitly, and the box is visibly bordered, so growing it is a VISIBLE change, not a hit-area one.
* **Collection switcher pills** (Top Shot / All Day / Pinnacle / Golazos / Strike) — **30px**, 5 routes.

## 4. What I already shipped, and why that one was different

`MobileNav`'s five bottom tabs measured **37x32 / 32x32 / 26x32 / 32x32 / 58x32** inside a bar that was
already **60px** tall — `padding: 0` meant each tab hugged its 18px glyph and 8px caption, leaving 28px
of bar that looked tappable and was not. Stretching each tab to the bar and padding to a 44px floor gives
**57x59 / 52x59 / 46x59 / 52x59 / 78x59**.

**The reason it needed no design decision: the render is provably identical.** Icon and label centre
coordinates, measured before and after, are byte-identical for all five tabs in both axes
(x = 39 / 114 / 184 / 255 / 340, y = 808 icon / 825 label) — `space-around` redistributes the freed space
exactly. Positive control: the item BOXES did change (37x32 -> 57x59), so the instrument does see the
edit. Nav height 60px and page overflow 0 unchanged at 390 and 320.

## 5. The decision this file is actually asking for

**Do not treat the 86 as a bug list and sweep them.** Dense 27-31px chips are a normal, deliberate choice
for a data-dense tool, and enlarging them changes information density on the smallest screens — the
opposite of what a collector scanning 200 moments wants. Three coherent options:

1. **Raise the floor for NAVIGATION only** — `.rpc-coll-tab` (35 -> 44) and the `Sign in` pill (20 -> 44).
   ~12 controls, all on the tap path a new visitor must clear. Smallest change with the largest share of
   the mis-tap cost.
2. **Raise it for everything that isn't a filter chip.** ~40 controls, a visible density change.
3. **Write the exception down.** If 27-31px chips are intentional, §9 should SAY the floor applies to
   navigation and primary actions and not to in-view filter chips — otherwise the rule reads as violated
   86 times and stops being a rule anyone checks.

⚠ **Option 3 is not the do-nothing option and should not be filed as one.** A stated floor that is
violated 86 times is worse than no floor: it is the "permanently-red instrument" shape this repo already
records — nobody reads it, so a real violation on a new surface lands unnoticed.

## 6. Re-derivation notes for whoever picks this up

* Every number here is a **dated sample from a local build**. Re-run before quoting: start `npm run dev`
  with placeholder Supabase env, then drive Chromium at `/opt/pw-browsers/chromium` (Playwright's own
  browser build is absent in the sandbox; `--no-sandbox`, and pass `executablePath`).
* ⚠ The agent proxy answers **403 to CONNECT for www.rippackscity.com** from a Claude Code web sandbox
  (org network policy), so production cannot be measured from there. That is a policy denial, not a
  transient failure — do not retry it, use a local build or a desktop session.
* The counts move with route and load timing because controls mount progressively. Compare the CLUSTER
  and the measured height, not the per-route total.
