-- Preserve existing display reports while adding private visitor feedback.
CREATE TABLE reports_next (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('report','feedback')),
  listing_id TEXT REFERENCES listings(id),
  season_id TEXT NOT NULL REFERENCES seasons(id),
  reason TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  contact_email TEXT NOT NULL DEFAULT '',
  client_request_id TEXT UNIQUE,
  payload_hash TEXT,
  created_at INTEGER NOT NULL,
  dismissed_at INTEGER,
  reviewed_by TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  CHECK ((kind = 'report' AND listing_id IS NOT NULL) OR (kind = 'feedback' AND listing_id IS NULL))
);
INSERT INTO reports_next(id,kind,listing_id,season_id,message,created_at,dismissed_at,version)
  SELECT id,'report',listing_id,season_id,message,created_at,dismissed_at,version FROM reports;
DROP TABLE reports;
ALTER TABLE reports_next RENAME TO reports;
CREATE INDEX reports_created ON reports(created_at,id);
CREATE INDEX reports_inbox ON reports(dismissed_at,created_at,id);
CREATE TABLE report_review_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id TEXT NOT NULL REFERENCES reports(id),
  status TEXT NOT NULL CHECK (status IN ('open','dismissed')),
  version INTEGER NOT NULL,
  reviewed_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TRIGGER reports_review_event AFTER UPDATE OF dismissed_at ON reports
WHEN (OLD.dismissed_at IS NULL) <> (NEW.dismissed_at IS NULL)
BEGIN
  INSERT INTO report_review_events(report_id,status,version,reviewed_by,created_at)
  VALUES(NEW.id,CASE WHEN NEW.dismissed_at IS NULL THEN 'open' ELSE 'dismissed' END,NEW.version,NEW.reviewed_by,CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;
