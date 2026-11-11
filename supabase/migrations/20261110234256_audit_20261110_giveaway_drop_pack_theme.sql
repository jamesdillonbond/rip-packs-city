-- 2026-11-10 (Trevor, on "sound and per-drop pack art": "Yes do both"; then "leave the
-- dame time pack art as is, as that's our beta").
--
-- Two PRESENTATION-ONLY columns on giveaway_drops, read by the claim page's opening
-- (app/giveaways/[slug]/PackRevealClient.tsx):
--
--   pack_theme     which pack design the drop draws. The list is lib/giveaways/pack-theme.ts
--                  (PACK_THEMES), pinned to this CHECK by __tests__/giveaway-pack-theme.test.ts.
--                  'classic' is the red pack exactly as it was before themes existed.
--   opening_sound  whether the opening plays sound for this drop (the claimer can mute it).
--
-- EVERY EXISTING DROP KEEPS ITS OPENING AS IT IS: classic, silent. That includes the open
-- beta drop dame-time-challenge-reward-pack. opening_sound is added with DEFAULT false
-- (which stamps the existing rows) and only then given DEFAULT true for drops created
-- from here on. Asserted below.
--
-- Nothing reads these columns but the page: no function, view or policy is touched, and
-- neither column is part of the seal, the deal or a claim.
--
-- Applied 2026-11-10 3:42 PM PT (0 claims on the open drop at the time). Read back after:
-- all 4 drops pack_theme = classic and opening_sound = false; column default for
-- opening_sound = true.
--
-- Revert:
--   ALTER TABLE public.giveaway_drops DROP COLUMN opening_sound, DROP COLUMN pack_theme;
--   (deploy the code revert first: lib/giveaways/store.ts selects both columns.)

ALTER TABLE public.giveaway_drops
  ADD COLUMN IF NOT EXISTS pack_theme text NOT NULL DEFAULT 'classic',
  ADD COLUMN IF NOT EXISTS opening_sound boolean NOT NULL DEFAULT false;

ALTER TABLE public.giveaway_drops
  DROP CONSTRAINT IF EXISTS giveaway_drops_pack_theme_known;
ALTER TABLE public.giveaway_drops
  ADD CONSTRAINT giveaway_drops_pack_theme_known
  CHECK (pack_theme IN ('classic', 'blackout', 'gold', 'ice', 'emerald', 'ember', 'royal'));

-- new drops get sound unless the sponsor switches it off; existing rows were stamped false above
ALTER TABLE public.giveaway_drops ALTER COLUMN opening_sound SET DEFAULT true;

COMMENT ON COLUMN public.giveaway_drops.pack_theme IS
  'Pack design drawn by the claim page (lib/giveaways/pack-theme.ts). Presentation only. 2026-11-10.';
COMMENT ON COLUMN public.giveaway_drops.opening_sound IS
  'Whether the pack opening plays sound for this drop; the claimer can mute it. Presentation only. Existing drops false, new drops default true. 2026-11-10.';

DO $$
DECLARE
  v_changed int;
BEGIN
  SELECT count(*) INTO v_changed
    FROM public.giveaway_drops
   WHERE pack_theme <> 'classic' OR opening_sound;
  IF v_changed <> 0 THEN
    RAISE EXCEPTION 'giveaway pack theme: % existing drop(s) would change their opening', v_changed;
  END IF;
END $$;
