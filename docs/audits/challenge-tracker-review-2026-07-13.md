# Challenge Tracker review — reconciled against the live `SearchChallenges` feed (2026-07-13)

**Trigger:** Trevor pasted a browser `fetch()` dump of NBA Top Shot's real
`SearchChallenges` GraphQL query + full response (all active Series-8 challenges),
against the `claude/rpc-challenge-tracker-review-*` branch. This review reconciles the
tracker built on 2026-07-12 (`challenges` / `challenge_editions` schema, the two
intelligence RPCs, the Cowork ROI-board unify, and the still-disabled GraphQL ingest)
against what the endpoint actually returns.

**Bottom line:** the storage + read side is live and useful, but it models the wrong
challenge shape. Every live challenge is a Challenge-Builder **VARIABLE** challenge
(fill N per-slot player queries), not "own every edition in a base set." The tracker
seeds full base-set membership into `challenge_editions`, which **over-counts required
moments in every case** (≈1.3–2×) and therefore **overstates cost-to-complete**. The
automated ingest is built on a GraphQL shape that the pasted probe output shows was
never actually confirmed. None of this is shipping wrong data silently today (the ingest
is disabled; the board is a labelled approximation), but the numbers on the live
`/nba-top-shot/challenges` page are systematically high.

---

## 1. What the endpoint actually returns (verified from the paste)

- **Operation:** `SearchChallenges(input: SearchChallengesInput!)` on
  `v1.nbatopshot.com/marketplace/graphql` (browser, credentialed). The **same root field
  is reachable server-side through the existing `topshot-proxy` worker** — the
  `probe-topshot-challenges.mjs` output Trevor ran confirms `searchChallenges` **EXISTS**
  on the worker's `public-api.nbatopshot.com/graphql` upstream, so no credentialed/
  marketplace endpoint is needed for ingest.
- **Response path:** `searchChallenges.data.searchSummary.data.data[]` (`... on
  UserChallenges { data { … } }`), 30 active nodes.
- **Every node is `type = "VARIABLE"`**, `slots: []` (the fixed
  `slots{ playID setID filledMomentID }` list is empty for all of them), and all content
  lives under `variableChallenge.variableSlots[]`.
- **Each `variableSlot`** = one required lock, shaped as a *query*, not an edition:
  - `slotType: "LOCK"`, `label` (player name), `slotOrder`, `helpText`
  - `query.byPlayers: ["<NBA stats id>"]` (e.g. James Harden `201935`)
  - `query.bySets: ["<Top Shot set UUID>"]` (e.g. `edbf04d6-…`)
  - `query.bySeries: ["8"]` (Series 2025-26 — all current challenges)
  - optional `query.byPlayCategory: ["Dunk"|"Reel"|"3 Pointer"|…]`
  - many more unused-here facets: `byMomentTiers`, `byTeams`, `byPlayIDs`,
    `bySetPlayTagIDs`, `byLeagues`, `bySubeditionIDs`, `byGameDate`, `byPrice`, …
- **Reward:** `reward{ playID setID assetPathPrefix }` + `rewardStatus`; challenge-level
  `numUsersCompleted`, `numUserSubmissions`, `expirationDate`, `variableChallenge.prize`.
- **Per-user progress** (when the request carries the user's `x-id-token`):
  `userSubmission.slots[] { slotID → momentID }` — which of *my* moments are locked into
  which slot. This is the exact data for a personalized "slots filled / still open" view.

A slot's meaning: **"lock one moment of player X, in set S, Series 8 (optionally play
category C)."** Number of slots ≈ number of distinct required players. Confirmed on the
paste: 2026 NBA Playoffs = 53 slots / 52 distinct players (one player appears twice under
different play categories); Rookie Debut = 61 slots / 61 players; Clamps = 20 / 20.

---

## 2. The over-count (headline correctness finding)

`challenge_editions` was backfilled from the Cowork ROI board as **full base-set
membership** ("collect the whole set"). But a VARIABLE challenge needs one moment **per
slot**, chosen as the **cheapest eligible** — and slots are always fewer than the base
set. Live `SearchChallenges` slot counts vs the seeded `challenge_editions` count
(`external_id`s match the real challenge node ids exactly, so the linkage is right — only
the required-set is wrong):

| Challenge | live slots | seeded editions | over-count |
|---|--:|--:|--:|
| Rookie Debut | 61 | 116 | 1.90× |
| Clamps | 20 | 40 | 2.00× |
| Hoop Vision | 20 | 40 | 2.00× |
| For The Win | 20 | 40 | 2.00× |
| Throwdowns | 20 | 40 | 2.00× |
| Vintage Vibes | 40 | 80 | 2.00× |
| Extra Spice | 20 | 39 | 1.95× |
| Fresh Threads | 20 | 39 | 1.95× |
| Marquee | 20 | 38 | 1.90× |
| Hustle & Show | 20 | 35 | 1.75× |
| Freshman Gems | 30 | 54 | 1.80× |
| Bag Work | 20 | 31 | 1.55× |
| Breakout | 20 | 32 | 1.60× |
| Constellations | 27 | 42 | 1.56× |
| Metallic Gold LE | 90 | 144 | 1.60× |
| Holo Icon | 50 | 96 | 1.92× |
| Origins | 30 | 44 | 1.47× |
| Top Shot This: Playoffs | 25 | 43 | 1.72× |
| 2026 NBA Playoffs | 53 | 76 | 1.43× |
| Top Shot This | 20 | 29 | 1.45× |
| Equinox | 20 | 29 | 1.45× |
| Rookie Revelation | 30 | 60 | 2.00× |
| Run It Back | 15 | 30 | 2.00× |
| Top Script | 12 | 24 | 2.00× |
| Season Tip-Off | 20 | 36 | 1.80× |
| Mojo | 20 | 27 | 1.35× |
| Ascension | 20 | 34 | 1.70× |
| Heat Check | 20 | 20 | 1.00× |
| Video Game Numbers | 20 | 20 | 1.00× |
| Playoff Premieres | 3 | 3 | 1.00× |

Only the three at the bottom happen to have slots == base-set size. **For everything
else `cost-to-complete` sums roughly 1.3–2× too many floors** — and it isn't just
"more rows": the correct cost is `Σ_slots min(floor over editions matching that slot's
query)`, i.e. the *cheapest qualifying moment per required player*, honoring
`byPlayCategory`. The current base-set SUM has no per-slot min and includes editions for
players/plays that no slot requires. The direction is always the same: **overstated
cost, understated net EV** — so a genuinely +EV challenge can read as "PREMIUM."

(Progress semantics are wrong the same way: `get_active_challenges` / `get_challenge_plan`
count `wmc` rows whose `edition_key` is in the base set as "owned," but completion is
really "≥1 owned moment locked into each slot," and Top Shot requires **LOCK**, not mere
ownership — a locked moment can't be sold, which is the whole cost of entry.)

---

## 3. The ingest is built on an unconfirmed (fabricated) shape

`lib/challenges/topshot-ingest.ts` carries `CHALLENGE_QUERY =
getActiveChallenges { challenges { id name description type reward{setID playID}
slots{setID playID} } }` with the comment *"Confirmed via
scripts/probe-topshot-challenges.mjs … UserChallenge exposes the required-moment list as
slots[].{setID,playID}."*

The pasted probe output contradicts this directly:

```
getActiveChallenges  EXISTS  returns object type GetActiveChallengesResponse!
  confirmed subfields: (none of the guesses matched — read the suggestion list above)
```

So `getActiveChallenges` is a real root field, but its `{ challenges { slots{setID
playID} } }` sub-shape was **never confirmed** — it's a guess. And the live reality is
that challenges expose their required moments as `variableChallenge.variableSlots[].query`
(player/set/series), **not** concrete `setID:playID`. If `CHALLENGE_INGEST_ENABLED` were
flipped on today, `fetchTopshotChallenges()` would (correctly) throw on the unexpected
shape and write nothing — fail-safe, but the code's own comments assert a false "confirmed"
status that would mislead the next person into wiring garbage. This review corrects those
comments; the actual rewrite is gated on §4.

---

## 4. Corrected design (what "right" looks like)

The fix is a real feature build, not a drop-in, and it touches challenge cost/EV logic —
so it wants Trevor's go-ahead before shipping, not a blind push. Shape:

1. **Slots, not just editions.** Add a `challenge_slots` table (or a `slots` jsonb on
   `challenges`): one row per `variableSlot` carrying `slot_order`, `label`, and the
   resolved query (`nba_stats_id`, `set_external_id`, `series`, `play_category`).
   Keep `challenge_editions` as the *resolved eligibility set per slot* (slot_id →
   eligible `external_id`s) so the read path stays a join, not a live GraphQL call.
2. **Ingest from `searchChallenges` through the worker.** Real query in §1; iterate
   `searchSummary.data.data[]`, read `variableChallenge.variableSlots[]`. Pull
   `expirationDate` → `ends_at`, `numUsersCompleted` → `completed_count`,
   `variableChallenge.prize`/reward → reward fields. This also fills the deadline/
   completion fields the old guessed endpoint couldn't.
3. **Resolve each slot → eligible editions** at ingest:
   `editions WHERE set_id = (set by bySets UUID) AND player_id = (player by nba_stats_id)
   AND series = bySeries AND (play_category = byPlayCategory when present)`.
4. **Correct cost / progress RPCs:** `cost_to_complete = Σ_slots MIN(COALESCE(low_ask,
   fmv) over that slot's eligible, unowned editions)`; `owned/filled = COUNT(slots with
   ≥1 owned eligible edition)`; surface the cheapest qualifying moment per open slot in
   the plan drill-down (that's the actionable "buy this one" signal). Optionally consume
   `userSubmission.slots[]` for exact locked-state when a verified wallet's token is
   available.

**Blocker to call out:** step 3's player leg needs `players.nba_stats_id`, which is
**0 / 4,347 populated** today (column exists, never backfilled). Set resolution already
works (`sets.external_id` matches the `bySets` UUID; `editions.play_category` exists).
So the prerequisite is a `players.nba_stats_id` backfill (from Top Shot player metadata,
or a name/jersey/team bridge keyed on the slot `label`) before per-slot resolution is
exact. Until then, an interim honest improvement is to **cap required to the slot count**
(cheapest N of the base set) rather than summing all base-set editions — closer than the
current number, though not player-exact.

---

## 5. What's actually good (keep)

- `external_id` linkage to real Top Shot challenge ids is correct (verified against the
  paste), so re-ingest upserts cleanly onto the existing rows.
- Reward valuation (reward-pack `gross_ev` from `pack_ev_latest`, drop-pool fallback,
  reward-moment FMV) and the cached-cost refresh cron are sound and reusable as-is.
- The set-completion join path (`badge_editions.low_ask` floor + `mv_topshot_set_play_catalog`
  FMV − `wmc` ownership) is the right engine; it just needs to run **per slot** instead of
  **per base set**.
- Net-EV framing ("should I do this?") is the genuine differentiator vs nbatopshot.com and
  third-party trackers — worth finishing correctly.

## 6. Recommendation

Ship: this review + the honesty correction to the ingest comments (done this session,
no behavior change, ingest stays disabled). Hold for Trevor's go-ahead: the §4 rebuild
(slot model + `nba_stats_id` backfill + corrected cost/progress RPCs), because it changes
challenge cost/EV numbers users see. Quick interim option if we want the live page less
wrong before the full build: cap `challenge_editions` to the per-challenge slot count.
