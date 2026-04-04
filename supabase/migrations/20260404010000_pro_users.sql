-- RPC Pro monetization: pro_users table
-- Tracks users with active Pro subscriptions

CREATE TABLE IF NOT EXISTS pro_users (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address text       NOT NULL UNIQUE,
  subscribed_at  timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz,
  plan           text        NOT NULL DEFAULT 'pro',
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE pro_users ENABLE ROW LEVEL SECURITY;

-- Public read policy: anyone can check pro status by wallet address
CREATE POLICY "pro_users_public_read"
  ON pro_users
  FOR SELECT
  USING (true);

-- Service role write policy: only service role can insert/update/delete
CREATE POLICY "pro_users_service_write"
  ON pro_users
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
