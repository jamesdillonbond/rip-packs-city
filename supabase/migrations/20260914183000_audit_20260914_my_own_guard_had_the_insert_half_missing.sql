-- ─────────────────────────────────────────────────────────────────────────────
-- ⛔ MY OWN FIX 35 MINUTES AGO WAS HALF A FIX, and the missing half is the case
-- the estate has already produced once.
--
-- `20260914180000` installed `trg_whs_refuse_same_day_collapse` as BEFORE UPDATE.
-- That covers the observed 2026-09-13 incident exactly — a complete snapshot was
-- written at 10:07Z and a failed 12:46Z re-run UPSERTed a 1,000-row partial over
-- it, which is an UPDATE.
--
-- 🚨 BUT IF THE DAY'S **FIRST** RUN FAILS MID-WALK THERE IS NO ROW TO UPDATE.
-- The upsert INSERTs, the trigger never fires, and the partial lands as that
-- day's snapshot unopposed. That is not hypothetical: 2026-09-11 has NO row for
-- this wallet at all, i.e. the day's runs failed before writing — one page later
-- and it would have inserted a partial instead.
--
-- ── WHY THE INSERT ARM NEEDS A DIFFERENT PREDICATE ───────────────────────────
-- On UPDATE the test can be loose (any same-day cut over half on a >= 100 row),
-- because a same-day downward revision is NEVER legitimate.
--
-- On INSERT there is no same-day row to compare against, only the previous day —
-- and a whale really could halve its holdings between two days. So the insert arm
-- adds the partial read's own fingerprint: **an exact multiple of the walk's page
-- size.** A genuine count is not round (52,120 · 11,969 · 4 are the three live
-- ones); a clipped one is 250 · 500 · 750 · 1,000 … by construction. Requiring
-- BOTH a >50% drop and an exact page multiple makes a false positive a ~1-in-250
-- coincidence on top of an already-unusual event, and it still fails LOUD and
-- overridably rather than silently.
--
-- ⚠ COUPLING, STATED SO IT CANNOT ROT SILENTLY: 250 mirrors `PAGE_SIZE` in
-- `supabase/functions/snapshot-institutional-wallets/index.ts`. If that constant
-- changes, THIS ARM GOES BLIND — it will not fire and nothing will say so. The
-- UPDATE arm has no such coupling and keeps working either way, which is why the
-- two arms are deliberately not unified.
--
-- ⚠ AND WHAT IT STILL CANNOT SEE: a partial read whose count happens NOT to be a
-- page multiple (the walk returns everything it got when the LAST page is short),
-- and the very first snapshot a (wallet, collection) ever gets, which has no
-- prior row to compare with. Neither is fixable from the database; both are the
-- writer's job (register #119 owed item 1: return without writing when the load
-- errored).
--
-- ⚠ FULL-BODY WRITE: the live body was re-read immediately before drafting this
-- (md5 87644c75…, 1,034 chars — unchanged since it was installed 35 minutes ago).
--
-- REVERT: re-apply 20260914180000's function body and
--   CREATE TRIGGER trg_whs_refuse_same_day_collapse BEFORE UPDATE ON public.wallet_holdings_snapshot
--     FOR EACH ROW EXECUTE FUNCTION public.whs_refuse_same_day_collapse();
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.whs_refuse_same_day_collapse()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  -- Mirrors PAGE_SIZE in supabase/functions/snapshot-institutional-wallets/index.ts.
  -- See the migration header: if that changes, the INSERT arm goes blind.
  c_page_size CONSTANT integer := 250;
  v_prev      integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Same snapshot_at only. A different day is a new observation, never blocked.
    IF NEW.snapshot_at IS DISTINCT FROM OLD.snapshot_at THEN
      RETURN NEW;
    END IF;

    IF OLD.moment_count >= 100
       AND NEW.moment_count < OLD.moment_count / 2
    THEN
      RAISE EXCEPTION
        'refusing a same-day collapse on wallet_holdings_snapshot: % / % / % would go from % moments to % in one day. '
        'A real holdings change appears as a NEW snapshot_at, never as a same-day revision downward; this shape is a '
        'PARTIAL READ being written over a complete one (see migration 20260914180000). '
        'If this is a legitimate correction, DISABLE TRIGGER trg_whs_refuse_same_day_collapse around it.',
        NEW.wallet_address, NEW.collection_id, NEW.snapshot_at, OLD.moment_count, NEW.moment_count
        USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
  END IF;

  -- INSERT: no same-day row exists, so compare with the most recent EARLIER one
  -- and additionally require the partial read's own fingerprint.
  SELECT w.moment_count INTO v_prev
    FROM public.wallet_holdings_snapshot w
   WHERE w.wallet_address = NEW.wallet_address
     AND w.collection_id  = NEW.collection_id
     AND w.snapshot_at    < NEW.snapshot_at
   ORDER BY w.snapshot_at DESC
   LIMIT 1;

  IF v_prev IS NOT NULL
     AND v_prev >= 100
     AND NEW.moment_count > 0
     AND NEW.moment_count < v_prev / 2
     AND NEW.moment_count % c_page_size = 0
  THEN
    RAISE EXCEPTION
      'refusing a partial-looking first write on wallet_holdings_snapshot: % / % / % arrives at % moments against % on the '
      'previous snapshot, and % is an exact multiple of the walk page size (%). That is the signature of a page walk that '
      'failed part way and wrote what it had (see migration 20260914183000). '
      'If this is a real holdings change, DISABLE TRIGGER trg_whs_refuse_same_day_collapse around it.',
      NEW.wallet_address, NEW.collection_id, NEW.snapshot_at, NEW.moment_count, v_prev, NEW.moment_count, c_page_size
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

-- anon-exec: NOT applicable for whs_refuse_same_day_collapse — a trigger function returns trigger and is not callable over PostgREST; revoked anyway on the next line.
REVOKE EXECUTE ON FUNCTION public.whs_refuse_same_day_collapse() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_whs_refuse_same_day_collapse ON public.wallet_holdings_snapshot;
CREATE TRIGGER trg_whs_refuse_same_day_collapse
  BEFORE INSERT OR UPDATE ON public.wallet_holdings_snapshot
  FOR EACH ROW
  EXECUTE FUNCTION public.whs_refuse_same_day_collapse();

COMMENT ON FUNCTION public.whs_refuse_same_day_collapse() IS
  'BEFORE INSERT OR UPDATE on wallet_holdings_snapshot. UPDATE arm: refuses a same-snapshot_at cut of '
  'more than half when the existing row holds >= 100 moments (a same-day downward revision is never '
  'legitimate). INSERT arm: refuses a first write that is under half the previous snapshot AND an exact '
  'multiple of the walk page size (250) — the partial-read fingerprint. Blind spots stated in migration '
  '20260914183000: a partial that is not a page multiple, and a (wallet, collection) first observed today.';

-- ── verification, same transaction ───────────────────────────────────────────
DO $verify$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_triggerdef(t.oid) INTO v_def
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.wallet_holdings_snapshot'::regclass
     AND t.tgname = 'trg_whs_refuse_same_day_collapse'
     AND NOT t.tgisinternal;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'the guard trigger is missing after the replace';
  END IF;
  IF v_def NOT ILIKE '%BEFORE INSERT OR UPDATE%' THEN
    RAISE EXCEPTION 'the trigger did not gain its INSERT arm: %', v_def;
  END IF;
END
$verify$;
