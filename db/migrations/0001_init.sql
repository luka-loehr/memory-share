-- memory-share schema
--
-- One separation carries the whole design: an ASSET is bytes that exist in R2,
-- a MEMORY is a curated view over some of them. Deleting a memory deletes the
-- view, never the bytes. The same photograph can appear in any number of
-- memories and is stored exactly once.

-- ---------------------------------------------------------------- assets ----
-- One row per distinct file in the pool. Identity is the content hash, so
-- uploading the same photo twice — from a different folder, a different phone,
-- a re-run of an interrupted upload — is a no-op rather than a duplicate.
CREATE TABLE assets (
  id                TEXT PRIMARY KEY,          -- sha256 of the original, hex
  filename          TEXT NOT NULL,             -- as it came off the device
  kind              TEXT NOT NULL CHECK (kind IN ('photo', 'video')),
  mime              TEXT NOT NULL,

  bytes             INTEGER NOT NULL,
  width             INTEGER NOT NULL DEFAULT 0,
  height            INTEGER NOT NULL DEFAULT 0,
  duration          REAL,                      -- seconds, videos only

  taken_at          INTEGER,                   -- epoch seconds, EXIF or mtime

  -- orig is byte-identical to the source and is what downloads serve.
  --
  -- PHOTOS store no derivatives: thumb and view are produced on the fly by the
  -- Cloudflare Images binding straight from orig, so view_key stays NULL and
  -- derive_state is 'skipped' from the moment the row is written.
  --
  -- VIDEOS get one stored derivative, view/<sha>.mp4, transcoded LOCALLY by
  -- the CLI (which ships its own ffmpeg) and uploaded alongside the original.
  -- There is no server-side transcoding anywhere in this system. view_key is
  -- NULL only while an upload is still in flight.
  orig_key          TEXT NOT NULL,
  view_key          TEXT,   -- view/<id>.mp4,  video only
  thumb_key         TEXT,   -- thumb/<id>.jpg, video only (poster frame)
  view_is_original  INTEGER NOT NULL DEFAULT 0,

  -- Derivative pipeline state, so an interrupted or failed job is visible and
  -- retryable rather than silently leaving an asset unviewable. Photos are
  -- written 'skipped'; a video is 'ready' once its proxy lands, or 'skipped'
  -- when the original is already browser-safe H.264 within 1080p.
  derive_state      TEXT NOT NULL DEFAULT 'pending'
                      CHECK (derive_state IN ('pending','running','ready','failed','skipped')),
  derive_error      TEXT,
  derive_attempts   INTEGER NOT NULL DEFAULT 0,

  created_at        INTEGER NOT NULL
);

CREATE INDEX assets_taken   ON assets (taken_at);
CREATE INDEX assets_state   ON assets (derive_state);

-- ------------------------------------------------------------------ tags ----
-- Tags, not folders: one photo belongs to "croatia" AND "with-mom" at once,
-- which is what makes "5 from Croatia + 5 from Turkey" a query rather than a
-- copy. Tag names are lowercase slugs.
CREATE TABLE tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

CREATE TABLE asset_tags (
  asset_id  TEXT    NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  tag_id    INTEGER NOT NULL REFERENCES tags (id)   ON DELETE CASCADE,
  PRIMARY KEY (asset_id, tag_id)
);

CREATE INDEX asset_tags_by_tag ON asset_tags (tag_id);

-- -------------------------------------------------------------- memories ----
-- A shareable album. `slug` is the URL segment; the password is stored as a
-- PBKDF2 digest so the plaintext never lands in the database.
CREATE TABLE memories (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  note            TEXT,                        -- optional line shown on the gate

  password_hash   TEXT NOT NULL,               -- pbkdf2$<iters>$<salt_b64>$<hash_b64>
  cover_asset_id  TEXT REFERENCES assets (id) ON DELETE SET NULL,

  -- Whether recipients may pull the untouched originals, or only stream the
  -- derivatives. Some memories you want seen, not copied.
  allow_download  INTEGER NOT NULL DEFAULT 1,

  expires_at      INTEGER,                     -- NULL = never expires
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX memories_created ON memories (created_at);

-- --------------------------------------------------------- memory_assets ----
-- The join that makes a memory a *view*. ON DELETE CASCADE reaches here from
-- memories, so dropping a memory drops only these rows — the assets and the R2
-- objects behind them are untouched. That is the entire point of the system.
CREATE TABLE memory_assets (
  memory_id  TEXT NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
  asset_id   TEXT NOT NULL REFERENCES assets (id)   ON DELETE CASCADE,
  position   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (memory_id, asset_id)
);

CREATE INDEX memory_assets_by_memory ON memory_assets (memory_id, position);
CREATE INDEX memory_assets_by_asset  ON memory_assets (asset_id);

-- ---------------------------------------------------------------- access ----
-- Append-only log of gate attempts, so the owner can see whether a link was
-- ever opened. Deliberately records no IP address and no user agent.
CREATE TABLE access_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id  TEXT NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
  at         INTEGER NOT NULL,
  outcome    TEXT NOT NULL CHECK (outcome IN ('unlocked', 'rejected'))
);

CREATE INDEX access_log_memory ON access_log (memory_id, at);
