-- Migration: Add indexes to speed up user search by username or display_name

CREATE INDEX IF NOT EXISTS idx_users_username_lower
  ON users ((LOWER(username)));

CREATE INDEX IF NOT EXISTS idx_users_display_name_lower
  ON users ((LOWER(display_name)));


