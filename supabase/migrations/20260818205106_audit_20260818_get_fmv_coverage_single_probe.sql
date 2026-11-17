-- get_fmv_coverage(): collapse the duplicated correlated EXISTS into ONE lateral probe.
--
-- The body wrote the identical `exists (select 1 from fmv_snapshots f where
-- f.edition_id = e.id)` TWICE -- once for fmv_editions, once again inside the
-- round(...) percentage -- and the planner does not collapse them. Measured
-- 2026-08-18 in a QUIET window (3 active sessions, 1 in IO wait, zero autovacuum
-- workers), warm-vs-warm, EXPLAIN (ANALYZE, BUFFERS), both sides on the same
-- instrument:
--
--     live (SubPlan 1 + SubPlan 2) ... 196,106 buffers ... 1,470 / 1,609 ms
--     this shape (one lateral) ....... 100,014 buffers ... 909 ms
--
-- Equivalent by construction AND by test: the lateral yields exactly 0 or 1 row
-- per edition, so count(fs.one) counts editions having at least one snapshot --
-- the same set EXISTS selects. Verified value-identical across all four active
-- collections on a discriminating case (nba_top_shot 19,658/19,820 = 99.2%, not
-- a degenerate all-100% set).
--
-- WHAT THIS IS *NOT*. The 2026-08-18 incident -- /api/cron/data-integrity dying
-- at its 30s maxDuration and taking the clean, instant security-invariant result
-- dark with it -- was attributed to this plan shape. That attribution is WRONG:
-- in a quiet window the OLD shape runs in 1.5s. The 55s reading was the disk-IO
-- saturation spell, not the double subplan. The caller bound (rpcWithRetry with
-- an explicit timeoutMs, shipped in c50ef186/f07de6ac) is what actually stops the
-- monitor going dark, and it remains the load-bearing fix. This is a genuine ~2x
-- waste reduction on a disk-IO-budget-constrained instance, and nothing more --
-- do not record it as the incident's resolution.
--
-- ALSO NOT THE WHOLE STORY: `Heap Fetches: 14782` on the index-only scan says the
-- visibility map on fmv_snapshots_2026 is stale. That inflates buffers on BOTH
-- shapes, and a VACUUM on that partition would cut both further. Left to
-- autovacuum deliberately -- a manual VACUUM on the hottest partition is an
-- operator decision, not a migration's.
--
-- Signature is UNCHANGED (no args, identical TABLE return), so this creates no
-- new overload and cannot silently re-grant PUBLIC EXECUTE. The revoke/grant
-- below is re-asserted belt-and-braces and verified with has_function_privilege
-- (never the acl text) in a separate step.
create or replace function public.get_fmv_coverage()
returns table(slug text, editions bigint, fmv_editions bigint, coverage_pct numeric)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.slug,
    count(*)::bigint                as editions,
    count(fs.one)::bigint           as fmv_editions,
    round(count(fs.one)::numeric / nullif(count(*), 0) * 100, 1) as coverage_pct
  from public.editions e
  join public.collections c on c.id = e.collection_id
  left join lateral (
    select 1 as one
    from public.fmv_snapshots f
    where f.edition_id = e.id
    limit 1
  ) fs on true
  where c.is_active = true
  group by c.slug;
$$;

revoke execute on function public.get_fmv_coverage() from public, anon, authenticated;
grant execute on function public.get_fmv_coverage() to postgres, service_role;

comment on function public.get_fmv_coverage() is
  'FMV coverage % per active collection. One lateral probe per edition (2026-08-18): '
  'the previous body wrote the same correlated EXISTS twice and the planner did not '
  'collapse it -- 196,106 -> 100,014 buffers, measured warm-vs-warm in a quiet window. '
  'Sole production caller: app/api/cron/data-integrity/route.ts.';
