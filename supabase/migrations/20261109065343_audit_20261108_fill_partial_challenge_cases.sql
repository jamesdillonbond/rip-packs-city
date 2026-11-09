-- Trevor 2026-11-08: right before a trophy challenge closes, fill every partial case to 6
-- with the collector's highest-FMV eligible, provably-owned moments (only when they own enough).
-- Revert: delete from trophy_moments where id in (select trophy_moment_id from audit_challenge_autofill where run_id = <id>)
--         and update trophy_cases set completed_at = null where id in (select case_id from audit_challenge_autofill where run_id = <id>);
create table if not exists public.audit_challenge_autofill (
  id bigserial primary key,
  run_id uuid not null,
  filled_at timestamptz not null default now(),
  challenge_slug text not null,
  case_id uuid not null,
  user_id uuid not null,
  trophy_moment_id bigint,
  slot int not null,
  moment_id text not null,
  edition_id text,
  fmv numeric,
  dry_run boolean not null
);
alter table public.audit_challenge_autofill enable row level security;
revoke all on public.audit_challenge_autofill from anon, authenticated;
revoke all on sequence public.audit_challenge_autofill_id_seq from anon, authenticated;

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
  c record;
begin
  select * into v_ch from trophy_challenges where slug = p_slug;
  if v_ch.id is null then raise exception 'no challenge %', p_slug; end if;
  if now() >= v_ch.ends_at then raise exception 'challenge % already closed at %', p_slug, v_ch.ends_at; end if;

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

    -- candidates: eligible player + collection, not already in this case, provably owned
    create temp table if not exists _cand (moment_id text, edition_key text, fmv_usd numeric, collection_id uuid,
      player_name text, set_name text, serial_number int, mint_count int, tier text, image_url text, dup boolean) on commit drop;
    truncate _cand;
    insert into _cand
    select distinct on (w.moment_id) w.moment_id, w.edition_key, w.fmv_usd, w.collection_id, w.player_name, w.set_name,
           w.serial_number, w.mint_count, w.tier, w.image_url,
           exists (select 1 from trophy_moments t where t.case_id = r.cid and t.edition_id = w.edition_key)
      from (select distinct wallet_addr a from saved_wallets where user_id = r.uid and wallet_addr is not null
            union select wallet_address from user_profiles where id = r.uid and wallet_address is not null) wa
      join wallet_moments_cache w on w.wallet_address = wa.a
     where w.player_name = any(select jsonb_array_elements_text(v_ch.rules->'player_names'))
       and w.collection_id in (select c2.id from collections c2 where c2.slug in (select jsonb_array_elements_text(v_ch.rules->'collection_slugs'))
                               union select '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid where (v_ch.rules->'collection_slugs') ? 'nba_top_shot'
                               union select 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid where (v_ch.rules->'collection_slugs') ? 'panini_blockchain')
       and not exists (select 1 from trophy_moments t where t.case_id = r.cid and t.moment_id = w.moment_id)
       and ( w.last_seen_at >= (select max(x.last_seen_at) from wallet_moments_cache x where x.wallet_address = w.wallet_address) - interval '1 day'
             or (w.is_locked and w.lock_checked_at >= now() - interval '14 days') );

    if (select count(*) from _cand) < v_need then
      username := r.uname; case_id := r.cid; slot := null; moment_id := null; edition_id := null; fmv := null;
      action := format('skipped: needs %s, owns %s more eligible', v_need, (select count(*) from _cand));
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
comment on function public.fill_partial_challenge_cases(text, boolean) is
  'Trevor 2026-11-08: fill partial trophy-challenge cases to 6 with highest-FMV eligible owned moments just before close. Audited in audit_challenge_autofill. Caller: one-off pg_cron job per challenge.';