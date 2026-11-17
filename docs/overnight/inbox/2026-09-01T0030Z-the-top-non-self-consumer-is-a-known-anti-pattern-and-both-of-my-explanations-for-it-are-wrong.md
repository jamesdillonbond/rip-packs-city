> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# 2026-09-01T0030Z — the top non-self consumer is a known anti-pattern in two UFC edge functions, and both of my explanations for its cost are wrong

**Filed by:** cloud-only autonomous pass, 00:18–00:35Z (17:18–17:35 PT 2026-08-31).
**Repo read at:** `7c63fa326cc2f38c2d6a89d332429cc2415ca599`.
**Status:** OPEN — measurement incomplete, deliberately not shipped.

## The statement

`pg_stat_statements` queryid **`1387451210050502049`**, role `service_role`, via PostgREST:

```sql
SELECT edition_id, fmv_usd, confidence, sales_count_30d, computed_at
FROM public.fmv_snapshots
WHERE edition_id = ANY($1)
ORDER BY computed_at DESC
LIMIT $2 OFFSET $3        -- PostgREST's max-rows cap: LIMIT 1000 OFFSET 0
```

**Diff window 2026-08-31 23:13:17.899Z → 2026-09-01 00:19Z (66 min, baseline age checked before use):
31 calls · 375,660 ms · 5,416,439 buffers = 174,724 buffers/call.** Rank #2 on the diff; #1 is the pass's
own MCP `execute_sql` channel, already filed 22:35Z.

**Lifetime since the 08-12 pgss reset:** 2,852 calls · 126,271,497 buffers · 44,274 buffers/call ·
mean 3,847 ms · **max 29,992 ms (the 30 s statement cap)** · min 3 ms · sd 6,333 ms · 1,261 disk reads/call.
The bimodality (3 ms → 30 s, sd 6.3 s) is the shape of a payload-size-driven cost, not a plan flip.

## Attribution

The only code on `origin/main` @ 7c63fa3 that emits **this exact select list against RAW `fmv_snapshots`**:

- `supabase/functions/enrich-ufc-wallet/index.ts:177` — deployed v46, updated 2026-05-03
- `supabase/functions/scan-ufc-wallet/index.ts:260` — deployed v39, updated 2026-04-12

Both chunk `internalEditionIds` at 200 and then dedupe first-wins in JS. That is the **D27 anti-pattern this
repo has already removed three times** — `app/api/wallet-search/route.ts`:584 and :670 and
`app/api/cache-refresh/route.ts`:516 all carry the *same select list* against `fmv_current` with the comment
"fmv_current = DISTINCT-ON latest-per-edition (1 row/edition), so cold editions … aren't dropped past the
1000-row cap". `app/api/fmv/route.ts` carries the long-form explanation. **The two edge functions were
missed when the class was swept.**

⚠ Attribution is by SQL shape, not by a log line — a caller outside the repo (a script, an artifact) would
be indistinguishable. Confirming it from edge-function logs is step 1 below.

## ⛔ Two hypotheses, both mine, both FALSIFIED — do not re-derive

**(a) "The 1000-row cap is silently truncating UFC FMV coverage." REFUTED.**
Measured over **all 518 UFC editions in the functions' own 200-wide slices**:

| slice | editions with snapshots | matching rows | still visible under LIMIT 1000 |
|---|---:|---:|---:|
| 0 | 200 | 2,068 | **200** |
| 1 | 200 | 1,665 | **200** |
| 2 | 118 | 1,061 | **118** |

Rows exceed the cap, but the cap never costs an edition: UFC depth is ~10 rows/edition (vs Top Shot's 40.7)
and pricing is batched, so the newest 1,000 rows still span the whole slice. **Latent risk, not a live
user-facing defect.** It would begin to bite as UFC snapshot depth grows or if pricing stops being batched.

**(b) "It is open thread #13's param-blind generic plan." REFUTED.**
`EXPLAIN (GENERIC_PLAN)` on the parameterised form (PG 17) returns the **same shape** as the custom plan:

```
Limit -> Sort (computed_at DESC)
  -> Append
     -> Seq Scan fmv_snapshots_2025   (0 rows)
     -> Index Scan using fmv_snapshots_2026_edition_id_timezone_idx
          Index Cond: (edition_id = ANY ($1))
     -> Seq Scan fmv_snapshots_2027   (0 rows)
```

⛔ **Do not ship a plpgsql `RETURN (...)` + `force_custom_plan` wrapper for this one.**

## 🚧 The unresolved gap — and why nothing shipped

A 200-edition UFC slice, custom plan, `EXPLAIN (ANALYZE, BUFFERS)`:
**11,927 hit + 879 read total, of which 1,770 hit + 858 read is the `fmv_snapshots` Append — 2,628 buffers
for 2,068 rows, 578 ms.**

That is **~66× below the 174,724 buffers/call production pays, on the same plan.** So the difference is the
**payload**, and this session had no way to capture a real one.

Shipping the obvious conversion now would (i) size a fix against a cost model that does not reproduce, and
(ii) put prod ahead of the repo on TS this session cannot commit — there is **no
`recover-fileless-migrations.mjs` equivalent for edge functions**, and the next
`supabase functions deploy` from a clean tree would silently revert it.

## Next steps, in order

1. **Capture a real payload.** Supabase edge-function logs for `enrich-ufc-wallet` / `scan-ufc-wallet`, or
   log `internalEditionIds.length`. **State the size alongside the number.**
2. Re-measure buffers at that size. If it reproduces, the mechanism is payload volume; if it does not, the
   caller is not these two functions and the attribution above is wrong — say so.
3. Only then: `.from("fmv_snapshots")…​.order("computed_at",{ascending:false})` →
   `.from("fmv_current")` with the `.order` dropped, in both files, matching the three sibling sites
   verbatim. The JS first-wins dedupe stays and becomes a harmless no-op, exactly as `app/api/fmv/route.ts`
   documents.
4. **A/B on total buffers touched**, both sides re-measured in the same state.
5. **Exit condition from the post-fix measurement you take**, not a hoped-for order of magnitude.
6. Ship **from the desktop** as a repo commit + `supabase functions deploy`, never as a cloud MCP deploy.

**Revert if shipped:** re-point both `.from()` calls back to `"fmv_snapshots"` and restore the `.order`;
no schema, no data, no ACL change.
