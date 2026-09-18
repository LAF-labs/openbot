-- What kind of business the person runs, and where they work every day. 2026-09-18.
--
-- The first run now asks two questions between the agreement and the first Bot — 어떤 일을 하세요?
-- and 매일 쓰는 곳 — each skippable, both answered by pressing. The answers are the person's (one
-- account per deployment), changed on Settings → 내 가게, and every Bot reads them before every run.
--
-- Catalogue keys from `shared/shop/catalogue.ts`, kept as plain text rather than an enum: the
-- catalogue will grow, and a key it drops later is skipped on read instead of failing the read
-- every run makes. On `users` rather than a table of their own, so an account deletion takes them
-- with the row and the export reads them off it.
--
-- NOTHING IS BACKFILLED. Everybody who joined before the question existed never answered it, and an
-- answer nobody gave would be told to every one of their Bots as though they had.

ALTER TABLE "users" ADD COLUMN "business_kind" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "daily_places" text[] DEFAULT '{}' NOT NULL;
