-- Latest retrieved hourly model estimate, isolated by configured location.
CREATE TABLE IF NOT EXISTS weather_history (
  location_key TEXT NOT NULL,
  valid_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  temperature_c REAL,
  humidity_percent REAL,
  PRIMARY KEY (location_key, valid_at)
);
