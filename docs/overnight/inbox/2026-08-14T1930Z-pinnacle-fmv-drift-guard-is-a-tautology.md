# The Pinnacle FMV drift guard compares `pinnacle_catalog` to itself

Filed 2026-08-14 (Claude Code, interactive). **Read-only. Nothing shipped** —
the recommendation is to re-point or retire a smoke guard, which is a decision
with teeth and the file is concurrently owned.

I opened this intending to **resolve `JAVASCRIPT-NEXTJS-14` as superseded** by
the `couldNotRun` fix (`3c9448d2`). It is not superseded. **Do not resolve it** —
resolving would bury a check that has never once been able to do its job.

## The claim

`app/api/smoke-test/route.ts` — check *"Pinnacle FMV not borrowed across
characters (drift guard)"*. **54 occurrences since 2026-05-11**, last 2026-08-13.
It asserts that every priced row the concierge's Pinnacle deal search returns
has a matching `(character, set, variant)` triple in `pinnacle_catalog`.

**It cannot fail for the reason it exists, because both sides are the same
table, the same columns, and the same rows.**

`searchPinnacleDeals` (`lib/concierge/pinnacle-router.ts:115`) reads
`pinnacle_catalog` and maps one row straight through:

```ts
.from("pinnacle_catalog").select("render_id, character_name, set_name, variant, floor_ask, fmv_usd, ...")
...
const fmv = r.fmv_usd != null ? Number(r.fmv_usd) : null
return { player: r.character_name, set: r.set_name, tier: r.variant, fmv, ... }
```

The guard then re-reads `pinnacle_catalog` filtered
`.not("fmv_usd","is",null).in("character_name", <the players just returned>)`
and checks triple membership. So for any deal row the guard actually inspects
(it skips `fmv == null`):

- `fmv != null` in the deal **implies** `fmv_usd != null` on its source row → it
  passes the comparison filter;
- `character_name` is passed through **byte-identical** → the `.in()` matches;
- the triple is therefore **guaranteed present**.

⚠ **This became tautological when `a9f86af` moved the Pinnacle FMV source from
`pinnacle_editions` to `pinnacle_catalog`.** Before that the guard compared two
DIFFERENT tables and was a real cross-source check. The move silently converted
it into a self-comparison; nothing failed, so nothing announced it.

⚠ `opts.source: "live" | "catalog"` does **not** rescue it — it changes only a
label on the output (`source: "pinnacle"` vs `"catalog"`), not the query.

## Hypotheses tested and DISPROVEN

Recorded so nobody re-derives them. Each looked right at some point.

| # | hypothesis | verdict |
|---|---|---|
| 1 | Untrimmed `set_name` breaks the key — **397 of 2,561 catalog rows (15.5%) really are untrimmed**, and the leak strings visibly show `Goofy/ Walt…` vs `Goofy/Walt…` | **NO** — `tripleKey` already lowercases **and trims** both sides |
| 2 | The failed comparison read (the `couldNotRun` fix) | **NO** — that mode empties the set so **every** priced row leaks (2,354). This event named **17** |
| 3 | PostgREST's 1,000-row clamp truncating the comparison fetch | **NO** — max **30** priced renders per character, and the deals query caps at **20 rows**, so ≤600. A belt-and-braces `>= 1000` check also covers it |
| 4 | Exact `.in()` filter vs trimmed comparison (a real asymmetry) | **NO** — the deals rows come from the same column of the same table, so the values are byte-identical |
| 5 | `character_name IS NULL` rows falling out of `.in()` and leaking forever | **NO** — measured **0** null `character_name` rows |

**Verified directly:** the row named in the last event —
`Goofy` / `[ Walt Disney Animation Studios • … Winter Adventures Vol.1]` /
`Silver Sparkle` — **is** in `pinnacle_catalog` with a non-null FMV. The reported
leak is false, consistent with every prior investigation.

## What is still unexplained

⚠ **I could not establish what made it fire on 2026-08-13, and I am not going to
invent a sixth theory.** The leading remaining candidate, flagged as UNPROVEN:

**A write landing between the guard's two reads.** The deals fetch and the
comparison fetch are separate round trips. If the Pinnacle FMV propagation into
`pinnacle_catalog` is delete-then-insert (as the platform's FMV write pattern is
elsewhere — *"FMV write pattern: delete-then-insert NEVER upsert"*), there is a
window in which rows are genuinely ABSENT from the second read. A bulk rewrite
window would take out many rows at once, which fits 17-of-≤20 far better than
any per-row explanation. **To confirm:** check whether the catalog FMV
propagation is an UPDATE or a delete+insert. If it is the latter, that is the
answer and it also means the guard is not merely useless but actively noisy
during every propagation.

## Recommendation

Either is defensible; doing nothing is not.

1. **Re-point it at a comparison that can actually fail** — e.g. assert the
   concierge's rendered FMV matches `pinnacle_fmv_history` for that `render_id`.
   That is a genuine cross-source check and is what the guard's NAME promises.
2. **Retire it.** A check that cannot fail for its stated reason, and does fail
   for other reasons, is worse than absent.

⚠ **The cost of leaving it is documented precedent, not speculation.** This is
the `ufc_fmv_stale_hours` failure exactly: an arm that is permanently red
*"trains the operator to skim past every arm on the board."* 54 false pages over
three months is that, in progress.

⚠ **The `couldNotRun` fix was still correct** and should stay — it removes one
genuine misfire mode. It just does not make the remaining check meaningful, and
the issue should not be read as closed because that shipped.
