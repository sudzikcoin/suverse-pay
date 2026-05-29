-- 003_dashboard.sql — Phase 5 Block 4 Sub-task 1.
--
-- Adds the storage that backs the customer dashboard at
-- suverse-pay.suverse.io. Two tables:
--
--   * dashboard_users           — one row per OAuth-authenticated
--                                 customer. Identified by
--                                 (oauth_provider, oauth_provider_id).
--   * dashboard_user_resource_keys
--                               — many-to-many between dashboard
--                                 users and the existing
--                                 resource_api_keys table. Lets a
--                                 single OAuth user manage multiple
--                                 API keys (typical for ops people
--                                 running several projects).
--
-- Note: the existing resource_api_keys table uses TEXT primary
-- keys (e.g. "reskey_<8hex>"), NOT UUID. The link table FKs
-- against that TEXT id to stay consistent with the rest of the
-- schema. The dashboard tables themselves are UUID-keyed because
-- they're new and have no log-grep convention to honour.


CREATE TABLE IF NOT EXISTS dashboard_users (
  id                  UUID PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,
  oauth_provider      TEXT NOT NULL
                        CHECK (oauth_provider IN ('google', 'github')),
  oauth_provider_id   TEXT NOT NULL,
  display_name        TEXT,
  avatar_url          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Composite unique avoids the cross-provider collision where two
  -- providers happen to issue the same provider-side id for
  -- different humans. Email is also unique above, which catches the
  -- "same human signs in via Google then GitHub" case as a
  -- duplicate-row violation — desired: the dashboard policy is one
  -- user record per email, the first provider used wins.
  UNIQUE (oauth_provider, oauth_provider_id)
);

CREATE INDEX IF NOT EXISTS dashboard_users_email_idx
  ON dashboard_users (email);

CREATE TABLE IF NOT EXISTS dashboard_user_resource_keys (
  id                  UUID PRIMARY KEY,
  user_id             UUID NOT NULL
                        REFERENCES dashboard_users(id) ON DELETE CASCADE,
  resource_key_id     TEXT NOT NULL
                        REFERENCES resource_api_keys(id) ON DELETE CASCADE,
  linked_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, resource_key_id)
);

CREATE INDEX IF NOT EXISTS dashboard_user_resource_keys_user_id_idx
  ON dashboard_user_resource_keys (user_id);
CREATE INDEX IF NOT EXISTS dashboard_user_resource_keys_resource_key_idx
  ON dashboard_user_resource_keys (resource_key_id);
