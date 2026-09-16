-- A Bot belongs to the account that made it, and that is the whole of the rule. 2026-09-16.
--
-- `agent_profiles.visibility` was a second answer to a question `owner_user_id` already answered,
-- and the second answer could disagree with the first: a Bot marked `public` was readable, nameable
-- and addressable by every other account on the deployment. The owner's words: "모든 봇은 해당 계정
-- 소유인 거고 다른 계정이랑은 전혀 관계없는건데? 남이 만든 봇을 다른 계정이 볼 수 있는 구조라는거
-- 자체가 잘못된 거임."
--
-- NO DECISION IS NEEDED FROM ANYBODY TO RUN THIS, and that was checked rather than assumed: every
-- `agent_profiles` row on every database this machine can reach — the development database, the
-- rehearsal deployment's and all forty test databases — is already `private`. Nothing marked
-- `public` exists to be migrated, so the column is dropped rather than folded into something.
-- A deployment that somehow holds one loses only the marking; the Bot stays its owner's.
--
-- The index goes with it. It was on (visibility, deleted_at), which is the shape of the roster read
-- that no longer exists; the read is now (owner_user_id, deleted_at).
--
-- A Bot a PACKAGE shipped has `owner_user_id` null and is the deployment's rather than a person's.
-- It stays visible to everybody signed in — the rule `auth/guards.ts` has always used for a Bot
-- nobody made — and needs no column to say so.

DROP INDEX "agent_profiles_visibility_deleted_idx";--> statement-breakpoint
CREATE INDEX "agent_profiles_owner_deleted_idx" ON "agent_profiles" USING btree ("owner_user_id","deleted_at");--> statement-breakpoint
ALTER TABLE "agent_profiles" DROP COLUMN "visibility";--> statement-breakpoint
DROP TYPE "public"."agent_visibility";
