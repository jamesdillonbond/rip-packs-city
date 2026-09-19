# RPC — candidate filing: the confidence precompute's collection list is HARDCODED and has drifted from reality — Candy is invisible, Pinnacle publishes a permanent `{}`

**Run:** 2026-09-19 4:46 PM PT (23:46Z) · Claude Code, Windows box · **READ-ONLY, nothing shipped.**
**Same function as `2026-09-19T2324Z`, different defect.** That one is about COST; this one is about COVERAGE and it is an honesty defect. ⚠ **They interact — see §5 for the sequencing, which matters.**

## 1 — The mechanism: a `VALUES` list of five UUIDs, written once, never re-derived

`refresh_fmv_confidence_precompute()` loops a literal list hardcoded in its body:

```
('nba_top_shot', …), ('nfl_all_day', …), ('laliga_golazos', …), ('ufc_strike', …), ('disney_pinnacle', …)
```

**Measured against what `fmv_snapshots` actually contains today** (`GROUP BY collection_id`, the whole table):

| collection_id | slug | snapshots | in the loop? |
|---|---|---|---|
| `95f28a17…` | nba_top_shot | 1,095,063 | ✅ |
| `dee28451…` | nfl_all_day | 467,538 | ✅ |
| `06248cc4…` | laliga_golazos | 13,985 | ✅ |
| **`209ade70…`** | **candy_mlb** | **6,994** | ⛔ **NO — absent entirely** |
| `9b4824a8…` | ufc_strike | 6,080 | ✅ |
| — | **disney_pinnacle** | **0** | ⚠ yes, and it has **zero rows here by construction** |

⇒ **the list is wrong in both directions at once.** One collection with data is not measured; one collection with no data in this table is measured anyway and its emptiness is published as a fact.

## 2 — ⛔ CANDY IS INVISIBLE, AND IT IS THE BEST-COVERED COLLECTION IN THE ESTATE

Candy has **6,994 snapshots over 125 distinct editions**, and the distribution the precompute never computes is:

| confidence | n |
|---|---|
| MEDIUM | 69 |
| LOW | 47 |
| HIGH | 9 |

**HIGH+MEDIUM = 78 of 125 = 62.4%** — **higher than Top Shot's 52.5%**. ⭐ **The collection with the estate's best confidence coverage is the one the instrument cannot see**, and it shipped a Collection tab today.

📏 **It costs essentially nothing to include: 649 buffers, 32 ms** (`EXPLAIN ANALYZE, BUFFERS`) — against Top Shot's 63,753 buffers. **This is ~0.05% of the function's work.**

## 3 — 🚨 PINNACLE PUBLISHES `{}`, AND IT HAS NEVER MEANT ANYTHING ELSE

`fmv_confidence_precompute` currently holds, for `disney_pinnacle`: **`counts: {}`, `duration_ms: 5`**. That reads as *"Pinnacle has no FMV confidence data."* **It is false.**

⛔ **Pinnacle is not priced in `fmv_snapshots` at all** — it has **0 snapshots AND 0 rows in `editions`** under its collection_id. Its FMV lives in its own table, **`pinnacle_fmv_history` (`render_id`, `fmv_confidence`, `computed_at`, 35 MB)**, because Pinnacle is keyed on `render_id`, not `edition_id`. Latest per render:

| confidence | n |
|---|---|
| ASK_ONLY | 1,027 |
| LOW | 633 |
| MEDIUM | 549 |
| STALE | 175 |
| HIGH | 166 |

**2,550 priced renders; HIGH+MEDIUM = 715 = 28.0%.**

⭐ **POSITIVE CONTROL, and it is what makes this a finding rather than a guess:** those two figures reproduce `metrics-latest.json` — **Pinnacle 28.0% here vs `27.5` recorded by the nightly pass; Candy 62.4% vs `60.8`** — computed by a different instrument on a different day. **The nightly pass has been reading the right sources all along. Only this precompute is looking in the wrong place.**

⚠ **The `{}` is structural and permanent, not a transient miss.** The query is `WHERE collection_id = <pinnacle>` against a table with zero such rows, so this arm has returned empty on **every run it has ever made** and always will. Its 5 ms duration is the tell: it is not computing anything.

⚠ **`coalesce(jsonb_object_agg(…), '{}'::jsonb)` is what makes it silent** — it converts *"this query matched nothing"* into a published, well-formed, confident-looking empty object. The per-arm `EXCEPTION WHEN OTHERS` block catches genuine *errors* into `failed`, so a reader reasonably concludes that an arm which is not in `failed` **succeeded and found nothing.** ⇒ this is CLAUDE.md's **"an `unknown` that is actually KNOWN"** mirror, and its **"an empty state that CONCLUDES"**.

## 4 — Who reads it, stated up front this time

⚠ **Per the retraction in `2026-09-19T2324Z` §5, naming the reader is part of the finding, not an afterthought.** The only consumer of `fmv_confidence_precompute` is **`rpc_ops_snapshot()`** — no user-facing surface. So the blast radius is the **ops/health instrument**: an operator reading it sees nothing for Pinnacle and no row at all for Candy. **Not a user-facing pricing defect.** ⭐ But it is the instrument used to judge whether FMV coverage is healthy, so a blind spot in it is a blind spot in the judgement — and the roadmap's gate is exactly this metric.

## 5 — ⚠ SEQUENCING: DO NOT SHIP THIS FIRST. The two filings interact.

⛔ **Adding the Candy arm to this function TODAY makes `2026-09-19T2324Z` worse.** That function already dies at the 120 s ceiling on roughly half its runs, with Top Shot alone at 100.8 s. Candy's +32 ms is negligible in isolation, but **shipping coverage into a budget that is already failing is the wrong order** — it would land a change whose effect is masked by an unrelated failure, and the first thing anyone measured afterwards would be confounded.

👉 **Order: fix the budget (2324Z), confirm the function completes reliably, THEN fix the list.**

## 6 — Suggested fix (SUPERVISED), and it is the house pattern

⭐ **Derive the loop instead of curating it** — CLAUDE.md's standing rule: *prefer a tree walk over a curated list, and a ban at zero over an allowlist.* Concretely:
- Build the collection list **from the data** (`SELECT DISTINCT collection_id FROM fmv_snapshots`, joined to `collections` for the slug). Candy then appears automatically, and **any future collection does too** — which is the property whose absence created this.
- ⛔ **But do NOT let that silently DROP Pinnacle**, or a false `{}` is replaced by an equally misleading absence. Give Pinnacle its **own arm reading `pinnacle_fmv_history`** (latest per `render_id`), which is where its numbers demonstrably are.
- ⚠ **Replace the `coalesce(…, '{}')`** so a genuinely-empty read is distinguishable from an unmeasured one — a typed marker (`{"_unmeasured": true}` or a NULL `counts` with a reason) rather than a well-formed empty object.
- 📏 **Falsifier for the whole change:** after it ships, `fmv_confidence_precompute` should hold **six** rows, Candy's HIGH+MEDIUM should read ~62% and Pinnacle's ~28%, and **both should track `metrics-latest.json` within a couple of points** — the independent control that already works today.

**Not-candidates:** the other three arms (`nfl_all_day`, `laliga_golazos`, `ufc_strike`) are correctly listed and correctly sourced — verified against the same `GROUP BY`, no action.
