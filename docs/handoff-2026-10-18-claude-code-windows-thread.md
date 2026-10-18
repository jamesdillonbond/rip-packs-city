# Handoff — Claude Code, Windows box thread (2026-10-17 ~8:10 PM → 2026-10-18 ~7:45 AM PT)

Everything this thread could ship is shipped, deployed and verified. What is left needs Trevor (a decision or an account action). Session entry: `docs/sessions/2026-10.md` (top). Ledger: the 10-17 / 10-18 entries that cite these commits.

## Needs Trevor

1. **#194 — light-mode tier and semantic colours as text (a decision).** In light mode, tier chips and green/amber/red figures fail contrast badly (`/insights/squeeze`: 203 axe nodes; legendary gold #FFD700 at 1.3:1). The tokens have no light values on purpose — the light block of `app/rpc-tokens.css` says tier colours stay identical in both themes. The precedent-consistent fix is the one red text took on 10-12: separate **text** tokens (`--tier-<x>-text`, `--rpc-<semantic>-text`) equal to the fill in dark and darkened in light, with fills unchanged. Computed light values are in known-issues #194. **The question:** are text-only light shades acceptable under the "brand reads identically" rule? On a yes, a session can ship it (≈ 13 direct `color: var(--tier-…)` sites plus the lib helpers that return `var(--tier-…)` for text).
2. **M5 (go-live bar, Collection tab ≤ 5 s signed in, warm).** Not measured: it needs a signed-in Playwright storage state for an account, which means a magic-link login. Anonymous warm reloads were 2.7–4.6 s before `fd94b12ea` and first rows are now 2.1–2.6 s cold, so it very likely passes; it is unmeasured, not met.
3. **#58 `OPENSEA_API_KEY`** and the optional **`drop_scratch.sql`** — unchanged, see `docs/handoff-2026-10-17-operator-gated-remaining.md`.

## Shipped this thread (revert = `git revert <sha>`, each self-contained)

| sha | what | verified |
|---|---|---|
| `e4987c88a` | local session-start sync + `origin-drift.sh` notify hook | planted 3-behind clone: ff, notice, silence, off-main refusal |
| `a816619a0` · `0af9f36bd` | 547 + 6 text sites to `--rpc-red-text` / `--rpc-text-muted` + guard | prod axe 299 → 18 nodes |
| `fd94b12ea` | Collection-tab badges by edition key; `/api/badges?editions=` | prod first row 4.9–6.0 s → 2.1–2.6 s (15K wallets); CI green |
| `9d31f6622` | ready-queue reads focus.md verdicts | 10-18 handoff: 4 items → 1 open (#58, correctly) |
| `b6fcdd99f` | `lib/accent-text.ts`; 85 low-alpha white texts → 0.5 | prod axe dark ≤ 5 nodes/route; CI green |
| `af14927c3` | switcher accent + 7 opacity-dimmed texts | prod: pill rgb(255,77,64); overview dark 1 node |
| (this commit, message "red ternaries, red constants and trophy links") | 28 red ternary branches, RED_TEXT constants, P/L tint, trophy links, guard extension | `7e184277d` — prod: sort chip rgb(255,77,64); CI green |
| (message "sets muted and email subtle text") | sets palette muted 0.45 → 0.5; 4 email TEXT_SUBTLE → 0.5 | final axe: dark = accepted buttons only on 7 routes |

Docs-only commits (ledger, #192 write-backs, #194, roadmap M4/M8, reference lessons) revert by message.

## Watch

- **#192 backlog:** 14,831 All Day sales ≥ 2025-10-22 without a buyer at 10-17 11:20 PM PT, ~3,840/day → expect ~0 around 10-22. Read: `select count(*) from sales s join collections c on c.id=s.collection_id where c.slug='nfl_all_day' and sold_at >= '2025-10-22' and buyer_address is null`.
- **Parallel seeder:** `never_queued` falls in steps after each 1:33 PM PT `backfill-topshot-subeditions` run, not per tick (focus.md watch annotated). Judge on the 10-18 / 10-19 post-1:33 PM reads.
- **Light mode, untokenised dark surfaces** (pack page, sets page palette) make red text 2.45–3.16:1 there — #194; fix = tokenise the surfaces.
- **The nightly `a11y-audit` job** should now read ≤ the accepted white-on-red button nodes in dark. A new class appearing there is a regression; the light-mode tier/semantic class is #194 and expected until item 1 is decided.
