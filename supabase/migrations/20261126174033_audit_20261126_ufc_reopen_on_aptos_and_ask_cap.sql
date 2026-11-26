-- audit_20261126_ufc_reopen_on_aptos_and_ask_cap
--
-- 2026-11-26 ~10:15 AM PT (Claude Code cloud). Trevor: "Do it all. ... we need to have visibility be interchangeable ...
-- give them a Flow or Aptos tag ... view this from a chain-agnostic view and ... aggregate across the multiple chains/wallets".
-- That is the reopen decision (gate B in claude/ufc-reopen-on-aptos-plan-2026-11-16.md) plus the FMV-vs-ask recommendation
-- in claude/ufc-aptos-status-2026-11-25.md.
--
-- 1. collections.market_closed_at = NULL for UFC Strike. While set, fmv_snapshots_cap_closed_market_confidence forced every
--    UFC snapshot to STALE, and get_wallet_collection_snapshot / get_cross_collection_portfolio / holdings_summary treated
--    UFC as closed. UFC trades on Aptos (Rarible), and RPC ingests those sales, listings and holdings since 2026-11-15/25.
-- 2. collection_config.metadata.marketplace for UFC (read by v_collection_marketplace_status and the status banner):
--    'shutdown' -> 'healthy', primary venue Rarible on Aptos. buy_ctas_enabled stays false: RPC is read-only, and the
--    edition page links to the Rarible collection page itself.
-- 3. fmv_snapshots_cap_ufc_to_aptos_ask (BEFORE INSERT): a UFC FMV above the edition's cheapest LIVE single-Moment Rarible
--    ask is capped at that ask and stamped '_aptoscap'. Measured 2026-11-26 PT on 438 editions with a live single listing:
--    FMV above the ask on 350 (80 %), median FMV / ask 1.81 ($3.00 vs $1.49); UFC's own store wallet sets the floor on 414
--    of them (mostly a flat 3.99 APT), and 1 UFC sale cleared in ~5 weeks — anyone can buy at the ask and almost nobody does,
--    so a price above it overstates value. Same shape as fmv_snapshots_cap_panini_low_to_live_ask. The cap only LOWERS.
--    "Live" = a single (non-bundle) listing re-confirmed by scripts/ufc-aptos-listings.mjs within 3 days (the lane runs
--    ~2x/day; it deletes a listing only when the token's owner is no longer the listing object). Priced in USD at the latest
--    APT/USD daily close. NO_DATA rows are untouched. SECURITY DEFINER: ufc_aptos_listings / apt_usd_daily are
--    service-role only, and an FMV writer running as cron_heavy (no table SELECT) would otherwise fail every UFC insert.
--
-- anon-exec: revoked (fmv_snapshots_cap_ufc_to_aptos_ask) — new SECURITY DEFINER trigger function; REVOKE FROM PUBLIC, anon, authenticated below.
--
-- Revert:
--   DROP TRIGGER fmv_snapshots_cap_ufc_to_aptos_ask_trg ON public.fmv_snapshots;
--   DROP FUNCTION public.fmv_snapshots_cap_ufc_to_aptos_ask();
--   UPDATE public.collections SET market_closed_at = '2026-05-13 00:00:00+00' WHERE id = '9b4824a8-736d-4a96-b450-8dcc0c46b023';
--   UPDATE public.collection_config SET metadata = jsonb_set(metadata, '{marketplace,status}', '"shutdown"')
--    WHERE collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023';

UPDATE public.collections SET market_closed_at = NULL WHERE id = '9b4824a8-736d-4a96-b450-8dcc0c46b023';

UPDATE public.collection_config
   SET metadata = jsonb_set(
         metadata, '{marketplace}',
         (metadata -> 'marketplace') || jsonb_build_object(
           'status', 'healthy',
           'primary_venue', 'rarible_aptos',
           'primary_contract', '0xe7201624dc99aee9a6d5f6e9bb3cf2061c4facc92e2aa0c05bf9057508deee77',
           'secondary_venue', 'tradeport_aptos',
           'secondary_status', 'dormant_since_2026_09_08',
           'buy_ctas_enabled', false,
           'aptos_migration_date', '2025-08-07',
           'last_verified_at', '2026-11-26T18:15:00+00:00',
           'notes', 'UFC Strike trades on Aptos (Rarible; Tradeport dormant since 2026-09-08). Reopened on RPC 2026-11-26 as one collection across two chains: Flow history (~846k sales, last Flow sale 2026-05-13) plus Aptos sales (aptos_indexer_v1), live Rarible asks (ufc_aptos_listings) and Aptos holdings for linked wallets (ufc_aptos_wallet_links). Thin market: 1 UFC sale 2026-10-01..11-26; UFC''s store wallet posts ~95 % of floor asks. FMV is capped at the live Aptos ask (fmv_snapshots_cap_ufc_to_aptos_ask). buy_ctas_enabled=false: RPC is read-only; edition pages link to the Rarible collection page.'))
 WHERE collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023';

CREATE OR REPLACE FUNCTION public.fmv_snapshots_cap_ufc_to_aptos_ask()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- UFC Strike (collections.id). Scoped by measurement (2026-11-26, claude/ufc-aptos-status-2026-11-25.md).
  c_ufc constant uuid := '9b4824a8-736d-4a96-b450-8dcc0c46b023';
  v_ask_apt numeric;
  v_apt_usd numeric;
  v_ask numeric;
BEGIN
  IF NEW.collection_id = c_ufc
     AND NEW.confidence IS DISTINCT FROM 'NO_DATA'
     AND NEW.fmv_usd IS NOT NULL
     AND NEW.edition_id IS NOT NULL
  THEN
    SELECT min(l.price_apt)
      INTO v_ask_apt
      FROM public.ufc_aptos_listings l
     WHERE l.edition_id = NEW.edition_id
       AND l.kind = 'single'
       AND l.price_apt > 0
       AND l.last_checked_at > now() - interval '3 days';
    IF v_ask_apt IS NOT NULL THEN
      SELECT d.usd INTO v_apt_usd FROM public.apt_usd_daily d WHERE d.usd > 0 ORDER BY d.day DESC LIMIT 1;
      v_ask := round(v_ask_apt * v_apt_usd, 2);
      IF v_ask IS NOT NULL AND v_ask > 0 AND NEW.fmv_usd > v_ask THEN
        NEW.fmv_usd := v_ask;
        NEW.algo_version := COALESCE(NEW.algo_version, '') || '_aptoscap';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fmv_snapshots_cap_ufc_to_aptos_ask() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER fmv_snapshots_cap_ufc_to_aptos_ask_trg
  BEFORE INSERT ON public.fmv_snapshots FOR EACH ROW
  EXECUTE FUNCTION public.fmv_snapshots_cap_ufc_to_aptos_ask();
