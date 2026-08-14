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
