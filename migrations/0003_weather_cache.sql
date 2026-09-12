-- One bounded weather snapshot per configured location; no sensor data is modified.
CREATE TABLE IF NOT EXISTS weather_cache (
  location_key TEXT PRIMARY KEY,
  attempted_at INTEGER NOT NULL,
  payload TEXT
);
