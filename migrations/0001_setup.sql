-- Setup state only. Never store OAuth/enterprise tokens or device information.
CREATE TABLE setup_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL CHECK (status IN ('idle', 'starting', 'awaiting_signup', 'creating', 'created', 'needs_review')),
  state_hash TEXT,
  admin_sub TEXT,
  expires_at INTEGER,
  signup_name TEXT,
  enterprise_name TEXT
);
INSERT INTO setup_state (id, status) VALUES (1, 'idle');
