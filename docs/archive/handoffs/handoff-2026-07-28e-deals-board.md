# Handoff — 2026-07-28 (round 5) · /insights/deals — an undisclosed collection, and the confidence ruling

## Context

Trevor delegated the `/insights/deals` confidence-UI call. I made it (item 15). But inspecting the page to decide surfaced something bigger and unrelated (item 14) — **do that one first, it is a live correctness bug on a public unauthenticated SEO surface.**

Both are code. Nothing shipped from Cowork.

---

## ⚠ 14. NFL All Day is 47% of the deals board and the page denies it exists

Measured live, anonymous, on the rendered board — 147 rows:

| collection badge | rows | share |
|---|---|---|
| **NFL ALL DAY** | **69** | **47%** |
| NBA TOP SHOT | 50 | 34% |
| DISNEY PINNACLE | 28 | 19% |

All Day is the **single largest collection on the board**. Every surface describing the board says it isn't there:

| location | current text / behaviour |
|---|---|
| `app/insights/deals/layout.tsx:13` | title `"Below FMV — Top Shot + Pinnacle Deals vs Fair Value"` |
| `layout.tsx:15` | meta description `"NBA Top Shot and Disney Pinnacle editions…"` |
| `layout.tsx:18-23` | keywords — Pinnacle/Top Shot only |
| `layout.tsx:30` | OG title, same |
| `DealsBoardClient.tsx:~58-62` | `COLLECTIONS` chips = `ALL / nba_top_shot / disney_pinnacle` — **no All Day chip** |
| `DealsBoardClient.tsx:243-244` | lede `"Top Shot + Disney Pinnacle editions listed…"` |
| `DealsBoardClient.tsx:220` | share text, same claim |
| `DealsBoardClient.tsx:494` | methodology prose, same claim |
| `app/api/og/insights/deals/route.tsx:39-40, 91` | OG image copy, same claim |
| **`app/api/public/insights/deals/route.ts:54`** | **`VALID_COLLECTIONS = new Set(["nba_top_shot","disney_pinnacle"])`** |

That last one is the sharpest. Lines 75-76 return **HTTP 400** for `collection=nfl_all_day`, with an error naming the only "valid" values — so the documented public API contract actively denies a collection that is 47% of its own payload. A consumer cannot filter to All Day, and is told it doesn't exist.

**Diagnosis, not guesswork:** the board *was* extended to All Day on the data side and the fee model followed — `DealsBoardClient.tsx:401` already reads *"Top Shot and All Day charge 5%; Disney Pinnacle charges 7.5%…"*. So the backing `cross_collection_deals_board` view and the net-of-fees math both know about All Day. Only the page's description of itself and its filters were never updated.

**Fix:** add `{ key: "nfl_all_day", label: "All Day" }` to `COLLECTIONS`, add `nfl_all_day` to `VALID_COLLECTIONS`, and update the six copy locations to name all three collections. Check the OG route renders sensibly with the longer string.

**Verify:** anonymous fetch of `/api/public/insights/deals?collection=nfl_all_day` returns 200 with rows (not 400); the All Day chip filters the board; title/lede/OG name three collections. Confirm the page is still public — assert on `res.url`, not `res.status` (see the round-3 guardrail).

**Revert:** revert the commit. Data is untouched — this is presentation and one allowlist.

---

## 15. The confidence ruling: keep the control, drop the enum vocabulary

Trevor delegated this. **Ruling: the filter stays and its behaviour is unchanged; the internal tier names come off the public surface.**

**Why not delete the pills.** On a deals board the entire proposition is *"this is listed below fair value."* A control that says "only show me deals where the fair value is well-established" is the most honest control such a board can have — it is the user's defence against exactly the failure we fixed today, where 19 editions were publishing an FMV whose backing ask had vanished (one at $1,833). Deleting it removes the reader's ability to protect themselves and makes the board *less* trustworthy, not more.

**Why not leave it as-is.** The no-confidence-UI policy exists because `HIGH` / `MEDIUM` / `ASK_ONLY` are our internal enum labels. A visitor cannot calibrate them — they have no idea whether MEDIUM is good. Publishing implementation vocabulary on an unauthenticated page is the actual thing the policy is protecting against, and it is currently in the lede, the chips, the share text and the methodology.

**So: relabel, don't remove.** Behaviour and the `confidence=HIGH` query param (line 184) stay exactly as they are — this is a copy change only.

| location | from | to |
|---|---|---|
| `DealsBoardClient.tsx:342,348` chips | `High + Med` / `High only` | **`Standard` / `Strict`** |
| line ~341 group label | `CONFIDENCE` | **`FMV BASIS`** |
| `:243-244` lede | `below a trustworthy FMV — HIGH or MEDIUM confidence only` | `below a fair value we can stand behind — editions whose FMV rests on thin or stale evidence are excluded` |
| `:494-496` methodology | `sits below an FMV scored HIGH or MEDIUM confidence` | describe the bar in plain terms: priced from recent corroborated sales, not from a lone or stale listing |
| `:220` share text | `confidence-rated FMV` | `a fair value we can stand behind` |
| OG route `:91` | `confidence-rated FMV` | same replacement |

Keep the `low_confidence_fmv` de-emphasis on the FMV cell (`:457-459`) — that is a visual treatment, not a label, and it degrades gracefully.

This resolves the deadlock recorded on 07-25 (*"deleting them removes functionality, and rewriting the methodology is editorial"*): functionality is preserved, the policy exception is closed, and the copy gets more honest rather than merely quieter.

**Verify:** no occurrence of `HIGH`, `MEDIUM` or `ASK_ONLY` as user-facing text anywhere under `app/insights/deals/**` or the OG route; both chips still filter identically; a test pins the absence of the enum words (mirroring the `panini-launch-flag-contract` anti-overclaim assertions).

**Revert:** revert the commit; copy only.

---

## Guardrails

Unchanged. Two that matter here specifically: assert public reachability from `res.url` and not `res.status` (an anonymous fetch that follows a redirect returns 200 from `/login`), and this is a public SEO surface, so confirm the sitemap entry and canonical still resolve after the title change.

**Claude Code's direct file inspection wins over this doc on any disagreement.**

## Expected end state

`/insights/deals` names all three collections it actually serves, offers an All Day filter chip, and its public API accepts `collection=nfl_all_day` instead of 400-ing; the FMV-basis control still works while no internal confidence tier name appears anywhere on the public surface.
