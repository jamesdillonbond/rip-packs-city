-- audit_20261011_delete_user_account_catalog_walk
--
-- 2026-10-11 (PT, Claude Code cloud). Platform review item C1: the privacy
-- policy promised an account-deletion control that did not exist. This is the
-- data half; app/api/profile/account (DELETE) is the route and the Profile
-- editor carries the control.
--
-- WHY A CATALOG WALK. 40+ tables key rows to a person three different ways
-- (uuid user columns, the polymorphic owner_key, an email), and the list grows
-- with every feature. A hardcoded list beside a registry goes stale silently
-- (CLAUDE.md), and a deletion that misses a table is a false statement in a
-- privacy policy. So the function reads information_schema at run time and
-- applies a RULE per column shape; the pin (supabase/tests/delete_user_account.sql)
-- proves the rules, including the ones that must NOT delete.
--
-- RULES. user_id -> DELETE (anonymise on usage_events / outbound_clicks /
-- funnel_events / stripe_payment_log, where the row is an aggregate fact);
-- secondary uuid references -> NULL if nullable, else KEPT and reported;
-- owner_key -> DELETE for the user id, username, and wallets this user alone
-- saved; email / user_email -> DELETE; notification_email -> NULL;
-- user_profiles by id -> DELETE. auth.users is left to the route (Auth admin
-- API) so a failure here never orphans a half-deleted account. The FK-cascade
-- tables (profile_bio, saved_wallets, trophy_moments, follows, ...) are deleted
-- by the walk too; the cascade is a second net, not the first.
--
-- Scratch tables (audit_%, %_backup%, _%) are skipped: they are frozen copies,
-- not live records, and several lack a primary key.
--
-- ACL. service_role only. It is destructive by design; anon/authenticated
-- EXECUTE would let any session delete any account.
-- anon-exec: revoked below — destructive SECURITY DEFINER, service_role only (delete_user_account)
--
-- REVERT: DROP FUNCTION public.delete_user_account(uuid); the route then fails
-- closed on the missing RPC. Deleted rows are not recoverable (that is the point).

CREATE OR REPLACE FUNCTION public.delete_user_account(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_email     text;
  v_username  text;
  v_keys      text[];
  v_keys_ci   text[];
  v_report    jsonb := '{}'::jsonb;
  v_n         integer;
  r           record;
BEGIN
  SELECT lower(u.email) INTO v_email FROM auth.users u WHERE u.id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'delete_user_account: no auth.users row for %', p_user_id;
  END IF;
  SELECT pb.username INTO v_username FROM public.profile_bio pb WHERE pb.user_id = p_user_id;

  -- owner_key is POLYMORPHIC (lib/auth/owner-key-guard.ts): an auth user id, a
  -- profile username, or a wallet address. The user id and username are this
  -- user's by definition. A wallet counts only when THIS user is its sole saver:
  -- a wallet two accounts saved is not this user's to erase. Wallet keys match
  -- exactly (a Candy base58 key is case-sensitive); id and username match
  -- case-insensitively, as the guard resolves them.
  v_keys    := ARRAY[p_user_id::text];
  v_keys_ci := ARRAY[lower(p_user_id::text)];
  IF v_username IS NOT NULL AND length(trim(v_username)) > 0 THEN
    v_keys    := v_keys || trim(v_username);
    v_keys_ci := v_keys_ci || lower(trim(v_username));
  END IF;
  v_keys := v_keys || COALESCE((
    SELECT array_agg(sw.wallet_addr)
      FROM public.saved_wallets sw
     WHERE sw.user_id = p_user_id
       AND sw.wallet_addr IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.saved_wallets o
          WHERE o.wallet_addr = sw.wallet_addr AND o.user_id <> p_user_id)
  ), ARRAY[]::text[]);

  -- 1. uuid user-reference columns: a TREE WALK over the live catalog, never a
  --    curated list, so a table added next month is covered the day it lands.
  --    user_id rows are the user's own and are DELETED, except on the four
  --    telemetry/ledger tables where the row is an aggregate fact and only the
  --    link is personal (anonymised: user_id -> NULL). A follow edge is ABOUT
  --    the user and goes with them. Attribution references (winner, buyer,
  --    seller, created_by, fulfilled_by) are anonymised when nullable and
  --    otherwise KEPT and reported: a giveaway does not vanish because its
  --    creator closed their account.
  FOR r IN
    SELECT c.table_name, c.column_name, c.is_nullable
      FROM information_schema.columns c
      JOIN pg_namespace n ON n.nspname = c.table_schema
      JOIN pg_class k ON k.relnamespace = n.oid AND k.relname = c.table_name
     WHERE c.table_schema = 'public'
       AND k.relkind IN ('r', 'p')
       AND c.data_type = 'uuid'
       AND c.column_name IN ('user_id', 'follower_user_id', 'followee_user_id', 'winner_user_id',
                             'buyer_user_id', 'seller_user_id', 'created_by', 'fulfilled_by')
       AND c.table_name NOT LIKE 'audit\_%'
       AND c.table_name NOT LIKE '%\_backup%'
       AND c.table_name NOT LIKE '\_%'
     ORDER BY c.table_name, c.column_name
  LOOP
    IF r.column_name IN ('user_id', 'follower_user_id', 'followee_user_id')
       AND r.table_name NOT IN ('usage_events', 'outbound_clicks', 'funnel_events', 'stripe_payment_log') THEN
      EXECUTE format('DELETE FROM public.%I WHERE %I = %L', r.table_name, r.column_name, p_user_id);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n > 0 THEN v_report := v_report || jsonb_build_object(r.table_name || '.' || r.column_name || ':deleted', v_n); END IF;
    ELSIF r.is_nullable = 'YES' THEN
      EXECUTE format('UPDATE public.%I SET %I = NULL WHERE %I = %L', r.table_name, r.column_name, r.column_name, p_user_id);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n > 0 THEN v_report := v_report || jsonb_build_object(r.table_name || '.' || r.column_name || ':anonymised', v_n); END IF;
    ELSE
      EXECUTE format('SELECT count(*) FROM public.%I WHERE %I = %L', r.table_name, r.column_name, p_user_id) INTO v_n;
      IF v_n > 0 THEN v_report := v_report || jsonb_build_object(r.table_name || '.' || r.column_name || ':kept', v_n); END IF;
    END IF;
  END LOOP;

  -- 2. owner_key-keyed rows (watchlists, alerts, achievements, snapshots, chat).
  FOR r IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN pg_namespace n ON n.nspname = c.table_schema
      JOIN pg_class k ON k.relnamespace = n.oid AND k.relname = c.table_name
     WHERE c.table_schema = 'public' AND k.relkind IN ('r', 'p')
       AND c.column_name = 'owner_key' AND c.data_type = 'text'
       AND c.table_name NOT LIKE 'audit\_%'
       AND c.table_name NOT LIKE '%\_backup%'
       AND c.table_name NOT LIKE '\_%'
     ORDER BY c.table_name
  LOOP
    EXECUTE format('DELETE FROM public.%I WHERE owner_key = ANY (%L::text[]) OR lower(owner_key) = ANY (%L::text[])',
                   r.table_name, v_keys, v_keys_ci);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN v_report := v_report || jsonb_build_object(r.table_name || '.owner_key:deleted', v_n); END IF;
  END LOOP;

  -- 3. email-keyed rows: subscriptions, the allow-list row, concierge sessions
  --    and transcripts an anonymous visitor tied to this address.
  FOR r IN
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN pg_namespace n ON n.nspname = c.table_schema
      JOIN pg_class k ON k.relnamespace = n.oid AND k.relname = c.table_name
     WHERE c.table_schema = 'public' AND k.relkind IN ('r', 'p')
       AND c.column_name IN ('email', 'user_email') AND c.data_type = 'text'
       AND c.table_name NOT LIKE 'audit\_%'
       AND c.table_name NOT LIKE '%\_backup%'
       AND c.table_name NOT LIKE '\_%'
     ORDER BY c.table_name, c.column_name
  LOOP
    EXECUTE format('DELETE FROM public.%I WHERE lower(%I) = %L', r.table_name, r.column_name, v_email);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN v_report := v_report || jsonb_build_object(r.table_name || '.' || r.column_name || ':deleted', v_n); END IF;
  END LOOP;
  FOR r IN
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN pg_namespace n ON n.nspname = c.table_schema
      JOIN pg_class k ON k.relnamespace = n.oid AND k.relname = c.table_name
     WHERE c.table_schema = 'public' AND k.relkind IN ('r', 'p')
       AND c.column_name = 'notification_email' AND c.data_type = 'text' AND c.is_nullable = 'YES'
       AND c.table_name NOT LIKE 'audit\_%'
     ORDER BY c.table_name
  LOOP
    EXECUTE format('UPDATE public.%I SET %I = NULL WHERE lower(%I) = %L', r.table_name, r.column_name, r.column_name, v_email);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN v_report := v_report || jsonb_build_object(r.table_name || '.' || r.column_name || ':anonymised', v_n); END IF;
  END LOOP;

  -- 4. The profile row itself (keyed by id, so the walk above does not see it).
  DELETE FROM public.user_profiles WHERE id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_report := v_report || jsonb_build_object('user_profiles.id:deleted', v_n); END IF;

  -- auth.users is NOT deleted here: the route removes it through the Auth
  -- admin API after this returns, so a failure in this function leaves the
  -- account intact and retryable, never an orphaned half-deletion.
  RETURN jsonb_build_object(
    'ok', true,
    'owner_keys', cardinality(v_keys),
    'rows', v_report
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_user_account(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_user_account(uuid) TO postgres, service_role;
