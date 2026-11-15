-- 2026-11-14 PT. Legacy Candy listings: retire an ask Magic Eden stopped serving, scoped to ONE
-- collection's set. Called by lib/candy/collections-market.ts (sweepListings) only behind a
-- complete, plausible listings sweep of that collection's ME symbol. Before this the legacy
-- collections had no ask feed at all (0 candy_listings rows vs ~10,650 legacy asks on ME 11-14),
-- so the FMV ask-ceiling could not cap any legacy card.
-- Scope guards: Candy collection only, venue magic_eden only, rows last seen BEFORE the sweep
-- began (an ask the sweep just wrote can never be retired), and never a pda the sweep saw.
-- Revert: DROP FUNCTION public.candy_retire_unseen_set_listings(uuid, text[], timestamptz);
--   (rows it retired: candy_listings is_active=false on that set's editions; the next sweep
--    re-activates any ask ME still serves, since it upserts is_active=true.)
create or replace function public.candy_retire_unseen_set_listings(
  p_set_id uuid,
  p_seen_pdas text[],
  p_before timestamptz
) returns integer
language sql
security definer
set search_path = public
as $$
  with retired as (
    update public.candy_listings l
       set is_active = false
      from public.editions e
     where e.id = l.edition_id
       and e.set_id = p_set_id
       and e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
       and l.is_active
       and l.venue = 'magic_eden'
       and l.last_seen_at < p_before
       and not (l.pda_address = any (coalesce(p_seen_pdas, '{}'::text[])))
    returning 1
  )
  select count(*)::integer from retired
$$;
revoke all on function public.candy_retire_unseen_set_listings(uuid, text[], timestamptz) from public, anon, authenticated;
grant execute on function public.candy_retire_unseen_set_listings(uuid, text[], timestamptz) to service_role;
