-- Restore Panini's PRIMARY (drop) pack price on the three rows a marketplace-only capture had
-- nulled (1055 WNBA FOTL $150, 1056 WNBA Hobby $30, 1065 NWSL $10), from panini_pack_state_history.
-- Applied 2026-11-22 ~11:33 PM PT, after 245f4cb10 (the ingest now carries a stored price forward)
-- was live. Revert: update panini_pack_state set price_usd = null where id in ('1055','1056','1065');
update public.panini_pack_state s
   set price_usd = h.price_usd
  from (select distinct on (id) id, price_usd
          from public.panini_pack_state_history
         where price_usd is not null and id in ('1055','1056','1065')
         order by id) h
 where s.id = h.id and s.price_usd is null;
