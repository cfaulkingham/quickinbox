CREATE TABLE chat_conversations (
 id TEXT PRIMARY KEY,
 direct_key TEXT UNIQUE,
 title TEXT NOT NULL DEFAULT '',
 created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE chat_members (
 conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 last_read_seq INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX chat_members_user ON chat_members(user_id);
CREATE TABLE chat_messages (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
 sender_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX chat_messages_conversation ON chat_messages(conversation_id, seq);
CREATE INDEX chat_messages_sender_created ON chat_messages(sender_id, created_at);
CREATE TABLE meetings (
 id TEXT PRIMARY KEY,
 owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 conversation_id TEXT REFERENCES chat_conversations(id) ON DELETE SET NULL,
 title TEXT NOT NULL,
 provider_id TEXT UNIQUE,
 guests_allowed INTEGER NOT NULL DEFAULT 0 CHECK (guests_allowed IN (0,1)),
 audio_only INTEGER NOT NULL DEFAULT 0 CHECK (audio_only IN (0,1)),
 expires_at TEXT NOT NULL,
 ended_at TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX meetings_owner ON meetings(owner_id, created_at);
CREATE INDEX meetings_conversation ON meetings(conversation_id, created_at);
CREATE TABLE meeting_join_attempts (
 id TEXT PRIMARY KEY,
 meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX meeting_join_attempts_meeting ON meeting_join_attempts(meeting_id, created_at);
