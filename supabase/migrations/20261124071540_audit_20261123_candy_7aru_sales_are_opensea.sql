-- Program 7Aru291A64wrTkUDaRv6HqxVBre6ivXWL94cUoCtQF9V is OpenSea's Solana Marketplace Program (named in
-- OpenSea's Bugcrowd scope, identified 2026-11-23). Its Candy fills were written as marketplace 'solana_7aru'
-- since 11-22; relabel them 'opensea', the key OpenSea sales already use. Idempotent.
-- Revert: UPDATE … SET marketplace = 'solana_7aru' WHERE marketplace = 'opensea' AND <same scope> (no other
-- Candy row carried 'opensea' before this: 0 in sales, checked 11-23).
UPDATE public.sales SET marketplace = 'opensea'
 WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid AND marketplace = 'solana_7aru';
UPDATE public.candy_sales_unresolved SET marketplace = 'opensea' WHERE marketplace = 'solana_7aru';
UPDATE public.candy_pack_sales SET marketplace = 'opensea' WHERE marketplace = 'solana_7aru';
