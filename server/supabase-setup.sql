-- ================================================
-- Snuggle Analytics — Supabase Database Setup
-- Run this SQL in Supabase's SQL Editor once.
-- ================================================

-- Create the analytics events table
CREATE TABLE IF NOT EXISTS analytics_events (
  id              BIGSERIAL PRIMARY KEY,
  event_type      TEXT NOT NULL,
  data            JSONB DEFAULT '{}',
  ip_address      TEXT,
  user_agent      TEXT,
  referrer        TEXT,
  country         TEXT,
  device_type     TEXT,
  browser         TEXT,
  os              TEXT,
  language        TEXT,
  screen_width    INTEGER,
  screen_height   INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for fast querying
CREATE INDEX IF NOT EXISTS idx_analytics_event_type ON analytics_events (event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_created_at  ON analytics_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_ip_address  ON analytics_events (ip_address);

-- Disable Row Level Security so the service role key can insert freely
-- (the service role key is kept server-side only — never exposed to clients)
ALTER TABLE analytics_events DISABLE ROW LEVEL SECURITY;

-- Optional: auto-delete events older than 90 days to keep storage in check
-- (comment this out if you want to keep all data forever)
-- You can run this manually or set up a Supabase CRON job:
-- DELETE FROM analytics_events WHERE created_at < NOW() - INTERVAL '90 days';
