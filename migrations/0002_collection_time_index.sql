-- Support per-device collection windows and latest-reading lookups.
-- scheduled_at provides a deterministic tie-breaker for equal fetch timestamps.
CREATE INDEX IF NOT EXISTS readings_device_collected_at
  ON readings (device_id, collected_at, scheduled_at);
