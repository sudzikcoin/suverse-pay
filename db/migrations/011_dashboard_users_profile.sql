-- 011_dashboard_users_profile.sql — Extend dashboard_users with
-- richer OAuth profile data we were already receiving from the
-- providers but discarding.
--
-- Before this migration the upsert in apps/dashboard/src/lib/auth.ts
-- captured only (email, provider, providerId, display_name,
-- avatar_url). The Google/GitHub callback profile carries more —
-- handle, email_verified, locale, html_url, company, bio, location
-- — and these are non-PII-sensitive enough to keep as soft signals
-- for onboarding, segmentation, and future email delivery (we won't
-- bother sending to unverified addresses).
--
-- All columns nullable so existing rows pre-this-migration keep
-- working; they get backfilled on next sign-in via the COALESCE
-- update in upsertDashboardUser.
--
-- login_count starts at 1 for new rows and is incremented inside
-- ON CONFLICT — gives us a coarse engagement signal without a
-- separate sessions table.

ALTER TABLE dashboard_users
  ADD COLUMN IF NOT EXISTS github_username TEXT,
  ADD COLUMN IF NOT EXISTS email_verified  BOOLEAN,
  ADD COLUMN IF NOT EXISTS locale          TEXT,
  ADD COLUMN IF NOT EXISTS profile_url     TEXT,
  ADD COLUMN IF NOT EXISTS company         TEXT,
  ADD COLUMN IF NOT EXISTS bio             TEXT,
  ADD COLUMN IF NOT EXISTS location        TEXT,
  ADD COLUMN IF NOT EXISTS login_count     INTEGER NOT NULL DEFAULT 1;
