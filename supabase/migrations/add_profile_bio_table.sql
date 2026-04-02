-- Migration: Ensure profile_bio table exists with avatar_url column
-- Supports user profiles with display name, tagline, socials, and avatar

CREATE TABLE IF NOT EXISTS profile_bio (
  owner_key TEXT PRIMARY KEY,
  display_name TEXT,
  tagline TEXT,
  favorite_team TEXT,
  twitter TEXT,
  discord TEXT,
  avatar_url TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- If table already exists but avatar_url column is missing, add it
ALTER TABLE profile_bio
  ADD COLUMN IF NOT EXISTS avatar_url TEXT;
