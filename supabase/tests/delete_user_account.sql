-- DB invariant: public.delete_user_account(uuid): the account-deletion data
-- purge behind DELETE /api/profile/account.
--
-- WHY A PIN. The function walks information_schema and applies a rule per
-- column shape. Both failure directions are silent: a rule that misses a table
-- leaves personal data behind under a policy that says it is gone; a rule that
-- over-reaches deletes ANOTHER user's rows (a shared wallet, a giveaway whose
-- creator left). Each case below is one of those directions.
--
-- Vanilla Postgres has no auth schema; the fixture creates the two columns the
-- function reads. Runs inside a rolled-back transaction.
--
-- DDL is VERBATIM from
-- supabase/migrations/20261012052403_audit_20261011_delete_user_account_catalog_walk.sql
-- (drift guard: __tests__/db-invariants-drift-guard.test.ts).

BEGIN;

CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);

-- The shapes the walk must handle. u1 is deleted; u2 is the control.
CREATE TABLE public.profile_bio          (user_id uuid NOT NULL, username text);
CREATE TABLE public.saved_wallets        (user_id uuid NOT NULL, wallet_addr text);
CREATE TABLE public.watchlist_items      (owner_key text NOT NULL, note text);
CREATE TABLE public.usage_events         (id serial PRIMARY KEY, user_id uuid, feature text);
CREATE TABLE public.redemptions          (id serial PRIMARY KEY, user_id uuid NOT NULL, fulfillment jsonb);
CREATE TABLE public.email_subscribers    (email text NOT NULL);
CREATE TABLE public.support_conversations(id serial PRIMARY KEY, owner_key text, user_email text, user_message text NOT NULL);
CREATE TABLE public.fmv_alerts           (owner_key text NOT NULL, notification_email text);
CREATE TABLE public.raffle_draws         (id serial PRIMARY KEY, winner_user_id uuid);
CREATE TABLE public.giveaways            (id serial PRIMARY KEY, created_by uuid NOT NULL, title text);
CREATE TABLE public.follows              (follower_user_id uuid NOT NULL, followee_user_id uuid NOT NULL);
CREATE TABLE public.user_profiles        (id uuid PRIMARY KEY, username text);
CREATE TABLE public.audit_20260101_x     (user_id uuid, note text);

-- >>> BEGIN verbatim delete_user_account >>>
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
-- <<< END verbatim delete_user_account <<<

INSERT INTO auth.users VALUES
  ('11111111-1111-1111-1111-111111111111', 'U1@Example.com'),
  ('22222222-2222-2222-2222-222222222222', 'u2@example.com');
INSERT INTO public.profile_bio VALUES ('11111111-1111-1111-1111-111111111111', 'DameFan'), ('22222222-2222-2222-2222-222222222222', 'other');
-- 0xaaa is u1's alone; 0xshared is saved by both; 1BWbase58Case is u1's Candy key (case-sensitive).
INSERT INTO public.saved_wallets VALUES
  ('11111111-1111-1111-1111-111111111111', '0xaaa'),
  ('11111111-1111-1111-1111-111111111111', '0xshared'),
  ('22222222-2222-2222-2222-222222222222', '0xshared'),
  ('11111111-1111-1111-1111-111111111111', '1BWbase58Case');
INSERT INTO public.watchlist_items VALUES
  ('11111111-1111-1111-1111-111111111111', 'by uuid'),
  ('damefan', 'by username, different case'),
  ('0xaaa', 'by sole wallet'),
  ('1BWbase58Case', 'by candy wallet, exact case'),
  ('1bwbase58case', 'a DIFFERENT candy wallet that only matches when folded: must stay'),
  ('0xshared', 'shared wallet: must stay'),
  ('22222222-2222-2222-2222-222222222222', 'u2: must stay');
INSERT INTO public.usage_events (user_id, feature) VALUES ('11111111-1111-1111-1111-111111111111', 'fmv'), ('22222222-2222-2222-2222-222222222222', 'fmv');
INSERT INTO public.redemptions (user_id, fulfillment) VALUES ('11111111-1111-1111-1111-111111111111', '{"address":{"line1":"1 Main St"}}'), ('22222222-2222-2222-2222-222222222222', '{}');
INSERT INTO public.email_subscribers VALUES ('u1@example.com'), ('u2@example.com');
INSERT INTO public.support_conversations (owner_key, user_email, user_message) VALUES
  ('11111111-1111-1111-1111-111111111111', NULL, 'u1 signed-in chat'),
  (NULL, 'U1@EXAMPLE.COM', 'u1 anon chat that typed the email'),
  (NULL, 'u2@example.com', 'u2 chat: must stay');
INSERT INTO public.fmv_alerts VALUES ('22222222-2222-2222-2222-222222222222', 'u1@example.com');
INSERT INTO public.raffle_draws (winner_user_id) VALUES ('11111111-1111-1111-1111-111111111111');
INSERT INTO public.giveaways (created_by, title) VALUES ('11111111-1111-1111-1111-111111111111', 'fall drop');
INSERT INTO public.follows VALUES ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'), ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111');
INSERT INTO public.user_profiles VALUES ('11111111-1111-1111-1111-111111111111', 'damefan'), ('22222222-2222-2222-2222-222222222222', 'other');
INSERT INTO public.audit_20260101_x VALUES ('11111111-1111-1111-1111-111111111111', 'frozen copy: never touched');

SELECT _assert((public.delete_user_account('11111111-1111-1111-1111-111111111111')->>'ok')::boolean, 'returns ok');

-- Deleted: the user's own rows in every shape.
SELECT _assert_eq((SELECT count(*)::text FROM public.profile_bio WHERE user_id = '11111111-1111-1111-1111-111111111111'), '0', 'profile_bio row gone');
SELECT _assert_eq((SELECT count(*)::text FROM public.saved_wallets WHERE user_id = '11111111-1111-1111-1111-111111111111'), '0', 'saved_wallets rows gone');
SELECT _assert_eq((SELECT count(*)::text FROM public.redemptions WHERE user_id = '11111111-1111-1111-1111-111111111111'), '0', 'redemption (with its shipping address) gone: user_id NOT NULL means delete');
SELECT _assert_eq((SELECT count(*)::text FROM public.email_subscribers WHERE lower(email) = 'u1@example.com'), '0', 'email subscription gone, case-insensitively');
SELECT _assert_eq((SELECT count(*)::text FROM public.support_conversations WHERE user_message LIKE 'u1%'), '0', 'both the signed-in transcript (owner_key) and the anonymous one keyed by email are gone');
SELECT _assert_eq((SELECT count(*)::text FROM public.user_profiles WHERE id = '11111111-1111-1111-1111-111111111111'), '0', 'user_profiles row (keyed by id) gone');
SELECT _assert_eq((SELECT string_agg(note, ' | ' ORDER BY note) FROM public.watchlist_items),
  'a DIFFERENT candy wallet that only matches when folded: must stay | shared wallet: must stay | u2: must stay',
  'owner_key rows: uuid, username (any case), sole wallet and the exact-case Candy key are gone; the shared wallet, the case-variant Candy key and u2 stay');

-- Anonymised, not deleted: aggregate facts and secondary references.
SELECT _assert_eq((SELECT count(*)::text FROM public.usage_events), '2', 'usage_events rows are kept (aggregate facts)');
SELECT _assert_eq((SELECT count(*)::text FROM public.usage_events WHERE user_id IS NULL), '1', 'with the deleted user''s link set to NULL');
SELECT _assert_eq((SELECT count(*)::text FROM public.raffle_draws WHERE winner_user_id IS NULL), '1', 'a nullable secondary reference (winner) is anonymised');
SELECT _assert_eq((SELECT count(*)::text FROM public.fmv_alerts WHERE notification_email IS NULL), '1', 'notification_email on another user''s alert is nulled, the alert kept');

-- Kept and reported: a NOT NULL secondary reference is not a reason to destroy someone else's object.
SELECT _assert_eq((SELECT count(*)::text FROM public.giveaways), '1', 'a giveaway whose creator left is KEPT');

-- The control user is untouched everywhere.
SELECT _assert_eq((SELECT count(*)::text FROM public.profile_bio WHERE user_id = '22222222-2222-2222-2222-222222222222'), '1', 'u2 profile intact');
SELECT _assert_eq((SELECT count(*)::text FROM public.saved_wallets WHERE user_id = '22222222-2222-2222-2222-222222222222'), '1', 'u2 wallet intact');
SELECT _assert_eq((SELECT count(*)::text FROM public.support_conversations WHERE user_email = 'u2@example.com'), '1', 'u2 transcript intact');
SELECT _assert_eq((SELECT count(*)::text FROM public.follows), '0', 'follow edges in BOTH directions are gone (follower and followee columns are both walked)');
SELECT _assert_eq((SELECT count(*)::text FROM public.audit_20260101_x), '1', 'a scratch audit_ table is never touched');
SELECT _assert_eq((SELECT count(*)::text FROM auth.users), '2', 'auth.users is NOT deleted here: the route does that after a successful purge');

-- The report names what happened, including what was KEPT, so the route can log it.
SELECT _assert(
  (SELECT (public.delete_user_account('22222222-2222-2222-2222-222222222222')->'rows') ? 'profile_bio.user_id:deleted'),
  'the report keys rows by table.column:outcome');

-- An unknown user is an error, not a silent no-op that reads as success.
DO $do$
BEGIN
  PERFORM public.delete_user_account('33333333-3333-3333-3333-333333333333');
  RAISE EXCEPTION 'ASSERT FAILED: an unknown user id must raise';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM NOT LIKE 'delete_user_account: no auth.users row for %' THEN RAISE; END IF;
END
$do$;

ROLLBACK;
