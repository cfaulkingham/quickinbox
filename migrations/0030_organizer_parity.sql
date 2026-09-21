ALTER TABLE contacts ADD COLUMN birthday TEXT NOT NULL DEFAULT '';
ALTER TABLE contacts ADD COLUMN groups_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE personal_calendars (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#729681',
  UNIQUE(user_id, name)
);
CREATE INDEX personal_calendars_owner ON personal_calendars(user_id);
CREATE TABLE organizer_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  time_zone TEXT NOT NULL
);

-- Index the last occurrence so a bounded range query can find entire series.
ALTER TABLE calendar_events ADD COLUMN range_end TEXT;
UPDATE calendar_events SET range_end = ends_at;
CREATE INDEX calendar_events_series_range ON calendar_events(user_id, range_end, starts_at);

ALTER TABLE calendar_reminders RENAME TO calendar_reminders_old;
CREATE TABLE calendar_reminders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  event_version INTEGER NOT NULL,
  occurrence_key TEXT NOT NULL DEFAULT '',
  minutes INTEGER NOT NULL,
  due_at TEXT NOT NULL,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  notified_at TEXT,
  dismissed_at TEXT,
  UNIQUE(event_id, occurrence_key, minutes)
);
INSERT INTO calendar_reminders
  (id, user_id, event_id, event_version, minutes, due_at, title, starts_at, ends_at, notified_at, dismissed_at)
SELECT r.id, r.user_id, r.event_id, r.event_version,
  CAST(COALESCE(json_extract(e.data_json, '$.reminderMinutes'), 10) AS INTEGER),
  r.due_at, r.title, r.starts_at, e.ends_at, r.notified_at, r.dismissed_at
FROM calendar_reminders_old r JOIN calendar_events e ON e.id = r.event_id;
DROP TABLE calendar_reminders_old;
CREATE INDEX calendar_reminders_due ON calendar_reminders(due_at, notified_at);
CREATE INDEX calendar_reminders_owner ON calendar_reminders(user_id, dismissed_at, notified_at);
