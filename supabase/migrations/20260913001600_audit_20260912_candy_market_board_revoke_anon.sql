-- Applied as its own MCP migration (`audit_20260912_candy_market_board_revoke_anon`),
-- so it gets its own file: migration parity matches on NAME, and folding this
-- into the view's file would leave that name fileless forever.
--
-- ⚠ `create view` inherits this schema's DEFAULT PRIVILEGES, which grant SELECT
-- to anon AND authenticated. Measured immediately after creating it:
--     candy_market_board | anon          | REFERENCES,SELECT
--     candy_market_board | authenticated | REFERENCES,SELECT,TRIGGER
-- while its sibling candy_deals_board is postgres + service_role ONLY.
--
-- That is not a cosmetic mismatch. A view executes with its OWNER's rights, and
-- this one joins `wallet_moments_cache` -- so leaving anon SELECT in place would
-- hand the public a read path into wmc-derived per-serial data that nothing else
-- exposes to anon, through a view nobody would think to audit. /api/market reads
-- it with the service role, so neither grant is needed for the feature to work.
revoke all on table candy_market_board from anon;
revoke all on table candy_market_board from authenticated;
