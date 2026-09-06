-- Consent to the terms and the privacy policy, 2026-09-06.
--
-- The first screen of the product now says that continuing means agreeing, and the call that marks
-- onboarding stamps when that happened and which version of the text was on the page. Two columns
-- rather than one: a timestamp alone cannot answer "which text did they agree to" once the text has
-- changed, and the version alone cannot answer "when". Both nullable — everybody who joined before
-- the text existed never saw it, and a backfilled stamp would be a consent nobody gave.

ALTER TABLE "users" ADD COLUMN "consented_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "consent_version" text;
