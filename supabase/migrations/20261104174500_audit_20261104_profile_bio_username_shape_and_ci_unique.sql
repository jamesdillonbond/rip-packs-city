-- audit_20261104_profile_bio_username_shape_and_ci_unique
--
-- CISO pass 2026-11-04 (API authorization finding 1): profile_bio.username decides
-- who owns every owner_key-keyed private row and the public /profile/<handle> page,
-- yet POST/PATCH /api/profile/bio accepted ANY string and the only constraint was a
-- case-SENSITIVE UNIQUE. Two consequences: (a) "Trevor" and "trevor" could both exist,
-- and requireOwnedKey's case-insensitive lookup then errors on two rows and fails
-- CLOSED — a free lockout of the real owner; (b) reserved words and non-handle shapes
-- could be published as profile URLs.
--
-- Measured before apply (2026-11-04 ~8:55 AM PT): 33 usernames, 0 case collisions,
-- 0 outside ^[a-z0-9_-]{3,32}$, 0 reserved — so both constraints admit every row.
-- The route now enforces the same rule (lib/profile/username-from-topshot.ts HANDLE_RE
-- + RESERVED_HANDLES) so the CHECK is the backstop, not the first line.
--
-- Revert: DROP INDEX public.profile_bio_username_lower_key;
--         ALTER TABLE public.profile_bio DROP CONSTRAINT profile_bio_username_handle_shape;

ALTER TABLE public.profile_bio
  ADD CONSTRAINT profile_bio_username_handle_shape
  CHECK (username IS NULL OR username ~ '^[a-z0-9_-]{3,32}$') NOT VALID;
ALTER TABLE public.profile_bio VALIDATE CONSTRAINT profile_bio_username_handle_shape;

CREATE UNIQUE INDEX IF NOT EXISTS profile_bio_username_lower_key
  ON public.profile_bio (lower(username))
  WHERE username IS NOT NULL;

COMMENT ON INDEX public.profile_bio_username_lower_key IS
  'One handle per spelling, case-insensitively: requireOwnedKey resolves a key with ilike and must find at most one claimant (2026-11-04 CISO pass).';
