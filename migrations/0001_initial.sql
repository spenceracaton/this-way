PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS seasons (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  year INTEGER,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json))
);

CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY NOT NULL,
  neighborhood_id TEXT,
  address TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  address_match_json TEXT CHECK (address_match_json IS NULL OR json_valid(address_match_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY NOT NULL,
  location_id TEXT NOT NULL REFERENCES locations(id),
  season_id TEXT NOT NULL REFERENCES seasons(id),
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
  custom_tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(custom_tags_json)),
  level INTEGER NOT NULL DEFAULT 0,
  featured INTEGER,
  sharing_consent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','pending','hidden','rejected','archived')),
  version INTEGER NOT NULL DEFAULT 1,
  approval_method TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewed_by TEXT,
  review_reason TEXT,
  client_request_id TEXT UNIQUE,
  payload_hash TEXT,
  source_metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(source_metadata_json))
);
CREATE INDEX IF NOT EXISTS listings_visible_season ON listings(status, season_id, created_at, id);
CREATE INDEX IF NOT EXISTS listings_location_season ON listings(location_id, season_id);

CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY NOT NULL,
  listing_id TEXT NOT NULL REFERENCES listings(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','removed')),
  client_request_id TEXT UNIQUE,
  object_key TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  media_type TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  fit TEXT NOT NULL DEFAULT 'cover',
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewed_by TEXT,
  review_reason TEXT,
  removed_at INTEGER,
  source_metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(source_metadata_json))
);
CREATE INDEX IF NOT EXISTS photos_listing_status_position ON photos(listing_id, status, position, id);
CREATE INDEX IF NOT EXISTS photos_content_hash ON photos(listing_id, content_hash);

CREATE TABLE IF NOT EXISTS source_mappings (
  source_system TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_season_id TEXT NOT NULL DEFAULT '',
  canonical_id TEXT NOT NULL,
  source_version TEXT,
  source_checksum TEXT NOT NULL,
  source_snapshot_json TEXT NOT NULL CHECK (json_valid(source_snapshot_json)),
  last_imported_version INTEGER,
  imported_at INTEGER NOT NULL,
  PRIMARY KEY (source_system, entity_type, source_id, source_season_id),
  UNIQUE (source_system, entity_type, canonical_id, source_season_id)
);
CREATE INDEX IF NOT EXISTS source_mappings_canonical ON source_mappings(entity_type, canonical_id);

CREATE TABLE IF NOT EXISTS review_events (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('listing','photo')),
  entity_id TEXT NOT NULL,
  old_status TEXT,
  new_status TEXT NOT NULL,
  reason TEXT,
  reviewed_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS review_events_entity_time ON review_events(entity_type, entity_id, created_at);

CREATE TRIGGER IF NOT EXISTS listings_status_review_event
AFTER UPDATE OF status ON listings
WHEN OLD.status <> NEW.status
BEGIN
  INSERT INTO review_events(entity_type, entity_id, old_status, new_status, reason, reviewed_by, created_at)
  VALUES ('listing', NEW.id, OLD.status, NEW.status, NEW.review_reason, NEW.reviewed_by, COALESCE(NEW.reviewed_at, NEW.updated_at));
END;

CREATE TRIGGER IF NOT EXISTS photos_status_review_event
AFTER UPDATE OF status ON photos
WHEN OLD.status <> NEW.status
BEGIN
  INSERT INTO review_events(entity_type, entity_id, old_status, new_status, reason, reviewed_by, created_at)
  VALUES ('photo', NEW.id, OLD.status, NEW.status, NEW.review_reason, NEW.reviewed_by, COALESCE(NEW.reviewed_at, NEW.removed_at, NEW.created_at));
END;

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY NOT NULL,
  listing_id TEXT NOT NULL REFERENCES listings(id),
  season_id TEXT NOT NULL REFERENCES seasons(id),
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  dismissed_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS reports_created ON reports(created_at, id);

CREATE TABLE IF NOT EXISTS heart_counts (
  listing_id TEXT PRIMARY KEY NOT NULL REFERENCES listings(id),
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS upload_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL,
  listing_id TEXT NOT NULL REFERENCES listings(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS upload_tokens_expires ON upload_tokens(expires_at);

CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY NOT NULL,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS request_limits (
  key TEXT PRIMARY KEY NOT NULL,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS request_limits_window ON request_limits(window_start);
