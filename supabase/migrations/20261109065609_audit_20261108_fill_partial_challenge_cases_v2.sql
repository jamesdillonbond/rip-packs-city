create or replace function public.fill_partial_challenge_cases(p_slug text, p_dry_run boolean default true)
returns table(username text, case_id uuid, slot int, moment_id text, edition_id text, fmv numeric, action text)
language plpgsql security definer set search_path = public as $$
declare
  v_ch record;
  v_run uuid := gen_random_uuid();
  r record;
  v_free int[];
  v_need int;
  v_have int;
  v_i int;
  v_tmid bigint;
  v_cnt int;
  v_players text[];
  v_cols uuid[];
  c record;
begin
  select * into v_ch from trophy_challenges where slug = p_slug;
  if v_ch.id is null then raise exception 'no challenge %', p_slug; end if;
  if now() >= v_ch.ends_at then raise exception 'challenge % already closed at %', p_slug, v_ch.ends_at; end if;
  select array_agg(x) into v_players from jsonb_array_elements_text(v_ch.rules->'player_names') x;
  v_cols := array_remove(array[
    case when (v_ch.rules->'collection_slugs') ? 'nba_top_shot' then '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid end,
    case when (v_ch.rules->'collection_slugs') ? 'panini_blockchain' then 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid end], null);

  create temp table if not exists _cand (moment_id text, edition_key text, fmv_usd numeric, collection_id uuid,
    player_name text, set_name text, serial_number int, mint_count int, tier text, image_url text, dup boolean) on commit drop;

  for r in
    select tc.id as cid, tc.user_id as uid, up.username as uname
    from trophy_cases tc left join user_profiles up on up.id = tc.user_id
    where tc.challenge_id = v_ch.id and tc.completed_at is null
  loop
    select count(*) into v_have from trophy_moments t where t.case_id = r.cid;
    v_need := 6 - v_have;
    continue when v_need <= 0;
    select array_agg(s order by s) into v_free
      from generate_series(1,6) s
     where not exists (select 1 from trophy_moments t where t.case_id = r.cid and t.slot = s);

    truncate _cand;
    insert into _cand
    with wa as (
      select distinct a from (
        select wallet_addr a from saved_wallets where user_id = r.uid and wallet_addr is not null
        union select wallet_address from user_profiles where id = r.uid and wallet_address is not null) z),
    latest as (
      select wa.a, (select max(x.last_seen_at) from wallet_moments_cache x where x.wallet_address = wa.a) mx from wa),
    pinned as (select t.moment_id, t.edition_id from trophy_moments t where t.case_id = r.cid)
    select distinct on (w.moment_id) w.moment_id, w.edition_key, w.fmv_usd, w.collection_id, w.player_name, w.set_name,
           w.serial_number, w.mint_count, w.tier, w.image_url,
           w.edition_key in (select p.edition_id from pinned p)
      from latest l
      join wallet_moments_cache w on w.wallet_address = l.a
     where w.player_name = any(v_players)
       and w.collection_id = any(v_cols)
       and w.moment_id not in (select p.moment_id from pinned p)
       and ( w.last_seen_at >= l.mx - interval '1 day'
             or (w.is_locked and w.lock_checked_at >= now() - interval '14 days') );

    select count(*) into v_cnt from _cand;
    if v_cnt < v_need then
      username := r.uname; case_id := r.cid; slot := null; moment_id := null; edition_id := null; fmv := null;
      action := format('skipped: needs %s, owns %s more eligible', v_need, v_cnt);
      return next; continue;
    end if;

    v_i := 0;
    for c in select * from _cand order by dup, fmv_usd desc nulls last, serial_number limit v_need loop
      v_i := v_i + 1;
      v_tmid := null;
      if not p_dry_run then
        insert into trophy_moments (slot, moment_id, edition_id, player_name, set_name, serial_number, circulation_count,
                                    tier, thumbnail_url, fmv, pinned_at, collection_id, user_id, case_id)
        values (v_free[v_i], c.moment_id, c.edition_key, c.player_name, c.set_name, c.serial_number, c.mint_count, c.tier,
                case when c.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
                     then 'https://assets.nbatopshot.com/media/' || c.moment_id || '/image?width=512' else c.image_url end,
                case when c.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b' then null else c.fmv_usd end,
                now(), c.collection_id, r.uid, r.cid)
        returning id into v_tmid;
      end if;
      insert into audit_challenge_autofill (run_id, challenge_slug, case_id, user_id, trophy_moment_id, slot, moment_id, edition_id, fmv, dry_run)
      values (v_run, p_slug, r.cid, r.uid, v_tmid, v_free[v_i], c.moment_id, c.edition_key, c.fmv_usd, p_dry_run);
      username := r.uname; case_id := r.cid; slot := v_free[v_i]; moment_id := c.moment_id; edition_id := c.edition_key;
      fmv := c.fmv_usd; action := case when p_dry_run then 'would fill' else 'filled' end;
      return next;
    end loop;
  end loop;
end $$;
revoke all on function public.fill_partial_challenge_cases(text, boolean) from public, anon, authenticated;