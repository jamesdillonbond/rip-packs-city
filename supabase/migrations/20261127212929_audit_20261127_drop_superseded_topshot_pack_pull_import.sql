-- audit_20261127_drop_superseded_topshot_pack_pull_import
--
-- 2026-11-27 (PT, ~1:29 PM; Claude Code cloud; Trevor: "Do it" -- to dropping the empty superseded table).
--
-- WHY: 20261127203636 created topshot_pack_pull_import (keyed by open-tx deposits) and two functions
-- over it. 20261127205829 replaced it with pack_reveal_import (keyed by collection + pack, read from
-- PackNFT.Revealed). The old table never held a row and nothing reads it (its only dependents are its
-- own two functions, measured 11-27).
--
-- WRITES: drops 2 functions + 1 empty table. Guarded: refuses if the table holds any row.
-- REVERT: re-apply 20261127203636_audit_20261127_topshot_pack_pull_import_for_retired_sporks.sql.

DO $chk$
BEGIN
  IF EXISTS (SELECT 1 FROM public.topshot_pack_pull_import) THEN
    RAISE EXCEPTION 'topshot_pack_pull_import is not empty -- refusing to drop it';
  END IF;
END
$chk$;

DROP FUNCTION IF EXISTS public.load_topshot_pack_pull_import();
DROP FUNCTION IF EXISTS public.topshot_retired_spork_open_txs(integer, integer);
DROP TABLE IF EXISTS public.topshot_pack_pull_import;
