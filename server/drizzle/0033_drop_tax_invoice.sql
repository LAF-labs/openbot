-- 전자세금계산서 (팝빌) is dropped, 2026-09-05. The rows that named it go with the code.
--
-- NO COLUMN IS DROPPED, BECAUSE NONE WAS TAX-ONLY. `laf_partner_connections` was written generic
-- from the start — `provider`, `account`, `details` — so what 세금계산서 left behind is rows, not
-- shape. 알림톡 keeps the table unchanged, and `0031_partner_connections.sql` is not rewritten: it
-- is what a database that ran it actually did.
--
-- WHY DELETE RATHER THAN LEAVE THEM. A row whose `provider` no path can name is not dormant, it is
-- a registration this deployment still holds and can no longer show anybody, disconnect, or retire
-- on a withdrawal — `retireFor` skips a provider the build does not know. The 팝빌 회원 itself is
-- the business's own and outlives this: nothing is withdrawn at the vendor, exactly as a disconnect
-- never did.
--
-- Hand-written. `drizzle-kit generate` sees no schema change here, because there is none.

DELETE FROM "laf_partner_connections" WHERE "provider" = 'tax-invoice';
