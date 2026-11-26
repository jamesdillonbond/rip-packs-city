-- audit_20261125_ufc_aptos_listings_key_per_token
--
-- 2026-11-25 ~8:55 PM PT (Claude Code cloud; Trevor: "push to main. Fix any issues you encountered").
--
-- WHY: a Rarible BUNDLE listing is ONE listing object holding several Moments, so every token in it shares
-- the same listing_address. With listing_address alone as the primary key, the second run of
-- scripts/ufc-aptos-listings.mjs (dispatch 45756488480, ~8:45 PM PT) died on its first upsert batch:
-- 21000 "ON CONFLICT DO UPDATE command cannot affect row a second time". Even without the error, a bundle could
-- store only one of its Moments. The key becomes (listing_address, token_data_id): one row per Moment per listing.
--
-- Safe to swap in place: the table held 0 rows when this was written (count(*) = 0, cursor NULL — the lane has
-- never completed a write). v_ufc_aptos_edition_floor reads columns only, not the key, so it is untouched.
-- No functions are created or replaced here.
--
-- Revert:
--   ALTER TABLE public.ufc_aptos_listings DROP CONSTRAINT ufc_aptos_listings_pkey;
--   ALTER TABLE public.ufc_aptos_listings ADD CONSTRAINT ufc_aptos_listings_pkey PRIMARY KEY (listing_address);
--   (fails while any bundle holds 2+ tokens — truncate the table first; the lane re-fills it from its cursor reset.)

ALTER TABLE public.ufc_aptos_listings DROP CONSTRAINT ufc_aptos_listings_pkey;
ALTER TABLE public.ufc_aptos_listings ADD CONSTRAINT ufc_aptos_listings_pkey PRIMARY KEY (listing_address, token_data_id);
