-- Timestamps are Unix milliseconds in UTC. collected_at is fetch time, not measurement time.
-- The primary key also supports per-device time-range queries and idempotent cron replay.
CREATE TABLE readings (
  device_id TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  collected_at INTEGER NOT NULL,
  device_name TEXT NOT NULL,
  temperature_c REAL,
  humidity_percent REAL CHECK (humidity_percent BETWEEN 0 AND 100),
  online INTEGER CHECK (online IN (0, 1)),
  PRIMARY KEY (device_id, scheduled_at),
  CHECK (online IS 1 OR (temperature_c IS NULL AND humidity_percent IS NULL))
);
