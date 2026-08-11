-- Candy MLB: editions.set_name was NULL on 125/125 rows despite set_id being
-- populated on all 125. Not user-reachable today (the live board reads its own
-- candy_* views), but the denorm gap surfaces the moment a per-collection route
-- is published — and `set_name` is one of the columns the shared edition/wallet
-- read paths select directly. Backfilled from the FK.
UPDATE public.editions e
   SET set_name = s.name
  FROM public.sets s
 WHERE s.id = e.set_id
   AND e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
   AND e.set_name IS NULL
   AND s.name IS NOT NULL;
-- Revert: UPDATE public.editions SET set_name = NULL
--          WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid;