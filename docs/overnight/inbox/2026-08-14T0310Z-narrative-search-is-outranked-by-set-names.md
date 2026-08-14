# Narrative search does not work: set names outrank the prose that answers the question

**Filed** 2026-08-14 03:10Z (2026-08-13 20:10 PT) by Claude Code (interactive), after Trevor pointed out
that the demo results were wrong on the domain facts.
**Status** QUEUED — read-only diagnosis. My own consuming surfaces are already corrected (below).
**Severity** medium-high. No outage; a live public feature does not do what it and its UI claim.

## What the product claims

`/api/search` states its `searches` as including `"moment description"`, `GlobalSearch` renders a coverage
disclosure implying narrative queries are supported, and CLAUDE.md records that narrative search shipped
2026-08-13 with `lillard game winner` → "Damian Lillard — For the Win" as the proof.

**That proof was a false positive.** "For the Win" is a SET NAME containing the query words. The result was
set-name matching being mistaken for prose matching — by me, in this session's own verification.

## The finding

Trevor's domain point is the tell: *game winner* is not a set. The two most famous Blazers game winners —
both playoff series winners — are not in the "For The Win" set at all:

| slug | set | moment | has description? |
|---|---|---|---|
| `48:1652` | Archive Set | 2014 0.9-second series winner vs Houston | yes — contains **"game-winning"** verbatim |
| `121:4255` | Run It Back: Legacies 2014-19 | 2019 37-footer vs OKC | yes — contains **"buzzer"** verbatim |

Measured against production (`rpc_search_catalog`, Top Shot scoped, limit 30):

| query | rows | returns either real game winner |
|---|---|---|
| `game winner` | 30 | **0** |
| `buzzer beater` | 30 | **0** |
| `series winner` | 17 | **0** |
| `game winning shot` | 30 | **0** |
| `walk off winner` | 15 | **0** |
| `lillard game winner` | 3 | **0** |
| `lillard buzzer beater` | 0 | **0** |

What `game winner` *does* return is a roster of the **"For The Win" set** — including
`For the Win · **Block**` (Dinwiddie `128:5072`, Watson `170:5852`, Siakam `249:8497`). A block is not a
game winner, which is exactly how the defect announces itself to anyone who knows the catalog.

Single tokens fail the same way: `buzzer` returns **Buddy Hield** (fuzzy name match) and not the moment
whose description contains the word "buzzer".

## ⚠ The prose arm is NOT broken — it is outranked. This is the actionable part.

Decisive control: a phrase that appears ONLY in description text and in no name or set —

    rpc_search_catalog('weber state', <topshot>, 30)  →  1 row, exactly 201:7031 ✅

So description search works. The problem is **scoring**: matches are ranked by trigram `similarity()`,
which is **length-normalized**. A 200+ character paragraph that contains the phrase verbatim scores LOW
against a 2-word query, while the short set name "For The Win" scores HIGH. Result: prose only wins when
the query is a distinctive proper noun that nothing else matches; any generic narrative phrase is crowded
out by set names.

**`similarity()` is the wrong scorer for a long text field.** Candidate fixes, cheapest first:

1. **Containment boost.** If `description ILIKE '%<phrase>%'`, add a large fixed bonus — verbatim
   containment in prose is a much stronger signal than trigram proximity on a set name. This alone would
   fix `48:1652` for "game-winning" and `121:4255` for "buzzer".
2. **Full-text ranking on description** (`tsvector` + `websearch_to_tsquery` + `ts_rank`), which is
   length-aware in the right direction and handles stemming ("winning" → "win"). Needs a new index and a
   migration; the correct long-term answer.
3. **Do not** simply raise the existing `via_prose` 0.12 boost — the gap here is structural (a length-
   normalized score vs a short string), not a constant offset, and tuning the constant will paper over
   generic phrases while still missing the ones that matter.

⚠ **Verify any fix against `48:1652` and `121:4255` specifically**, not against "does the query return
rows". Returning 30 confident rows is exactly the failure state today.

## Also worth deciding (product, not a bug)

Stemming is a real gap even after ranking is fixed: `121:4255` contains "buzzer" but a user will type
"buzzer beater"; `48:1652` contains "game-winning" but a user will type "game winner". Option 2 above gets
this for free; option 1 does not.

## What I already corrected in my own surfaces

- **Removed** the "Find a game winner" concierge pill shipped hours earlier — it demonstrated set-name
  matching while claiming to demonstrate narrative search. Replaced with a test that keeps it from being
  re-added until this is fixed and verified against those two slugs.
- **Rewrote the `search_catalog` tool description and its system-prompt section** so the assistant no
  longer promises narrative search, is told the concrete "For The Win" failure, and is required to read
  results before presenting them — if the hits all share one set name and don't match what the user
  described, it must say so rather than present a set roster as an answer.

## Not corrected, needs an owner

`/api/search`'s own `meta.searches` still advertises `"moment description"` and `GlobalSearch` still
renders the coverage disclosure, both of which imply a narrative capability the ranking does not deliver.
That copy is defensible *if* the ranking is fixed shortly; if this sits, the wording should be softened to
describe what actually works (distinctive phrases), or the coverage note reframed. Left alone deliberately
because it is another session's surface, shipped today, and the right fix is the ranking rather than more
caveat copy.


---

# ⚠ CORRECTED 2026-08-14 — the diagnosis above is PARTLY WRONG. Measured mechanism below.

I wrote above that "matches are ranked by trigram `similarity()`, which is length-normalized, so a long
paragraph scores low". **That is not what happens.** I read the function this time instead of inferring
from behaviour, and tested three hypotheses — two of which I had to reject, including my own.

## What the function actually does

The edition arm's similarity is computed against **names only**:

    extensions.similarity(lower(coalesce(e.player_name,'') || ' ' || coalesce(e.set_name,'')), v_q)

The description is **not in the similarity expression at all**. Its entire contribution is a FLAT boolean:

    CASE WHEN via_prose THEN 0.12::real ELSE 0.00::real END

So there is no "length-normalized paragraph score" to fix. There is a flag.

## The measured numbers

| row | why it matches | score |
|---|---|---|
| `121:4255` (Run It Back: Legacies) | description literally contains **"buzzer"** | **0.1404** |
| Buddy Hield | *name* is trigram-similar to "buzzer" — no prose match whatsoever | **0.4676** |

A **verbatim containment in the prose loses 3× to a fuzzy name resemblance**, because a player hit also
collects the `0.35` kind-weight while a prose hit collects `0.12`.

And because the prose boost is FLAT, every prose hit scores identically — so within them the effective
ordering is the tiebreak, `u.n DESC, u.lbl ASC`, i.e. **alphabetical by player name**. That is why a
specific moment is unreachable even at limit 50: it is not outranked by one thing, it is buried in a mass
of equally-scored rows.

## Two hypotheses I tested and REJECTED — do not re-derive them

1. **Candidate truncation.** `edition_hits` ends `ORDER BY … circulation_count ASC LIMIT 200`, which looked
   damning: a relevance-blind pre-filter. **Rejected by measurement** — 297 editions match "buzzer",
   `121:4255` has circulation 28, and only **13** candidates sort ahead of it. It is comfortably inside the
   200. The pre-filter is not the bug (though it remains a latent hazard for a query with >200 matches).
2. **"Set names outrank prose."** Directionally true for `game winner`, but not the mechanism, and it hid
   the real one. The problem is the flat flag, not set names specifically — a *player* name beat it here.

## The separate, second defect: vocabulary

`48:1652` is not ranked low for `game winner` — it is **excluded entirely**. `LIKE ALL` requires every
token, its description says **"game-winning"**, and `'%winner%'` does not match that. So the two famous
Lillard moments fail for **different reasons**: `121:4255` is buried by ranking, `48:1652` by tokenization.
Any fix claiming to solve "narrative search" must address both, and must be verified against BOTH slugs.

## Suggested fix, and the regression it must avoid

Replace the flat flag with a **graded, exclusivity-gated** prose contribution:

- `prose_phrase`: the full query string appears in `description` **and NOT in**
  `player_name || set_name || team_name` → strong boost (~0.55).
- `prose_tokens`: all tokens present in description but not as a phrase → moderate (~0.25).

⚠ **The exclusivity gate is the load-bearing part.** A naive "+0.55 whenever the description matches"
regresses ordinary name search: querying `lillard` would boost every edition whose *prose mentions* Lillard
to ~0.85, level with the Lillard PLAYER hit (~0.85) — so searching a player could stop returning that
player first. Gating on "the phrase is NOT in any name field" keeps the boost to genuinely narrative
queries, which is the only case it is meant to serve.

Stemming (`winner` → `game-winning`) is NOT solved by any of this and needs full-text search
(`tsvector` + `websearch_to_tsquery` + `ts_rank`). `editions` is only ~27k rows, so a STORED generated
column plus a GIN index is cheap — this is a small table, not a big migration.

## Why I did not ship the fix

It is a live ranking change behind BOTH the public header search and the concierge's `search_catalog`, and
the regression it risks (a player search no longer returning that player first) is precisely the kind that
looks fine in a spot check and is caught only by a broad before/after battery. That deserves its own
window with the battery written first, not the tail of a long session. The diagnosis is now exact and the
design is specified; the remaining work is verification breadth, not investigation.


---

# ✅ CORRECTED AGAIN 2026-08-14 — it is NOT a ranking bug. It is TOKEN HANDLING. Both prior diagnoses were wrong.

I built the fix, measured it, and it changed nothing. That falsified the ranking theory outright. The
prototype (`rpc_search_catalog_v2`) has been **dropped**; the live function was never touched.

## The finding that reframes everything: BOTH moments are already findable

| query | target | result |
|---|---|---|
| `lillard buzzer` | `121:4255` | **found, rank 6** ✅ |
| `damian lillard buzzer` | `121:4255` | **found, rank 6** ✅ |
| `lillard game-winning` | `48:1652` | **found, rank 2** ✅ |
| `lillard playoff` | `48:1652` | **found, rank 5** ✅ |
| `lillard buzzer beater` | `121:4255` | **0 rows** ❌ |
| `lillard game winner` | `48:1652` | absent ❌ |

Narrative search **works** when every word the user types happens to appear in the prose. It returns
NOTHING the moment one word does not. `LIKE ALL (v_pats)` is an AND over every token, so "beater" —
a word the description never uses — annihilates an otherwise perfect query.

## Why the ranking theory was wrong, proven not argued

I shipped a graded, exclusivity-gated prose boost (flat `0.12` → `0.55` phrase / `0.25` tokens). Result:
**zero change**. The target scored 0.5706 against a returned band of 0.5765–0.6613 — I had replaced one
flat constant with another, which is the exact failure I had written down one file earlier ("because the
boost is FLAT, every prose hit ties") and then reproduced in my own fix.

Then I measured `ts_rank`, the "proper" answer I had recommended: **0.07599 for nearly every row**. It does
not discriminate either — and that is CORRECT behaviour, not a flaw. ~297 moments mention "buzzer" exactly
once. They are genuinely equivalent. **There is no ranking signal to recover, because a one-word narrative
query has ~297 equally-good answers.** Returning 50 of them is a right answer to a vague question.

## The actual fix: stop requiring every token

Replace the all-or-nothing `LIKE ALL` on the combined text with **token-coverage scoring**:

- Keep the anchor predicate (index-backed) to build the candidate set.
- Do NOT require every token. Count how many tokens match, and rank by that count, so a query with one
  unmatched word degrades gracefully instead of returning nothing.
- Optionally require the anchor plus ≥50% of tokens to avoid noise.

`websearch_to_tsquery('english', …)` gives OR-semantics plus stemming in one step and would also close
`winning`/`winner`, but note the earlier measurement: `ts_rank` will not meaningfully ORDER the survivors,
so use FTS for MATCHING and keep the existing name/kind weights for ordering.

⚠ **Verify against all six rows in the table above**, not just the two failures — four of them currently
work and must keep working.

## What this means for the product right now

The honest user-facing guidance is: **combine a player name with a distinctive word** — `lillard buzzer`,
`lillard playoff`. That works today. Pure narrative phrases (`game winner`) do not, and a stray word kills
the query outright. That is worth saying in the search empty-state and the concierge prompt, and it is a
better description of the current capability than either of my previous two diagnoses.

## Three diagnoses, two of them mine and both wrong

1. "Trigram similarity is length-normalized so long prose loses" — **wrong**, description is not in the
   similarity expression at all.
2. "The flat 0.12 prose boost buries prose hits" — **real but not the cause**; fixing it changed nothing.
3. "`LIKE ALL` requires every token" — **the actual defect**, proven by six probes.

Each was caught only by going back to the primary source: reading the function, then measuring the fix,
then testing what a user would really type. A diagnosis that has not been falsified by an attempted fix is
a hypothesis.

---

## ✅ VALIDATED 2026-08-14 (same session) — prototyped as `rpc_search_catalog_v3`, measured, then dropped

The token-coverage design above is no longer a proposal. It was implemented as a separate function
(execute REVOKEd, live `rpc_search_catalog` untouched), measured side by side against v1, and dropped.

| query | v1 | v3 |
|---|---|---|
| `lillard buzzer` | rank 6 | rank 6 — unchanged |
| `lillard game-winning` | rank 2 | rank 2 — unchanged |
| `lillard playoff` | rank 5 | rank 5 — unchanged |
| `lillard buzzer beater` | **0 rows** | **rank 6** |
| `damian lillard buzzer beater` | absent | **rank 6** |
| `lillard game winner` | absent | **rank 20** |

All three failures fixed; all three working cases returned at **identical** ranks.

### The exact change (two halves, both load-bearing)

    -- 1. replace `LIKE ALL (v_pats)` with a per-token count >= v_need
    v_need := CASE WHEN v_n >= 3 THEN v_n - 1 ELSE v_n END;

    -- 2. add token-coverage to the score so a FULL match still outranks a partial one
    ... + (tok_hit::numeric / v_n) * 0.60

⚠ The `v_n >= 3` guard is not a detail. A 2-token query must still match BOTH tokens — allowing a miss
there degrades `lillard buzzer` into every Lillard moment. And without the coverage term, dropping the AND
buys recall by trading away precision.

⚠ **Testing the four already-working cases is the point, not politeness.** "Just stop ANDing" is a recall
change that silently reorders everything that works today; the only reason this is shippable is that the
known-good ranks came back identical. Repeat that check when porting.

### Why it was dropped rather than shipped

v3 implements the **edition arm only** — the player / set / team arms were stripped to prototype quickly.
Leaving it in the schema would invite someone to swap it in and lose three quarters of search. Port the two
changes into the real four-arm function instead, and re-run **both** batteries: the six narrative probes
above AND entity probes (a player / set / team query must still resolve to its entity row). Note
`rpc_search_catalog` is a concurrent session's function shipped 2026-08-13 — coordinate before editing.
