ALTER TABLE emails ADD COLUMN is_live_inbound INTEGER NOT NULL DEFAULT 0;
CREATE TABLE mail_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('task','followup')),
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  source_email_id TEXT REFERENCES emails(id) ON DELETE SET NULL,
  thread_id TEXT,
  due_at TEXT,
  reminder_at TEXT,
  notified_at TEXT,
  dismissed_at TEXT,
  completed_at TEXT,
  completion_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX mail_tasks_owner ON mail_tasks(user_id, completed_at, due_at);
CREATE INDEX mail_tasks_due ON mail_tasks(reminder_at, notified_at) WHERE completed_at IS NULL;
CREATE UNIQUE INDEX mail_tasks_waiting ON mail_tasks(user_id, thread_id) WHERE kind = 'followup' AND completed_at IS NULL;
CREATE TRIGGER resolve_mail_followup AFTER INSERT ON emails
WHEN NEW.direction = 'inbound' AND NEW.is_live_inbound = 1
BEGIN
  UPDATE mail_tasks SET completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    completion_reason = 'replied', version = version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE user_id = NEW.user_id AND kind = 'followup' AND completed_at IS NULL
    AND thread_id = COALESCE(NEW.thread_id, NEW.id)
    AND lower(NEW.from_addr) NOT IN (SELECT lower(address) FROM addresses WHERE user_id = NEW.user_id);
END;

ALTER TABLE emails ADD COLUMN vacation_recipient TEXT;
ALTER TABLE emails ADD COLUMN vacation_processed INTEGER NOT NULL DEFAULT 0;
CREATE INDEX emails_vacation_pending ON emails(vacation_processed, created_at) WHERE vacation_recipient IS NOT NULL;
CREATE TABLE vacation_settings (
  address_id TEXT PRIMARY KEY REFERENCES addresses(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  repeat_days INTEGER NOT NULL DEFAULT 7 CHECK(repeat_days BETWEEN 1 AND 30),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE vacation_replies (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address_id TEXT NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
  source_email_id TEXT NOT NULL UNIQUE REFERENCES emails(id) ON DELETE CASCADE,
  recipient TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','queued','failed')),
  email_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX vacation_reply_throttle ON vacation_replies(address_id, recipient, created_at);

CREATE TABLE calendar_shares (
  calendar_id TEXT NOT NULL REFERENCES personal_calendars(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK(permission IN ('read','write')),
  PRIMARY KEY(calendar_id, user_id)
);
CREATE TABLE calendar_feeds (
  calendar_id TEXT PRIMARY KEY REFERENCES personal_calendars(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE calendar_subscriptions (
  calendar_id TEXT PRIMARY KEY REFERENCES personal_calendars(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  next_refresh INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_success TEXT,
  last_error TEXT
);
CREATE TRIGGER resolve_existing_mail_followup AFTER INSERT ON mail_tasks
WHEN NEW.kind='followup' AND NEW.completed_at IS NULL
BEGIN
 UPDATE mail_tasks SET completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),completion_reason='replied',version=version+1
 WHERE id=NEW.id AND EXISTS(SELECT 1 FROM emails e WHERE e.user_id=NEW.user_id AND e.direction='inbound' AND e.is_live_inbound=1
   AND COALESCE(e.thread_id,e.id)=NEW.thread_id AND e.rowid>(SELECT rowid FROM emails WHERE id=NEW.source_email_id)
   AND lower(e.from_addr) NOT IN (SELECT lower(address) FROM addresses WHERE user_id=NEW.user_id));
END;
