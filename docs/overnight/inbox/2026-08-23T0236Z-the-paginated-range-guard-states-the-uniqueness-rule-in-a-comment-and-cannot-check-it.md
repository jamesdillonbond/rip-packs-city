# The `.range()` guard states the uniqueness rule in its own header and asserts something weaker — a repo-wide measurement of what it cannot see

**Filed 2026-08-22 (PT) by Claude Code, interactive.** Extends
[the sitemap filing](2026-08-23T0228Z-the-sitemap-truncates-on-a-statement-timeout-and-pages-on-a-key-that-is-72pct-ties.md),
which is one concrete instance of what is measured here.

## The gap, in the guard's own words

`__tests__/paginated-range-requires-order-ratchet.test.ts` carries this in its header:

> ⚠ **Choose the order column from a UNIQUE key, not merely a selected one.** A non-unique order
> leaves ties between pages and reintroduces the defect

and then asserts, in code:

```js
if (!src.slice(fromIdx, m.index).includes(".order(")) hits.push(...)
```

**Presence of `.order(`. Not uniqueness of its key.** ⚠ This is the exact shape CLAUDE.md names as
the worst kind of vacuous assertion — *"a test stating the contract in a comment and asserting
something weaker"* — and the one mutation testing cannot find, because the weaker assertion is
genuinely load-bearing for the weaker property. The guard is not broken. It is doing what it says
in code and not what it says in prose, and the prose is what a reader takes away.

## Measured landscape (2026-08-22, PT)

Method: reuse the guard's own two-stage `blankNonCode` for **positions** (so a retry label
containing the text `.range(` is not counted — the guard's own documented false positive), then read
`.order('col')` / `.eq('col')` **names** from a comments-only strip at the same offsets, then test
each site against the unique indexes **read from the live database**, counting a site deterministic
when some unique index has every column either equality-filtered or in the order list.

| bucket | count |
|---|---|
| `.range()` sites in `app`/`lib`/`supabase/functions`/`workers` | **46** |
| provably deterministic (order ∪ equality-filter covers a unique index) | **28** |
| **not proven by that test** | **9** → **7 after the correction below** |
| on a VIEW or a dynamic table/column, where uniqueness is undefined | **9** → **11** |

**The 9 not proven** — ⚠ **this is an UPPER BOUND on the defect, not a bug list. Open each one:**

```
badge_editions        (dynamic sort col)        app/api/badges/route.ts:54
sales                 id                        app/api/fmv-recalc/route.ts:414
sales                 id                        app/api/fmv-recalc/route.ts:817
cached_listings       ask_price+fmv+listed_at   app/api/market/route.ts:730
topshot_market_index_daily  d+tier              app/api/public/insights/market/route.ts:87
topshot_market_index_daily  d+tier              app/insights/market/page.tsx:48
wallet_moments_cache  serial_number             app/api/support-chat/route.ts:3356
wallet_moments_cache  created_at                app/api/tier-backfill/route.ts:102
wallet_moments_cache  last_seen_at+moment_id    app/api/wallet-cache/route.ts:64
```

**Worked example of why this is an upper bound:** `wallet-cache/route.ts:64` filters
`.eq("wallet_address", wallet)` and orders `last_seen_at, moment_id`. The unique index is
`(wallet_address, collection_id, moment_id)`, so `collection_id` is formally unpinned — but two
collections sharing a `moment_id` inside one wallet is not a real state. **Deterministic in
practice, unproven on paper.** A guard built on this test must therefore have an escape hatch, or
it will train people to silence it.

🚨 **CORRECTED 20 MINUTES AFTER FILING — I had promoted two of these to "open first" and BOTH
claims were overstated in the same direction.** Recorded rather than silently edited, because the
direction is the lesson: a conservative classifier's output reads like a defect list, and I wrote
consequence language around two rows before checking what they actually are.

- **`sales` × 2 in `fmv-recalc` — downgraded.** `sales_pkey` is `(id, sold_at)` because the table
  is PARTITIONED (`relkind = 'p'`) and a partitioned table must carry its partition key in the PK.
  That does NOT mean `id` repeats: `sales.id` defaults to **`uuid_generate_v4()`**, so ordering by
  `id` alone is deterministic **in practice**. It belongs in the same "unproven on paper, fine in
  practice" bucket as `wallet-cache`, not ahead of it. ⚠ What would actually settle it is a
  `count(*)` vs `count(distinct id)`, which is a full scan of the largest table here and was NOT
  run; the residual risk is an explicit-id insert from a backfill, not the uuid default.
- **`topshot_market_index_daily` × 2 — misfiled.** It is a **VIEW** (`relkind = 'v'`), not a table.
  "Carries no unique index" is true of every view and says nothing. Both rows belong in the
  views/dynamic bucket, which makes the honest split **7 not proven + 11 undefined**, not 9 + 9.

⚠ **So the not-proven bucket has NO member yet shown to be a real defect** — the one measured
defect in this class remains `lib/sitemap-data.ts`, in the OTHER bucket, in the sibling filing.

## Recommended guard design (NOT built here)

1. Keep the presence check as-is (it is a ban at zero and it works).
2. Add a uniqueness arm whose rule is the real property: **some unique index of the table has every
   column either equality-filtered or present in the order list.**
3. Escape hatch in the marker style this repo already uses successfully for anon-exec:
   `// paginate-key: <col> is unique here because <why>` — line-level, naming the column.
4. ⚠ **The unique-index map must come from the DATABASE, not a hand-list in the test.** A curated
   list drifts, and CLAUDE.md says so. The natural home is the live-DB pin check
   (`npm run db:pins:check` / `db-pin-staleness.yml`), not the offline unit job — which is why this
   is filed rather than shipped in the same turn as the measurement.
5. Views and dynamic column names cannot be analysed statically. They need the marker, or exclusion
   with a stated reason — ⚠ and **`lib/sitemap-data.ts:186`, the one site measured to actually
   truncate in production, is in exactly that bucket**, so an exclusion written carelessly would
   exclude the known defect.

---

## ✅ RESOLVED 2026-08-26 (Claude Code, interactive) — the FALSE IMPRESSION is fixed; the uniqueness ARM is a decided NON-BUILD, with reasons

This filing has two halves and they deserve opposite answers.

### ✅ Half one — the vacuous-coverage complaint — is fixed, at zero churn

The indictment is exact: the header states *"Choose the order column from a UNIQUE key"* three lines
above an assertion that tests `.includes(".order(")`. **The rule is right; the impression that CI
enforced it was not.** The guard's header now says so in as many words, so a reader takes the
paragraph as guidance rather than as coverage. **That is the whole defect this filing names, and it
cost one comment block.**

### ⓘ Re-derived population (2026-08-26, dated sample)

**41** supabase `.range()` sites across the five roots · **41** carry at least one `.order()` — the
ban at zero is holding and is honest about what it sees · **7** carry a second `.order()` as a
tiebreak.

### ⛔ Half two — the uniqueness arm — is deliberately NOT built, on three measurements

⚠ **The decisive one is that the proposed guard would be blind to the only member of this class ever
measured to cause harm.** `lib/sitemap-data.ts` truncated a live sitemap — **24,000 of 27,246
editions under an HTTP 200** — and it pages a **VIEW**, where uniqueness is undefined and no static
index map applies. This filing already says as much (*"§5 … `lib/sitemap-data.ts:186`, the one site
measured to actually truncate in production, is in exactly that bucket"*). ⭐ **A guard whose blast
radius excludes the only known instance of its own class is coverage of the bucket that was already
fine.**

✅ **And that site is now FIXED — by hand, with an explicit tiebreak column** — and its own comments
record working around this very limitation: the ratchet *"can see that a SECOND `.order()` is present
but not what was passed to it — mutation proved [it]"*. It also now throws `SitemapReadIncomplete`
rather than `break`ing, closing the partial-list half.

The other two, from this filing's own text: **the not-proven bucket still has no member shown to be a
real defect** (its `wallet-cache` worked example is unprovable on paper and deterministic in
practice), and **a guard that over-reports where the repo has already done the work trains people to
silence it** — which this filing warns about directly.

➡ **If it is ever built**, the escape hatch must ship with it and the index map must be a DB-derived
pin with a drift check, never a curated list in the test — that curation is the failure mode behind
this guard's two 2026-08-23 widenings. **Recorded in the guard itself so the next reader inherits the
decision, not the gap.**
