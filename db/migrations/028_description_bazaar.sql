-- 028_description_bazaar.sql — keyword-dense short description for CDP Bazaar.
--
-- CDP's /discovery/merchant feed silently caps `description` at ~320
-- ASCII chars (empirically — schema-level cap, not documented). Our
-- catalog rows already carry a long-form (~1500 char) marketing
-- description that we serve verbatim on
-- suverse-pay.suverse.io/api/catalog/listings.json — but the same
-- string flows through to CDP's `paymentRequirements.description` on
-- every 402 challenge, where it gets truncated mid-sentence and the
-- most valuable semantic-search keywords (memecoin lists, DEX names,
-- "AI agent", etc.) get cut off.
--
-- Split the concern: keep the long string on `description` for our
-- catalog API; add a separate keyword-dense ≤320 char column the
-- proxy can prefer when building the 402 challenge sent to CDP.
--
-- Both tables get the column so the dashboard publish flow can edit
-- it independently from the long-form text:
--   * `seller_proxy_configs.description_bazaar` is the source of
--     truth read by the proxy when handling 402 challenges.
--   * `catalog_listings.description_bazaar` is its mirror so the
--     public catalog API can expose what CDP actually sees (and so
--     the dashboard can sync the two without a join).
--
-- VARCHAR(320) is enforced at the DB layer because CDP's cutoff is
-- non-negotiable — letting longer strings into the column would just
-- defer the truncation to CDP and re-introduce the original bug.

ALTER TABLE seller_proxy_configs
  ADD COLUMN IF NOT EXISTS description_bazaar VARCHAR(320);

ALTER TABLE catalog_listings
  ADD COLUMN IF NOT EXISTS description_bazaar VARCHAR(320);
