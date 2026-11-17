# RPC Concierge Audit — May 2026

Investigation only. No prompt or tool changes shipped in this pass — every finding ends in a `keep` / `edit` / `add` recommendation for a follow-up implementation session.

Files audited:
- [app/api/support-chat/route.ts](../app/api/support-chat/route.ts) — system prompt + 10-tool registry (Phase 4 v2 multi-collection)
- [components/SupportChat.tsx](../components/SupportChat.tsx) — `PAGE_DEFAULTS` + `DEFAULT_SUGGESTIONS`
- [lib/collections.ts](../lib/collections.ts) — collection registry, `publishedCollections()`, `COLLECTION_UUID_BY_SLUG`
- Live Supabase verification (project `bxcqstmqfzmuolpuynti`)

---

## TL;DR

The Phase 4 multi-collection rewrite is structurally sound — `collectionId` threads through every shopping tool, `publishedCollections()` drives the welcome blurb, and `search_across_collections` exists. But three **substantive accuracy bugs** exist between what the prompt promises and what the data actually supports:

1. **Disney Pinnacle is structurally invisible to the concierge.** All four data-touching tools (`search_live_deals`, `search_catalog_deals`, `get_fmv`, `explain_fmv`) query the unified `editions` / `cached_listings` / `fmv_snapshots` tables. Pinnacle's data lives in the parallel `pinnacle_editions` / `pinnacle_cached_listings` / `pinnacle_fmv_snapshots` / `pinnacle_sales` schema. Verified row counts in those unified tables for `disney_pinnacle.collection_id`: **0 / 0 / 0**. The concierge will silently return "no results" on every Pinnacle FMV or shopping query today.
2. **Golazos FMV coverage is wildly overstated.** Prompt + collection pitch imply broad coverage; actual is **75 of 581 editions = 12.9%**. The user-facing copy will be wrong roughly 87% of the time on Golazos pages.
3. **UFC Strike messaging is internally contradictory.** Registry has `published: true, badge: "BETA"`; prompt still says "UFC Strike is tracked for catalog purposes only … not currently published." Coverage is 29 / 147 = **19.7%**. The bot needs a positive but clearly-caveated story.

A fourth issue — the NFL All Day on-chain locking quirk — is real but smaller in blast radius (`is_locked` column exists in `cached_listings` but is always `false` today, so it's not currently filtered or surfaced anywhere).

---

## Per-question findings

### Q1. Does the system prompt distinguish between all five published collections and provide accurate per-collection context?

**Partially.** The prompt has a dedicated section ("What Makes Moments Valuable") that calls out per-collection value drivers and a "Sniper Data Sources by Collection" section that names the right feeds. The `${publishedLabels}` interpolation (`buildSystemPrompt`, [route.ts:203](../app/api/support-chat/route.ts#L203)) dynamically lists every published collection from the registry, so the bot will always know the current published roster.

However, three accuracy gaps:

| Field | Prompt claim | Verified reality |
|---|---|---|
| FMV refresh cadence | "Recalculated every 20 minutes per collection" | True for NBA/AllDay/Golazos; Pinnacle FMV uses the parallel pipeline and is not in the unified recalc loop. |
| FMV methodology version | "v1.4.0" | CLAUDE.md says "v1.5.0 live (WAP + days_since_sale + sales_count_30d)". Stale by one revision. |
| UFC Strike publish state | "tracked for catalog purposes only … near-zero on-chain volume; UFC migrated to Aptos — full coverage planned as a future layer" | Registry now has `published: true, badge: "BETA"` ([lib/collections.ts:170-178](../lib/collections.ts#L170-L178)). UFC users will land on Sniper / Overview / Collection / Analytics pages and the bot will tell them the collection isn't published. |

**Recommendations:**
- **Edit** the FMV section: bump to v1.5.0 and explicitly call out "Pinnacle FMV runs on a parallel pipeline keyed off `pinnacle_fmv_snapshots`."
- **Edit** the UFC line to: "UFC Strike is **BETA**-published — limited on-chain volume post-Aptos migration, only ~20% of editions have FMV. Surface listings when they exist; caveat heavily on FMV questions."
- **Keep** the dynamic `publishedLabels` interpolation pattern.

---

### Q2. Are the tools registered in `TOOLS` adequate for the multi-collection world?

**No — Pinnacle is the gap.**

The 10 tools and their data sources:

| Tool | Data path | Pinnacle-aware? |
|---|---|---|
| `search_live_deals` | `/api/sniper-feed?collectionId=…` → falls back to `cached_listings` filtered by unified `collection_id` | ❌ Hits empty unified `cached_listings` for Pinnacle |
| `search_catalog_deals` | `cached_listings` filtered by unified `collection_id` | ❌ Same |
| `get_fmv` | `/api/fmv?edition=…` → unified `editions` + `fmv_snapshots`; or `cached_listings` ILIKE | ❌ Same; `/api/fmv` only knows the unified path |
| `check_wallet` | `/api/wallet-search` (proxies to per-collection adapter) | ✅ Adapter handles Pinnacle separately |
| `search_across_collections` | Loops `publishedCollections()` and queries `cached_listings.collection_id` | ❌ Skips Pinnacle silently because it has 0 rows in unified table |
| `manage_watchlist` / `manage_alerts` | Per-user owner_key APIs | ✅ Collection-agnostic |
| `escalate_to_human` | Telegram + Resend | ✅ |
| `get_collection_snapshot` | `/api/collection-snapshot` | ✅ Adapter routes per-collection |
| `explain_fmv` | `editions` + `fmv_snapshots` (unified) | ❌ Same as `get_fmv` |

Verified table layout (Supabase, 2026-05-03):

```
editions: 0 Pinnacle rows, 14,149 NBA, 6,191 AllDay, 581 Golazos, 147 UFC
cached_listings: 0 Pinnacle rows, totals across other 4 collections
fmv_snapshots (joined to editions): 0 Pinnacle, 12,456 NBA, 5,720 AllDay, 75 Golazos, 29 UFC

pinnacle_editions:        425 rows
pinnacle_cached_listings: 102 rows
pinnacle_fmv_snapshots:   367 rows
pinnacle_sales:         4,113 rows
```

**Recommendations:**
- **Edit** `executeTool()` to branch on `effectiveCollectionId === "disney-pinnacle"` for `search_live_deals`, `search_catalog_deals`, `get_fmv`, `explain_fmv`, and `search_across_collections`. Each Pinnacle branch should query `pinnacle_cached_listings` / `pinnacle_editions` / `pinnacle_fmv_snapshots` directly. Schema on those tables should be confirmed against `information_schema.columns` before writing the queries (they likely don't share the unified tier/badge schema 1:1).
- **Add** a `route_pinnacle()` helper in `lib/concierge/pinnacle-router.ts` (or inline) so the four tool handlers stay readable.
- Alternatively, **add** a Postgres view `cached_listings_unified` that UNION ALLs `cached_listings` + a column-projected `pinnacle_cached_listings` and re-point the tools at the view. Lower code change, higher one-time DB risk. Recommend the per-tool branch — it's narrower and easier to roll back.
- **Keep** the rest of the registry; `search_across_collections`'s loop pattern is correct and only needs the Pinnacle branch swap-in.

---

### Q3. LaLiga Golazos page — does the prompt know enough?

The prompt knows:
- Golazos is published (`publishedLabels` includes it).
- Golazos is "thin volume" — both in the FMV section ("caveat pricing when confidence is LOW, especially for Golazos / Pinnacle") and the value-drivers section.
- Sniper source = "Flowty primary (native marketplace is Cloudflare-blocked from server IPs)".

The prompt does **not** know:
- Golazos tier vocabulary. Bot defaults to NBA Top Shot tiers (Ultimate/Legendary/Rare/Fandom/Common). Golazos uses Ultimate / Legendary / Rare / Fandom / Common too (Dapper-shared schema), so this is mostly fine — but `PAGE_DEFAULTS["sets (laliga-golazos)"]` references "Ídolos sets" and "Estrellas sets" which are Golazos set names, not tiers. That's a UI prompt-pill, not a system-prompt issue.
- Actual Golazos FMV coverage is **12.9%** (75 of 581 editions). Telling a user "FMV is $X" for a Messi moment will misfire 87% of the time.
- Sales velocity: not surfaced anywhere. Without a "low-volume → relative-deals logic" reminder per query, the bot recommends % below FMV the same way it does on NBA Top Shot, where the FMV is statistically meaningful.

**Recommendations:**
- **Edit** the FMV section: add an explicit per-collection coverage note: "Golazos: only ~13% of editions have FMV; for the other 87% answer with floor + recent-sales context, not 'FMV says X'."
- **Edit** the Sniper sources section: reaffirm that the "100x floor outlier filter" is the relative-deals heuristic and the bot should default to it on Golazos / UFC questions.
- **Keep** `PAGE_DEFAULTS["sniper (laliga-golazos)"]` etc — they're well-tuned.

---

### Q4. Disney Pinnacle — does the concierge know to route Pinnacle FMV questions to the right tables?

**No. This is the highest-severity finding.**

The prompt mentions Pinnacle correctly in copy ("Disney Pinnacle: Pinnacle native GQL (via Cloudflare Worker proxy) + Flowty"), but the underlying tools have no concept of the `pinnacle_*` parallel schema. A user on `/disney-pinnacle/sniper` asking "what's the FMV on the Mickey Steamboat pin?" will:

1. Trigger `get_fmv` with `collectionId = "disney-pinnacle"`.
2. Hit `/api/fmv?edition=…&collectionId=disney-pinnacle`.
3. `/api/fmv` queries unified `editions` (zero Pinnacle rows) → returns "Edition not found".
4. Bot says "I couldn't find FMV data for that pin" — when 367 of 425 Pinnacle editions actually have FMV in `pinnacle_fmv_snapshots`.

`search_live_deals` has the same failure mode for Pinnacle and is the dominant tool — every Pinnacle Sniper query returns empty.

**Recommendations:**
- **Edit** all four data-touching tool handlers to branch on Pinnacle and query `pinnacle_*` tables. (Same recommendation as Q2.)
- **Add** a documented invariant to the prompt: "If the active collection is Disney Pinnacle, FMV and listings live in the `pinnacle_*` parallel tables — the tool layer handles routing automatically; do not warn the user about a different schema."
- **Edit** the registry pitch in [lib/collections.ts:129](../lib/collections.ts#L129) — "424 editions tracked, 366 FMV live, 4,087 historical sales" is drift; actuals are 425 / 367 / 4,113. Refresh during the same patch.
- **Add** a smoke-test assertion that hits `/api/support-chat` with `collectionId: "disney-pinnacle"` + a known Pinnacle player and expects a non-"no results" response. Currently nothing in the smoke suite would catch this regression.

---

### Q5. UFC Strike — should the concierge proactively warn users about limited FMV coverage?

**Yes, and the prompt is currently saying the wrong thing.**

State today:
- Registry: `published: true, badge: "BETA"` ([lib/collections.ts:170-171](../lib/collections.ts#L170-L171))
- UFC pages live: overview, collection, sniper, analytics
- Coverage: 29 of 147 editions = **19.7%**
- 24 cached listings, none locked

The prompt currently includes: "UFC Strike is tracked for catalog purposes only (near-zero on-chain volume; UFC migrated to Aptos — full coverage planned as a future layer)." This was true pre-publish. Today a UFC user lands on `/ufc/sniper`, the bot tells them UFC isn't published, and the user is justifiably confused.

**Recommendations:**
- **Edit** the UFC line to something like: "UFC Strike is BETA — published with limited coverage. Only ~20% of editions have FMV; on-chain volume is thin post-Aptos migration. Show listings when they exist, treat FMV as directional only, and proactively flag the BETA caveat on first FMV question per session."
- **Add** to "What Makes Moments Valuable" → UFC Strike: "tier, fighter star power, title-fight context. Note: FMV is directional (~20% coverage); recommend floor + last-sale heuristics over FMV-discount math."
- **Add** a per-collection FMV coverage map (literal numbers in the prompt) so the bot can self-caveat. Example block:
  ```
  ## FMV Coverage Reality (refresh quarterly)
  - NBA Top Shot:  ~88% of editions
  - NFL All Day:   ~92%
  - Disney Pinnacle: ~86% (queried from pinnacle_fmv_snapshots)
  - LaLiga Golazos:  ~13%  → answer with floor + last sale
  - UFC Strike:      ~20%  → BETA, answer with floor + last sale
  ```
- **Keep** the registry's `badge: "BETA"` — it's the right signal for users.

---

### Q6. NFL All Day — does the prompt mention the on-chain locking quirk?

**No, and the data layer doesn't surface it either.**

- `cached_listings.is_locked boolean` column exists ([verified 2026-05-03](../app/api/support-chat/route.ts)).
- All 274 listings across all collections currently show `is_locked = false`. So nothing is filtered out today, but nothing surfaces a locked-state warning either.
- AllDay's locking quirk: when a user locks a moment for set-completion bonuses, it disappears from their wallet display in the AllDay native UI. Users frequently report "moments missing" when they're actually locked. This is a known support pattern.

The prompt's "Common Questions" section should preempt this. Today it does not.

**Recommendations:**
- **Add** a Common Question: "**'My All Day moments disappeared' →** Probably locked for set completion. Locked moments don't show in the standard wallet UI but are still on-chain. Ask the user to check their AllDay set-completion / vault page before escalating to Trevor."
- **Edit** the escalation rules to explicitly say: "For 'moments missing' on AllDay, first ask if the user has locked any moments for set completion — that's the #1 root cause and not a bug."
- Defer the data-layer change (surfacing `is_locked = true` listings somewhere) until we have a confirmed locked-listing seen in the wild — the column exists for free hardening when needed.

---

### Q7. Does the concierge correctly cite that FMV is not financial advice when asked?

**Inconsistently, but the surface area covers it.**

- `SupportChat` UI footer always renders "AI concierge · Prices are live · Not financial advice" ([SupportChat.tsx:482](../components/SupportChat.tsx#L482)). Always-on visual disclaimer.
- The system prompt has zero explicit "not financial advice" or "DYOR" instruction. If a user explicitly asks "is this a good investment?" the bot's tone guidance ("clear buy/watch/pass recommendation when asked about a single item") will encourage a recommendation without the caveat.
- No `disclaimer` or `risk` keyword anywhere in the prompt.

**Recommendations:**
- **Add** a short prompt section under "Tone":
  ```
  ## Disclaimers
  Treat every recommendation as collector commentary, not financial advice.
  When asked "should I invest in X?" or "is this a good ROI play?", give the
  buy/watch/pass call but explicitly close with a one-liner: "This is collector
  commentary, not financial advice — moments can lose value fast."
  Do NOT add the disclaimer to every response — only when the user frames the
  question in investment / financial / ROI terms.
  ```
- **Keep** the always-on footer in SupportChat.tsx — visual disclaimer is covered.

---

## Cross-cutting recommendations

### CLAUDE.md drift

The CLAUDE.md "Supabase schema facts" section is outdated:
- Claims `editions` has only `id` and `external_id`. Actually has 29 columns including `player_name`, `set_name`, `tier`, `team_name`, `circulation_count`, `badges`, `thumbnail_url`, `video_url`, etc. Verified via `information_schema.columns`.
- The `explain_fmv` tool's `select("id, player_name, set_name, tier")` works because the columns exist — CLAUDE.md is wrong about the schema.

**Recommendation:** Out of scope for the concierge audit, but flag this for the same follow-up session — fix CLAUDE.md to match reality so future sessions don't write defensive code based on a false constraint.

### Tools that should set `collectionId` defaults more aggressively

`get_fmv`, `explain_fmv`, `manage_watchlist`, `manage_alerts` accept an `editionKey` like `"84:2892"` — a Top Shot-shaped key. Pinnacle / AllDay / Golazos use different edition-key shapes. Today none of those tools validate the key against the active collection.

**Recommendation:** **Add** validation in `executeTool()` — if `editionKey` is provided and shape doesn't match the active collection's expected format (e.g., AllDay uses a different ID scheme), warn in the tool result rather than silently returning "not found".

### Prompt size discipline

The current `buildSystemPrompt()` returns ~6.5k characters. Adding the recommended sections (FMV coverage map, Pinnacle routing note, AllDay locking FAQ, financial-advice disclaimer) would push it to ~8.5k. Still well under any model-side limit and well-structured.

**Recommendation:** **Keep** the current section-headed structure. **Add** new sections in the order: FMV coverage map → Pinnacle routing → AllDay locking → financial-advice disclaimer. Don't reorder existing sections (avoid cache invalidation on system-prompt prefix caching if/when added).

---

## Punch list for the implementation session

In order, lowest risk first:

1. **Edit** UFC Strike paragraph in `buildSystemPrompt` — flip from "tracked for catalog purposes only" to "BETA-published with caveats". Single-line edit. (Q5)
2. **Edit** FMV methodology version in prompt: v1.4.0 → v1.5.0. (Q1)
3. **Edit** registry pitch for Disney Pinnacle: refresh 424→425 / 366→367 / 4,087→4,113. (Q4)
4. **Add** "FMV Coverage Reality" section to prompt with literal per-collection percentages. (Q3, Q5)
5. **Add** AllDay locking FAQ to "Common Questions". (Q6)
6. **Add** financial-advice disclaimer guidance to "Tone". (Q7)
7. **Edit** four tool handlers (`search_live_deals`, `search_catalog_deals`, `get_fmv`, `explain_fmv`) + `search_across_collections` to branch on Disney Pinnacle and query `pinnacle_*` tables. Verify `pinnacle_*` schema first. (Q2, Q4)
8. **Add** Pinnacle smoke-test assertion. (Q4)
9. **Add** edition-key shape validation per active collection. (Cross-cutting)

Items 1–6 are pure prompt-string edits and can ship together. Items 7–9 are code changes that should ship in a second commit so the prompt fixes are visible in `git log` before the schema-routing change is reviewed.
