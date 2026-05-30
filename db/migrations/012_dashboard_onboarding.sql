-- 012_dashboard_onboarding.sql — Track whether a customer has
-- dismissed the welcome / onboarding tour.
--
-- The dashboard now ships an in-app onboarding modal that walks
-- first-time users through "what is x402, here's how you earn".
-- We persist the dismissal server-side (not a cookie) so:
--   * Re-installing the browser doesn't re-prompt power users.
--   * The progress tracker on the dashboard reads the same row to
--     decide whether to render the "you have N steps left" banner.
--
-- Column is nullable — NULL means "never dismissed", a timestamp
-- means "dismissed at this point". A future column could store
-- which step they got to before skipping; for v1 boolean-ish
-- presence is enough.

ALTER TABLE dashboard_users
  ADD COLUMN IF NOT EXISTS onboarding_dismissed_at TIMESTAMPTZ;
