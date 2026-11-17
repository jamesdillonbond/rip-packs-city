-- watchlist: saved moments per owner_key
CREATE TABLE IF NOT EXISTS watchlist (
  id bigserial PRIMARY KEY,
  owner_key text NOT NULL,
  edition_key text NOT NULL,
  player_name text,
  set_name text,
  series_number integer,
  tier text,
  thumbnail_url text,
  notes text,
  added_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT watchlist_owner_edition_unique UNIQUE (owner_key, edition_key)
);
CREATE INDEX IF NOT EXISTS watchlist_owner_key_idx ON watchlist (owner_key);
ALTER TABLE watchlist ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON watchlist
  USING (true) WITH CHECK (true);

-- fmv_alerts: price alert triggers per owner_key + edition
CREATE TABLE IF NOT EXISTS fmv_alerts (
  id bigserial PRIMARY KEY,
  owner_key text NOT NULL,
  edition_key text NOT NULL,
  player_name text,
  set_name text,
  alert_type text NOT NULL CHECK (alert_type IN ('below_fmv_pct', 'below_price')),
  threshold numeric NOT NULL,
  channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'telegram', 'both')),
  notification_email text,
  active boolean NOT NULL DEFAULT true,
  last_triggered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fmv_alerts_owner_edition_type_unique UNIQUE (owner_key, edition_key, alert_type)
);
CREATE INDEX IF NOT EXISTS fmv_alerts_owner_key_idx ON fmv_alerts (owner_key);
CREATE INDEX IF NOT EXISTS fmv_alerts_active_idx ON fmv_alerts (active) WHERE active = true;
ALTER TABLE fmv_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON fmv_alerts
  USING (true) WITH CHECK (true);
