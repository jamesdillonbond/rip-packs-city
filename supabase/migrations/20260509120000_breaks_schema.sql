-- Pack-breaks v0 scaffold (TopShot only — AllDay/Pinnacle/Golazos/UFC follow same pattern).
--
-- Five tables: breaks (canonical break record), break_pack_inventory (the
-- packs RPC has acquired and will rip in the break), break_spots (paid
-- buyer slots), break_distributions (the on-chain multi-transfer batches
-- a complete break is split into), break_results (per-moment-per-spot
-- distribution outcome).
--
-- All five tables have RLS enabled. Service role gets ALL on every table.
-- Public read is restricted to breaks/results once selling has begun.
-- Authenticated users can read their own break_spots row.

-- ── breaks ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.breaks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id uuid NOT NULL REFERENCES public.collections(id),
  format text NOT NULL CHECK (format IN ('personal', 'team_draft', 'random_team', 'razz', 'division')),
  pack_dist_id text,
  pack_count int NOT NULL DEFAULT 1,
  price_per_spot_usd numeric(10,2) NOT NULL,
  total_spots int NOT NULL CHECK (total_spots > 0),
  scheduled_at timestamptz NOT NULL,
  livestream_url text,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'selling', 'locked', 'ripping', 'distributing', 'complete', 'refunded', 'cancelled')),
  hot_wallet_addr text NOT NULL,
  draft_seed_block_height bigint,
  draft_seed_target_height bigint,
  draft_seed_source text,
  team_pool jsonb,
  draft_assignment jsonb,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  ripped_at timestamptz,
  drafted_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_breaks_status ON public.breaks(status);
CREATE INDEX IF NOT EXISTS idx_breaks_scheduled_at ON public.breaks(scheduled_at);

-- ── break_pack_inventory ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.break_pack_inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_nft_id text NOT NULL UNIQUE,
  collection_id uuid NOT NULL REFERENCES public.collections(id),
  dist_id text NOT NULL,
  pack_name text,
  pack_type text,
  price_paid_usd numeric(10,2),
  acquired_at timestamptz NOT NULL DEFAULT now(),
  assigned_break_id uuid REFERENCES public.breaks(id),
  opened_at timestamptz,
  open_tx_hash text,
  notes text
);

CREATE INDEX IF NOT EXISTS idx_break_pack_inventory_assigned ON public.break_pack_inventory(assigned_break_id);
CREATE INDEX IF NOT EXISTS idx_break_pack_inventory_unopened ON public.break_pack_inventory(opened_at) WHERE opened_at IS NULL;

-- ── break_spots ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.break_spots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  break_id uuid NOT NULL REFERENCES public.breaks(id) ON DELETE CASCADE,
  spot_index int NOT NULL,
  customer_email text NOT NULL,
  customer_wallet text NOT NULL,
  customer_user_id uuid REFERENCES auth.users(id),
  team_assignment text,
  payment_intent_id text,
  payment_status text NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'authorized', 'captured', 'refunded', 'failed')),
  capability_validated bool DEFAULT false,
  capability_validated_at timestamptz,
  refund_status text,
  refund_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (break_id, spot_index)
);

CREATE INDEX IF NOT EXISTS idx_break_spots_break_id ON public.break_spots(break_id);
CREATE INDEX IF NOT EXISTS idx_break_spots_customer_wallet ON public.break_spots(customer_wallet);

-- ── break_distributions ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.break_distributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  break_id uuid NOT NULL REFERENCES public.breaks(id) ON DELETE CASCADE,
  chunk_index int NOT NULL,
  recipient_count int NOT NULL,
  moment_count int NOT NULL,
  tx_hash text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'broadcast', 'sealed', 'failed')),
  error_message text,
  broadcast_at timestamptz,
  sealed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (break_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_break_distributions_break_id ON public.break_distributions(break_id);

-- ── break_results ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.break_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  break_id uuid NOT NULL REFERENCES public.breaks(id) ON DELETE CASCADE,
  spot_id uuid NOT NULL REFERENCES public.break_spots(id) ON DELETE CASCADE,
  pack_inventory_id uuid REFERENCES public.break_pack_inventory(id),
  moment_id text NOT NULL,
  set_id int,
  play_id int,
  player_name text,
  team text,
  tier text,
  serial_number int,
  fmv_at_distribution numeric(12,2),
  distribution_id uuid REFERENCES public.break_distributions(id),
  transfer_status text NOT NULL DEFAULT 'pending' CHECK (transfer_status IN ('pending', 'transferred', 'failed')),
  transfer_tx_hash text,
  transferred_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_break_results_break_id ON public.break_results(break_id);
CREATE INDEX IF NOT EXISTS idx_break_results_spot_id ON public.break_results(spot_id);
CREATE INDEX IF NOT EXISTS idx_break_results_distribution_id ON public.break_results(distribution_id);
CREATE INDEX IF NOT EXISTS idx_break_results_pending ON public.break_results(transfer_status) WHERE transfer_status = 'pending';

-- ── RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE public.breaks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.break_pack_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.break_spots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.break_distributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.break_results ENABLE ROW LEVEL SECURITY;

-- Service role: full access on every table.
DROP POLICY IF EXISTS breaks_service_all ON public.breaks;
CREATE POLICY breaks_service_all ON public.breaks
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS break_pack_inventory_service_all ON public.break_pack_inventory;
CREATE POLICY break_pack_inventory_service_all ON public.break_pack_inventory
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS break_spots_service_all ON public.break_spots;
CREATE POLICY break_spots_service_all ON public.break_spots
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS break_distributions_service_all ON public.break_distributions;
CREATE POLICY break_distributions_service_all ON public.break_distributions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS break_results_service_all ON public.break_results;
CREATE POLICY break_results_service_all ON public.break_results
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Public read: breaks once selling has begun (everything before that is internal).
DROP POLICY IF EXISTS breaks_public_read ON public.breaks;
CREATE POLICY breaks_public_read ON public.breaks
  FOR SELECT TO anon, authenticated
  USING (status IN ('selling', 'locked', 'ripping', 'distributing', 'complete'));

-- Public read: break_results only after distribution has begun on the parent break.
DROP POLICY IF EXISTS break_results_public_read ON public.break_results;
CREATE POLICY break_results_public_read ON public.break_results
  FOR SELECT TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.breaks b
      WHERE b.id = break_results.break_id
        AND b.status IN ('distributing', 'complete')
    )
  );

-- Authenticated read: a user can see their own break_spots row.
DROP POLICY IF EXISTS break_spots_owner_read ON public.break_spots;
CREATE POLICY break_spots_owner_read ON public.break_spots
  FOR SELECT TO authenticated
  USING (customer_user_id = auth.uid());
