-- Shared assertion helpers for the DB-invariant tests. Loaded once per session by
-- scripts/run-db-tests.sh before each test file. A failed assertion RAISEs, which
-- (under psql -v ON_ERROR_STOP=1) aborts with a non-zero exit the runner detects.

CREATE OR REPLACE FUNCTION _assert(cond boolean, msg text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'ASSERT FAILED: %', msg; END IF;
END $$;

-- Null-safe equality on text-cast values (IS DISTINCT FROM treats NULLs as values).
CREATE OR REPLACE FUNCTION _assert_eq(actual text, expected text, msg text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'ASSERT FAILED: % — got [%], want [%]', msg, actual, expected;
  END IF;
END $$;
