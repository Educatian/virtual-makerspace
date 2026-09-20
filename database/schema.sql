CREATE TABLE IF NOT EXISTS makerspace_users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS makerspace_rooms (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z2-9]{4,12}$'),
  created_by text NOT NULL REFERENCES makerspace_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS makerspace_room_members (
  room_code text NOT NULL REFERENCES makerspace_rooms(code) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES makerspace_users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  last_joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_code, user_id)
);

CREATE INDEX IF NOT EXISTS makerspace_room_members_user_idx
  ON makerspace_room_members (user_id, last_joined_at DESC);
