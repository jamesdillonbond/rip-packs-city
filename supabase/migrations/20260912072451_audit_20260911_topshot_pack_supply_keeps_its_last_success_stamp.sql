-- topshot_pack_supply.last_success_at — the stamp that survives a failure, and
-- the precondition for ever repairing the lane.
--
-- WHY, IN ORDER. Earlier tonight `pack_table_rows.supply_as_of` was added to date
-- every depletion figure on the pack page, guarded on `supply_ok` because
-- apply_topshot_supply's FAILURE branch bumps `updated_at` while leaving the
-- stale counters in place. That guard is correct but LOSSY: a dist that succeeded
-- once and has failed since reports NULL, because its last-success timestamp was
-- overwritten by the failure. The migration that shipped it said so and deferred
-- the fix. This is the fix, and reading the lane's candidate query is what made
-- it urgent rather than tidy.
--
-- 🚨 THE LANE IS NOT DEAD. IT IS A ONE-SHOT HYDRATOR, AND THAT CHANGES THE
-- DIAGNOSIS IN #74. `get_topshot_supply_backfill_targets` selects:
--     AND NOT EXISTS (SELECT 1 FROM topshot_pack_supply s
--                      WHERE s.dist_id = d.dist_id AND s.supply_ok = true)
-- i.e. ONLY dists that have never had a successful fetch. Once a dist succeeds it
-- is never revisited: there is no staleness window and no re-walk path. So the
-- 2,083 hydrated rows are frozen BY THE PREDICATE, not by the upstream outage —
-- ⛔ and fixing the Top Shot GraphQL 530 (#81) would NOT unfreeze them. #74 reads
-- the freeze as a dead lane; it is a lane working exactly as written, out of
-- candidates. The only rows it still attempts are the 2 that have never
-- succeeded (8125, 8327), and those are the two carrying supply_err='HTTP 530'.
--
-- ⭐ THIS IS THE SAME DEFECT AS THE ALL DAY ONE, IN A SECOND COLLECTION, AND THE
-- TWO WERE FILED ELEVEN DAYS APART WITHOUT BEING CONNECTED. Migration
-- 20260901071258 describes `backfill-allday-dist-opened` in almost these words:
-- "Its candidate query is allday_pack_supply.select('dist_id').is('opened_count',
-- null) -- i.e. it selects on the very column it then fills. It is a ONE-SHOT
-- HYDRATOR, not a refresher". Both lanes hydrate once and stop; both leave a
-- public depletion number frozen; both have the same one-line fix (a staleness
-- window instead of a never-succeeded predicate). The transferable shape: ⚠ A
-- CANDIDATE PREDICATE THAT SELECTS ON THE COLUMN IT FILLS IS A ONE-SHOT, AND IT
-- IS INDISTINGUISHABLE FROM A HEALTHY DRAIN ONCE IT FINISHES — every tick after
-- that returns "no candidates" and reports success.
--
-- ⛔ AND THE PREDICATE FIX IS DELIBERATELY *NOT* IN THIS MIGRATION, because
-- shipping it today would make the page WORSE, which is worth stating plainly:
-- with the upstream 530ing, a re-walk would flip all 2,083 rows to
-- supply_ok=false. The failure branch does not clear the counters, so
-- pack_distributions would keep serving the same stale numbers while
-- supply_as_of went NULL — the page would lose the age it just gained and show
-- the identical figure with nothing beside it. `last_success_at` is what removes
-- that trap: it survives the failure, so a re-walk that 530s degrades to "as of
-- 76d ago" instead of to silence. ⭐ SO THE ORDER MATTERS AND IS THE POINT OF
-- THIS FILE: this column first, the predicate second, and the predicate only
-- once #81's 530 clears.
--
-- WHAT CHANGES
--   1. A nullable `last_success_at` column. Nullable on purpose — NULL means
--      "never successfully fetched", which is true of the 2 rows that have only
--      ever 530'd, and is not the same statement as "fetched and found nothing".
--   2. A backfill from `updated_at` WHERE supply_ok, which is exactly correct:
--      on a supply_ok row `updated_at` IS the success time. The 2 failed rows are
--      left NULL rather than given a fabricated stamp — they have never succeeded,
--      so there is no last success to record.
--   3. apply_topshot_supply writes it in the SUCCESS branch only. The failure
--      branch is untouched, which is the entire behavioural claim of this file
--      and is now pinned by supabase/tests/apply_topshot_supply.sql.
--   4. pack_table_rows.supply_as_of / depletion_as_of read `last_success_at`
--      instead of the supply_ok-guarded `updated_at`. Same answer today (every
--      supply_ok row's last_success_at equals its updated_at after the backfill),
--      strictly more informative after any future failure.
--
-- ⚠ WHY updated_at IS NOT SIMPLY REDEFINED. It is the lane's liveness signal —
-- "did this job attempt anything" — and several operator queries read it that
-- way, including the one that produced tonight's tell (max(updated_at) 09-11 vs
-- max(updated_at) where supply_ok 08-26). Collapsing the two would delete the
-- discriminator. Two columns, two questions: WHEN DID WE LAST TRY, and WHEN DID
-- WE LAST KNOW.
--
-- REVERT (both halves, either order):
--   re-apply the previous apply_topshot_supply body verbatim from
--     supabase/migrations/20260802191000_audit_20260802_snapshot_apply_topshot_supply.sql
--     (deliberately NOT spelled out here: a bare CREATE-OR-REPLACE line inside a
--      comment is a landmine for every extractor that greps for the real one)
--   -- then repoint the view's two as-of legs back to
--   --   CASE WHEN tss.supply_ok THEN tss.updated_at END
--   -- (definition in 20260912070226_audit_20260911_pack_table_rows_publishes_...)
--   ALTER TABLE public.topshot_pack_supply DROP COLUMN last_success_at;
-- anon-exec: apply_topshot_supply is SECURITY DEFINER and its grants are
-- UNCHANGED by this file (CREATE OR REPLACE preserves them); it was already
-- service_role-only. Verified with has_function_privilege after apply.

ALTER TABLE public.topshot_pack_supply
  ADD COLUMN IF NOT EXISTS last_success_at timestamptz;

COMMENT ON COLUMN public.topshot_pack_supply.last_success_at IS
  'When this dist was last SUCCESSFULLY fetched. Written only by apply_topshot_supply''s success branch, so unlike updated_at it SURVIVES a failed fetch — updated_at answers "when did we last try", this answers "when did we last know". NULL means never successfully fetched, which is not the same as "fetched and found nothing". pack_table_rows.supply_as_of reads this.';

-- Exactly correct rather than approximate: on a supply_ok row, updated_at IS the
-- success time (the success branch is the only writer that sets supply_ok=true,
-- and it sets updated_at=now() in the same statement). Failed rows stay NULL.
UPDATE public.topshot_pack_supply
   SET last_success_at = updated_at
 WHERE supply_ok IS TRUE
   AND last_success_at IS NULL;

CREATE OR REPLACE FUNCTION public.apply_topshot_supply(p_dist_id text, p_ok boolean, p_minted integer DEFAULT NULL::integer, p_unopened integer DEFAULT NULL::integer, p_for_sale boolean DEFAULT NULL::boolean, p_is_sold_out boolean DEFAULT NULL::boolean, p_remaining jsonb DEFAULT NULL::jsonb, p_original jsonb DEFAULT NULL::jsonb, p_err text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_ok THEN
    INSERT INTO public.topshot_pack_supply
      (dist_id, total_minted, total_opened, total_sealed, depletion_pct, for_sale, is_sold_out, remaining_by_tier, original_by_tier, supply_ok, supply_err, updated_at, last_success_at)
    VALUES (p_dist_id, COALESCE(p_minted,0),
            GREATEST(COALESCE(p_minted,0)-COALESCE(p_unopened,0),0), COALESCE(p_unopened,0),
            (CASE WHEN COALESCE(p_minted,0)>0 THEN round(100.0*(p_minted-COALESCE(p_unopened,0))/p_minted) ELSE 0 END)::smallint,
            p_for_sale, p_is_sold_out, p_remaining, p_original, true, NULL, now(), now())
    ON CONFLICT (dist_id) DO UPDATE SET
      total_minted=EXCLUDED.total_minted, total_opened=EXCLUDED.total_opened, total_sealed=EXCLUDED.total_sealed,
      depletion_pct=EXCLUDED.depletion_pct, for_sale=EXCLUDED.for_sale, is_sold_out=EXCLUDED.is_sold_out,
      remaining_by_tier=EXCLUDED.remaining_by_tier, original_by_tier=EXCLUDED.original_by_tier,
      supply_ok=true, supply_err=NULL, updated_at=now(), last_success_at=now();
    -- write-through to the seeder-owned counters (preserved on re-seed; total_sealed+depletion_pct are GENERATED)
    UPDATE public.pack_distributions
      SET total_minted = COALESCE(p_minted,0),
          total_opened = GREATEST(COALESCE(p_minted,0)-COALESCE(p_unopened,0),0)
      WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND dist_id = p_dist_id;
  ELSE
    -- last_success_at is DELIBERATELY ABSENT from both halves of this branch. It
    -- is the whole point of the column: a failed fetch must not disturb the
    -- record of when we last knew. updated_at still moves, so liveness is intact.
    INSERT INTO public.topshot_pack_supply (dist_id, supply_ok, supply_err, updated_at)
    VALUES (p_dist_id, false, COALESCE(p_err,'unknown'), now())
    ON CONFLICT (dist_id) DO UPDATE SET supply_ok=false, supply_err=COALESCE(p_err,'unknown'), updated_at=now();
  END IF;
END;
$function$;

-- The view's two as-of legs now read last_success_at. Same answer today (every
-- supply_ok row's last_success_at equals its updated_at after the backfill above),
-- strictly more informative after any future failure. Full definition restated
-- because CREATE OR REPLACE VIEW admits nothing less.
-- SECURITY MODE — definer-view: intentional (allowlisted; no WITH clause, so the
-- existing definer state is preserved, exactly as in the migration hours earlier).
CREATE OR REPLACE VIEW public.pack_table_rows AS
 SELECT pd.dist_id,
    pd.collection_id,
    c.name AS collection_name,
        CASE
            WHEN c.name::text = 'NBA Top Shot'::text THEN 'nba-top-shot'::text
            WHEN c.name::text = 'NFL All Day'::text THEN 'nfl-all-day'::text
            WHEN c.name::text = 'LaLiga Golazos'::text THEN 'laliga-golazos'::text
            WHEN c.name::text = 'UFC Strike'::text THEN 'ufc-strike'::text
            ELSE lower(replace(c.name::text, ' '::text, '-'::text))
        END AS collection_slug,
    COALESCE(pd.title, pd.metadata ->> 'name'::text) AS title,
    COALESCE(pd.metadata ->> 'thumbnail'::text, pd.image_url) AS image_url,
    pd.nft_type,
    lower(pd.metadata ->> 'tier'::text) AS tier,
    pd.metadata ->> 'pack_type'::text AS pack_type,
    pd.metadata ->> 'description'::text AS description,
        CASE
            WHEN (pd.metadata ->> 'retail_price_usd'::text) IS NULL THEN NULL::numeric
            WHEN ((pd.metadata ->> 'retail_price_usd'::text)::numeric) >= 1000000::numeric THEN round(((pd.metadata ->> 'retail_price_usd'::text)::numeric) / 100000000::numeric, 2)
            ELSE round((pd.metadata ->> 'retail_price_usd'::text)::numeric, 2)
        END AS retail_price_usd,
    (pd.metadata ->> 'number_of_pack_slots'::text)::integer AS slots,
    pd.total_minted,
    pd.total_opened,
    pd.total_sealed,
    COALESCE(NULLIF(pd.depletion_pct, 0::smallint),
        CASE
            WHEN sent.is_sentinel THEN NULL::smallint
            ELSE round(pev.depletion_pct::double precision)::smallint
        END) AS depletion_pct,
        CASE
            WHEN sent.is_sentinel THEN NULL::numeric
            ELSE pev.pack_ev
        END::numeric(10,2) AS pack_ev,
        CASE
            WHEN sent.is_sentinel THEN NULL::numeric
            ELSE pev.gross_ev
        END::numeric(10,2) AS gross_ev,
    pev.pack_price AS ev_pack_price,
        CASE
            WHEN sent.is_sentinel THEN NULL::numeric
            ELSE pev.value_ratio
        END::numeric(12,4) AS value_ratio,
        CASE
            WHEN sent.is_sentinel THEN NULL::boolean
            ELSE pev.is_positive_ev
        END AS is_positive_ev,
        CASE
            WHEN sent.is_sentinel THEN NULL::smallint
            ELSE pev.fmv_coverage_pct
        END AS fmv_coverage_pct,
    pev.edition_count,
    pev.total_unopened,
        CASE
            WHEN sent.is_sentinel THEN NULL::smallint
            ELSE pev.depletion_pct
        END AS ev_depletion_pct,
    pev.snapshotted_at AS ev_snapshotted_at,
        CASE
            WHEN sent.is_sentinel THEN NULL::numeric
            WHEN pev.pack_ev IS NOT NULL AND pev.pack_price > 0::numeric THEN round(pev.pack_ev / pev.pack_price * 100::numeric, 1)
            ELSE NULL::numeric
        END AS ev_margin_pct,
    pd.first_seen_at,
    pd.updated_at,
        CASE
            WHEN pev.edition_count = 1 AND pev.pack_ev > 500::numeric THEN true
            ELSE false
        END AS is_rare_single_pack,
    pev.primary_price,
    COALESCE(pas.live_ask, pev.secondary_ask) AS secondary_ask,
    pev.price_source,
    pev.primary_available,
        CASE
            WHEN pas.live_ask IS NOT NULL THEN true
            ELSE pev.secondary_available
        END AS secondary_available,
        CASE
            WHEN sent.is_sentinel THEN NULL::numeric
            ELSE pev.typical_ev
        END::numeric(10,2) AS typical_ev,
    -- ── NEW 2026-09-11, REPOINTED the same night ─────────────────────────────
    -- As-of of total_minted / total_opened / total_sealed. This read
    -- `CASE WHEN tss.supply_ok THEN tss.updated_at END` for the first hours of its
    -- life — correct, because the lane bumps updated_at on a FAILED fetch too, but
    -- LOSSY: a dist that succeeded once and has failed since reported NULL.
    -- last_success_at is written only by the success branch, so it answers the
    -- same question without losing the answer.
        CASE
            WHEN pd.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
              THEN tss.last_success_at
            WHEN pd.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
              THEN ads.opened_updated_at
            ELSE NULL::timestamptz
        END AS supply_as_of,
    -- As-of of depletion_pct SPECIFICALLY, branch-matched to the COALESCE that
    -- produces it twenty lines above. Restating the predicate (rather than
    -- guessing a single source) is what keeps the age attached to the number that
    -- was actually rendered.
        CASE
            WHEN NULLIF(pd.depletion_pct, 0::smallint) IS NOT NULL
              THEN CASE
                     WHEN pd.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
                       THEN tss.last_success_at
                     WHEN pd.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
                       THEN ads.opened_updated_at
                     ELSE NULL::timestamptz
                   END
            WHEN NOT sent.is_sentinel AND pev.depletion_pct IS NOT NULL
              THEN pev.snapshotted_at
            ELSE NULL::timestamptz
        END AS depletion_as_of
   FROM pack_distributions pd
     JOIN collections c ON c.id = pd.collection_id
     LEFT JOIN mv_pack_ev_latest pev ON pev.dist_id = pd.dist_id AND pev.collection_id = pd.collection_id AND NOT (pd.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND (EXISTS ( SELECT 1
           FROM pack_ask_state a
          WHERE a.collection_slug = 'nba-top-shot'::text AND a.dist_id = pev.dist_id AND a.is_listed IS TRUE AND a.lowest_ask > 0::numeric AND pev.gross_ev > (3::numeric * a.lowest_ask)))) AND (EXISTS ( SELECT 1
           FROM pack_drop_pool dp
          WHERE dp.collection_id = pd.collection_id AND dp.dist_id = pd.dist_id)) AND (pev.pack_price IS NULL OR pev.pack_price < 9999::numeric) AND (pev.fmv_coverage_pct IS NULL OR pev.fmv_coverage_pct >= 25)
     LEFT JOIN LATERAL ( SELECT
                CASE
                    WHEN pas0.is_listed IS TRUE AND pas0.lowest_ask > 0::numeric THEN pas0.lowest_ask
                    ELSE NULL::numeric
                END AS live_ask
           FROM pack_ask_state pas0
          WHERE pas0.dist_id = pd.dist_id AND (pd.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND pas0.collection_slug = 'nba-top-shot'::text OR pd.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid AND pas0.collection_slug = 'nfl-all-day'::text)
         LIMIT 1) pas ON true
     LEFT JOIN LATERAL ( SELECT pev.gross_ev = 0::numeric AND pev.edition_count = 0 AS is_sentinel) sent ON true
     -- Collection-scoped so a Top Shot row never probes the All Day supply table
     -- and vice versa; both are PK lookups on dist_id.
     LEFT JOIN topshot_pack_supply tss ON tss.dist_id = pd.dist_id
          AND pd.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
     LEFT JOIN allday_pack_supply ads ON ads.dist_id = pd.dist_id
          AND pd.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid;

COMMENT ON VIEW public.pack_table_rows IS
  'Pack catalogue read model. supply_as_of / depletion_as_of date the numbers beside them: supply_as_of is topshot_pack_supply.LAST_SUCCESS_AT for Top Shot (not updated_at, which the lane bumps on a FAILED fetch while leaving stale counters) and allday_pack_supply.opened_updated_at for All Day, NULL elsewhere; depletion_as_of is branch-matched to the COALESCE producing depletion_pct, falling back to mv_pack_ev_latest.snapshotted_at. NULL means "no honest age", never "fresh".';
