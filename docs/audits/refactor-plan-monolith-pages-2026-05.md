# Monolith refactor plan

**Scope:** Three pages above 100KB / 2000 lines that the audit flagged as refactor targets. Plan is broken down by file with concrete extraction boundaries. Each phase ships independently — no big-bang rewrite required.

## File sizes & React-state density

| File | Lines | Size | Top-level fns | useState | useEffect | Refactor priority |
|---|---:|---:|---:|---:|---:|---|
| `app/(collections)/[collection]/collection/page.tsx` | 2,900 | 164 KB | 24 | **59** | 17 | **HIGHEST** |
| `app/(collections)/[collection]/sniper/page.tsx` | 2,485 | 124 KB | 18 | 50 | 14 | HIGH |
| `app/(collections)/[collection]/analytics/page.tsx` | 2,203 | 104 KB | 27 | 36 | 15 | MEDIUM |
| `app/dashboard/page.tsx` | 1,751 | 72 KB | 22 | 33 | 8 | LOW (not in audit) |

The state density on `collection/page.tsx` is the smoking gun — **59 useState calls in one component** strongly suggests several distinct UIs collapsed into one. Splitting by useState-cluster will both reduce the file size and improve render performance (fewer re-renders per state change).

## Phase 1 — extract the easy-wins from `collection/page.tsx` (~1 hour)

The file already has clear section headers. The first ~430 lines are sub-components and helpers that can move to their own files with zero risk:

| Move | From `collection/page.tsx` lines | To new file |
|---|---:|---|
| `ThumbnailPreview` component | 29-56 | `components/collection/ThumbnailPreview.tsx` |
| `SerialBadge` component | 276-330 | `components/collection/SerialBadge.tsx` |
| `EditionRecentSales` component | 332-390 | `components/collection/EditionRecentSales.tsx` |
| `AutoSearchReader` component | 392-417 | `components/collection/AutoSearchReader.tsx` |
| `useMobile` hook | 417-430 | `lib/hooks/useMobile.ts` |
| Types section | 60-152 | `lib/types/collection-page.ts` |
| Constants section | 152-220 | `lib/constants/collection-page.ts` |
| Helpers section | 220-330 | `lib/helpers/collection-page.ts` |

**Result after Phase 1:** `collection/page.tsx` drops from 2,900 lines to ~2,470 lines (-15%). The 2,470 lines are still all the main `WalletPage` component, but the file is now manageable enough to attack with a real refactor in Phase 2.

**Risk:** Very low. These are leaf components/utilities with no shared state. Just `git mv` semantically, then update the imports in `collection/page.tsx`.

**Validation:** `npx tsc --noEmit` + smoke-test the /[collection]/collection route in dev.

## Phase 2 — break up `WalletPage` (the 2,470-line component) (~3-4 hours)

This is the real work. Strategy: identify the 5-10 useState clusters and extract each into its own sub-component with its own state.

To plan the split properly, the next session should:

1. **Read all 59 `useState` calls** and group them by what they affect (filters? table sort? expand panel? modal? wallet hydration? search?). Most likely groupings:
   - **Filter bar** — tier filter, search query, sort key, league filter (~10 useState)
   - **Wallet hydration / loading** — pending wallets, sync state, error banner (~8 useState)
   - **Table view + sort** — sorted rows, pagination, selection (~10 useState)
   - **Expand panel** — which row is expanded, edition details cache (~8 useState)
   - **Moment detail modal** — open/close, current moment, surrounding hooks (~10 useState)
   - **Telemetry / cart wiring** — saved-wallet status, cart additions (~13 useState)

2. **Extract each cluster** to a child component that owns its own state and exposes a small props interface to the parent.

3. **The parent becomes ~400 lines** orchestrating layout, prop passing, and shared cache reads — much closer to the typical Next.js page size.

**Risk:** Medium. Subtle state-dependency bugs are possible when splitting. The 17 `useEffect` calls are the main hazard — moving them across component boundaries can change render order in ways that break hydration. Mitigation: ship one cluster extraction per commit, smoke-test each, and watch the React DevTools for new re-render hotspots.

**Validation:** Every phase needs a manual run-through of the /[collection]/collection page for all 5 collections (TS, AllDay, Pinnacle, Golazos, UFC) plus expand-panel + modal flows + wallet refresh.

## Phase 3 — apply the same pattern to `sniper/page.tsx` (~2-3 hours)

Same approach, but smaller. The file has 50 useState + 18 functions in 2,485 lines. Once Phase 2's playbook is proven on `collection/page.tsx`, this becomes a mechanical exercise.

Likely natural cluster split:
- Listing source toggle + filter bar
- Live listings feed + sort
- Quick-add-to-cart modal
- Watchlist sub-panel
- Realtime price updates (the useEffect-heavy bit)

## Phase 4 — `analytics/page.tsx` (~1-2 hours)

Smallest of the three. Already has the lowest state count (36) and the highest function count (27 helpers), suggesting much of the work is already in helper functions. The page-level component is probably ~1,500 lines, mostly orchestrating dashboard tiles. Each dashboard tile is a clean extraction candidate.

## Estimated total effort: ~7-10 hours across 4 sessions

**What NOT to do:**
- Don't try to do all of `collection/page.tsx` Phase 2 in one commit. The risk of subtle state-order regressions is too high.
- Don't convert any of these to server components. They're heavily interactive with form state, hover state, drag-drop, etc. — the cost-benefit doesn't favor RSC here.
- Don't refactor `dashboard/page.tsx` until everything else is done. It's only 1,751 lines; it's not in the audit's top-3 monolith list.

## Why I'm not auto-applying this

Each phase is too large for safe autonomous work without a real review cycle. The `Edit` tool's `limit:` truncation bug we hit yesterday is a small example of what can go wrong when AI rewrites multi-thousand-line files unattended. These files render the entire `/[collection]/collection` page for paying users — a missed prop or a swapped useEffect order can break the page silently and not show up in builds.

The plan above is the artifact this audit can deliver autonomously. Execution is a co-pilot session.
