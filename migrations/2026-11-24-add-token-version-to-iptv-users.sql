-- Session revocation: tokens embed the user's token_version; bumping it
-- invalidates every outstanding token for that user. Old tokens (no version
-- field) are treated as version 0, so this migration logs nobody out.
ALTER TABLE iptv_users ADD COLUMN token_version INT NOT NULL DEFAULT 0;
