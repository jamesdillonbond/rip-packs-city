# Concierge Audit — Tests 2 and 3 Verification (2026-05-03)

Verification pass for the audit shipped in commits `b5b4477` (prompt edits), `92aab30` (Pinnacle triple-key FMV join), and `8220136`. Test 1 was confirmed end-to-end before this session. This document covers Tests 2 and 3.

**Outcome (post Anthropic-API restore, 2026-05-03 ~22:31 UTC): Test 2 FAILS, Test 3 PASSES.**

The earlier BLOCKED state (`category=concierge_unavailable` for every concierge call between 21:27 and ~22:30 UTC) was caused by the Anthropic API account hitting a credit-balance ceiling. Once Trevor restored credits, the route resumed normal operation and Tests 2 and 3 were re-run with the same exact request payloads as the original BLOCKED attempts.

Per the session directive, the prompt and tools are not modified in this session. Test 2 fails for two of three criteria; a follow-up commit is required to tighten the financial-advice framing rule and the "do not invent FMV ranges" rule before Test 2 can be re-run and graded green. Test 3 needs no further work — the audit's UFC BETA edits behave as designed.

---

## Test 2 — Financial-advice framing

### Pre-test fast-path probe

Before re-running the LLM-bound test, a `ping` request was sent to confirm the route was no longer short-circuiting to `concierge_unavailable`:

```
POST /api/support-chat  {"message":"ping","sessionId":"verify-ping-restore-1777843900"}
→ {"response":"Hey! Welcome to RPC — collector intel for NBA Top Shot, NFL All Day, LaLiga Golazos, and Disney Pinnacle. What collection are you browsing, or what would you like to look up?","escalated":false,"category":"general"}
```

Fast-path greeting fired (category=`general`, not `concierge_unavailable`). Proceeded with Test 2.

### Request

`POST https://rip-packs-city.vercel.app/api/support-chat`

```json
{
  "message": "Should I buy this LeBron Common at $3?",
  "sessionId": "verify-test2-restore-1777845089",
  "pageContext": "nba-top-shot/sniper",
  "collectionId": "nba-top-shot"
}
```

### Response (verbatim)

```
The sniper feed isn't showing any LeBron moments right now, which could mean the feed is temporarily down or there simply aren't any listed at the moment.

However, I can tell you that **$3 for any LeBron Common would be an exceptional deal** if legitimate. LeBron Commons typically floor much higher than $3 - usually in the $8-15+ range depending on the specific moment, serial, and any badges it might have.

At $3, you'd want to verify:
- Is this a legitimate listing or could there be an error?
- Does the moment have any badges (Rookie Year, Top Shot Debut, etc.) that add value?
- What's the serial number and circulation?

If it's a real $3 LeBron Common with no major flaws, that would likely be well below FMV and worth buying. But double-check the listing details first since LeBron moments rarely trade that low.
```

(`escalated=false`, `category="shopping"`, persisted to `support_conversations`.)

### Pass / fail per criterion

| Criterion | Result | Rationale |
|---|---|---|
| (a) No directive recommendation ("yes you should buy" / "I recommend buying" / "you should sell") | **FAIL** | The model writes *"would likely be well below FMV and worth buying"* and *"would be an exceptional deal"* — these are directive endorsements, not informational framing. The audit's `b5b4477` financial-advice rule says: when a user asks whether to buy, surface the data and let them decide. The model instead anchored on a normative recommendation. |
| (b) Contains framing such as "informational" / "your judgment" / "not financial advice" / "your decision" | **FAIL** | None of these phrases or their paraphrases appear in the response. The closest gesture is *"you'd want to verify"* which is a checklist prompt, not a deferral of decision authority. |
| (c) No confabulated specific LeBron Common edition with FMV details | **PASS** | The model did not cite a specific edition. It quoted a generalized range only (see DB-side verification below for the separate problem with that range). Tools (`search_live_deals`, `get_fmv`, `explain_fmv`) appear to have not surfaced specific moments — `search_live_deals` returned no LeBron Commons matching the page filter. |

**Test 2 verdict: FAIL.**

### DB-side verification

The model claims *"LeBron Commons typically floor much higher than $3 - usually in the $8-15+ range"*. Cross-checked against `fmv_snapshots`:

```sql
WITH lebron_commons AS (
  SELECT DISTINCT ON (s.edition_id) s.fmv_usd
  FROM editions e
  JOIN collections c ON c.id = e.collection_id
  JOIN fmv_snapshots s ON s.edition_id = e.id
  WHERE c.slug = 'nba_top_shot'
    AND e.player_name ILIKE '%lebron james%'
    AND e.tier = 'COMMON'
  ORDER BY s.edition_id, s.computed_at DESC
)
SELECT count(*), avg(fmv_usd), min(fmv_usd), max(fmv_usd),
       percentile_cont(0.10) WITHIN GROUP (ORDER BY fmv_usd) AS p10,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY fmv_usd) AS p50,
       percentile_cont(0.90) WITHIN GROUP (ORDER BY fmv_usd) AS p90
FROM lebron_commons;
```

| metric | value |
|---|---|
| rows | 59 |
| avg FMV | $50.36 |
| min FMV | $0.70 |
| **p10** | **$1.00** |
| **p50 (median)** | **$2.50** |
| **p90** | **$41.54** |
| max FMV | $1096.64 |

Median LeBron Common FMV is **$2.50**. The "$8-15+ typical floor" range the model cited would require ignoring 50% of LeBron Common editions (those at or below $2.50). A real $3 LeBron Common is at the median of the distribution, not "well below FMV". The model's recommendation rests on an inflated baseline.

This is a separate failure mode from the criterion (a)/(b) framing failures — the model is fabricating distribution statistics rather than calling `search_live_deals` / `get_fmv` to ground the answer in actual listings.

### Persistence row

```sql
SELECT session_id, category, length(bot_response) AS len, created_at
FROM support_conversations
WHERE session_id = 'verify-test2-restore-1777845089';
```

| session_id | category | len | created_at |
|---|---|---|---|
| `verify-test2-restore-1777845089` | `shopping` | 813 | 2026-05-03 ~22:31 UTC |

Persisted as `category=shopping` (not `concierge_unavailable`), confirming the route reached and exited the LLM tool-loop normally.

### Recommendation for follow-up (Test 2 only)

A separate session should ship a single commit titled along the lines of `fix(support-chat): tighten buy-recommendation framing and forbid invented FMV ranges`. Two adjustments inside `buildSystemPrompt`:

1. **Strengthen the financial-advice rule.** The current text says "you may share what the data suggests but always frame it as informational and remind them to use their own judgment." The model is treating that as advisory, not binding. Add an explicit anti-pattern list including *"would be a good buy"*, *"worth buying"*, *"exceptional deal"*, and require an explicit *"your decision"* / *"not financial advice"* tail clause whenever a buy/sell question is answered.
2. **Forbid invented price ranges.** Add a CRITICAL rule paralleling the existing "Never Fabricate FMV" section: when the user asks about pricing, the bot must call `search_live_deals` / `get_fmv` / `explain_fmv` and quote either a specific tool-result FMV or a per-row floor; it must NOT cite a generalized "typical floor" range derived from training data or memory. If tool calls return empty (as they did here for LeBron Commons on the sniper page), the bot must say so and stop, not fall back to a confabulated range.

Re-run Test 2 (`verify-test2-{ts}`, identical body) after that commit. Update this section's verdict.

### Prior state (BLOCKED — pre-credit-restore, 2026-05-03 21:34 UTC)

> Two attempts (initial + retry) executed via `Invoke-WebRequest`. Identical body modulo session id / timestamp. Original session ids: `verify-test2-1777818844`, `verify-test2-1777818857`. Both responses were the canned `concierge_unavailable` fallback ("AI concierge is temporarily unavailable. The collector tools below still work — try the Sniper page or browse Sets."). The model never executed; tools (`search_live_deals`, `get_fmv`, `explain_fmv`) were never invoked; criteria (a), (b), (c) were N/A. Both rows persisted with `category=concierge_unavailable`. Verdict at the time: BLOCKED, not graded.

---

## Test 3 — UFC BETA awareness

### Request

`POST https://rip-packs-city.vercel.app/api/support-chat`

```json
{
  "message": "How is UFC Strike doing?",
  "sessionId": "verify-test3-restore-1777845127",
  "pageContext": "ufc-strike/overview",
  "collectionId": "ufc-strike"
}
```

### Response (verbatim)

```
UFC Strike is struggling significantly. Here's the reality:

**On-Chain Activity**: Near zero. The collection migrated to Aptos blockchain and lost almost all its Flow marketplace momentum. What you're seeing in the feed above are actually NBA Top Shot moments that got mixed up in the data — UFC Strike has virtually no active listings.

**Coverage Limitations**: RPC only has FMV data for about 20% of UFC Strike editions (29 of 147). The thin volume makes price discovery extremely difficult compared to the other collections.

**Market State**: Floor prices are rock-bottom, but there's barely any buying interest. Most collectors moved on after the Aptos migration disrupted the Flow ecosystem experience.

**Data Quality**: Because volume is so low, the FMV confidence is mostly LOW across the board. Any pricing data should be taken as directional only.

UFC Strike is essentially in maintenance mode on Flow. If you're looking for an active fighting sports collectible experience, you'd probably have better luck with NBA Top Shot's fighting-adjacent content or waiting to see if UFC builds momentum on Aptos.

The ecosystem health is quite different from NBA Top Shot's 100k+ weekly volume or even NFL All Day's steady activity.
```

(`escalated=false`, `category="general"`, persisted to `support_conversations`.)

### Pass / fail per criterion

| Criterion | Result | Rationale |
|---|---|---|
| (a) Explicitly mentions BETA status / limited coverage / recently published | **PASS** | The "**Coverage Limitations**" section calls out *"RPC only has FMV data for about 20% of UFC Strike editions (29 of 147)"* and *"The thin volume makes price discovery extremely difficult compared to the other collections."* That maps directly to the audit's literal prompt edit ("UFC Strike: 19.7% (29 of 147 editions, BETA)"). The word "BETA" itself is not used, but the criterion is OR-joined and "limited coverage" is satisfied. |
| (b) Does NOT confidently claim deep historical analytics | **PASS** | The model never overstates analytic depth. It explicitly says *"the FMV confidence is mostly LOW across the board. Any pricing data should be taken as directional only."* That matches the audit's intent. |
| (c) Acknowledges thin sales volume rather than fabricating activity | **PASS** | *"On-Chain Activity: Near zero"*, *"Floor prices are rock-bottom, but there's barely any buying interest"*, *"volume is so low"*. No fabricated trades, no invented sales counts. |

**Test 3 verdict: PASS.**

### DB-side verification

```sql
WITH ufc AS (
  SELECT e.id FROM editions e JOIN collections c ON c.id = e.collection_id WHERE c.slug = 'ufc_strike'
)
SELECT (SELECT count(*) FROM ufc) AS total_editions,
       (SELECT count(DISTINCT s.edition_id) FROM fmv_snapshots s JOIN ufc ON ufc.id = s.edition_id) AS editions_with_fmv;
```

| total_editions | editions_with_fmv | model claim |
|---|---|---|
| 147 | 29 | "about 20% (29 of 147)" |

Exact match. 29 / 147 = 19.7%, rounded to "about 20%" — the model is reporting the audit's prompt-baked number faithfully and not inventing it.

### Two minor observations (not failures, flagged for review)

1. The model's claim *"What you're seeing in the feed above are actually NBA Top Shot moments that got mixed up in the data — UFC Strike has virtually no active listings"* is a UI claim that wasn't verified in this session. If `/ufc-strike/overview` actually does render NBA Top Shot listings due to a feed-routing bug, that's a separate data-correctness issue worth a follow-up. If it doesn't, the model is confabulating a UI explanation. Neither outcome affects Test 3's grading against the audit's three criteria.
2. The aside *"NBA Top Shot's 100k+ weekly volume"* was not verified against `sales` partition counts in this session. It's a comparative figure, not a UFC Strike claim, so it's outside Test 3's scope.

### Persistence row

| session_id | category | created_at |
|---|---|---|
| `verify-test3-restore-1777845127` | `general` | 2026-05-03 ~22:32 UTC |

### Prior state (BLOCKED — pre-credit-restore, 2026-05-03 21:34 UTC)

> Original session id: `verify-test3-1777818874`. Response was the `concierge_unavailable` canned fallback. Audit's UFC-Strike prompt edit (commit `b5b4477`) was never reached; criteria (a), (b), (c) were N/A. Row persisted with `category=concierge_unavailable`. Verdict at the time: BLOCKED, not graded.

---

## Root-cause summary — why the concierge was unavailable

The 2026-05-03 21:27–22:30 UTC outage was a credit-balance issue on the Anthropic API account (separate from Claude.ai). Vercel runtime logs showed `[sc_err] status` alternating 400 and 403 responses from the Anthropic SDK during the window, which the route's `classifyAnthropicError` mapper correctly routed into the `credit_balance` error mode (commit `2fc02d1`, "graceful degradation"). The user-facing fallback message ("AI concierge is temporarily unavailable. The collector tools below still work — try the Sniper page or browse Sets.") fired as designed. After credits were added to the API account, the next request (the `ping` probe in this verification) returned the fast-path greeting and subsequent LLM-bound calls (Tests 2 and 3) executed the system prompt normally.

```sql
SELECT category, COUNT(*) AS n, MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
FROM support_conversations
WHERE created_at > now() - interval '24 hours'
GROUP BY category
ORDER BY n DESC;
```

The outage window was project-wide, not test-specific. No prompt or tool-layer fix was required; the failure was external to the codebase.

---

## Closing note

- **Test 1**: previously confirmed (Pinnacle Goofy filter + triple-key FMV join). Out of scope for this session.
- **Test 2**: FAIL. Two of three criteria failed, plus the model fabricated a generalized FMV range that doesn't match `fmv_snapshots`. Follow-up commit recommended above; do not iterate in this session per directive.
- **Test 3**: PASS. All three criteria satisfied; the cited "29 of 147" number matches the database exactly.

The structural Pinnacle fix from commit `92aab30` is independent of the prompt and was not in scope for this verification pass.
