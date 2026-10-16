CREATE TABLE "hub_blobs" (
	"sha256" text PRIMARY KEY NOT NULL,
	"bytes" bigint NOT NULL,
	"refs" integer DEFAULT 0 NOT NULL,
	"stored_at" timestamp with time zone DEFAULT now() NOT NULL,
	"mirrored_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "hub_chunks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"text" text NOT NULL,
	"title" text,
	"visibility" text NOT NULL,
	"task_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hub_file_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"file_id" text NOT NULL,
	"version" integer NOT NULL,
	"sha256" text NOT NULL,
	"bytes" bigint NOT NULL,
	"mime" text,
	"text" text,
	"text_chars" integer,
	"by" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_file_versions_file_version" UNIQUE("file_id","version")
);
--> statement-breakpoint
CREATE TABLE "hub_files" (
	"id" text PRIMARY KEY NOT NULL,
	"folder" text DEFAULT '/' NOT NULL,
	"name" text NOT NULL,
	"visibility" text DEFAULT 'company' NOT NULL,
	"task_id" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "hub_files_visibility" CHECK ("hub_files"."visibility" = 'company' or "hub_files"."visibility" like 'me:_%' or "hub_files"."visibility" like 'task:_%')
);
--> statement-breakpoint
CREATE TABLE "hub_task_members" (
	"task_id" text NOT NULL,
	"member_id" text NOT NULL,
	CONSTRAINT "hub_task_members_task_id_member_id_pk" PRIMARY KEY("task_id","member_id")
);
--> statement-breakpoint
ALTER TABLE "hub_file_versions" ADD CONSTRAINT "hub_file_versions_file_id_hub_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."hub_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_file_versions" ADD CONSTRAINT "hub_file_versions_sha256_hub_blobs_sha256_fk" FOREIGN KEY ("sha256") REFERENCES "public"."hub_blobs"("sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_file_versions" ADD CONSTRAINT "hub_file_versions_by_hub_members_id_fk" FOREIGN KEY ("by") REFERENCES "public"."hub_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_files" ADD CONSTRAINT "hub_files_created_by_hub_members_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."hub_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_task_members" ADD CONSTRAINT "hub_task_members_member_id_hub_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."hub_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hub_chunks_source" ON "hub_chunks" USING btree ("source_id","ordinal");--> statement-breakpoint
CREATE INDEX "hub_files_folder_name" ON "hub_files" USING btree ("folder","name","id");--> statement-breakpoint
CREATE INDEX "hub_task_members_member" ON "hub_task_members" USING btree ("member_id");--> statement-breakpoint
-- Below, by hand: what drizzle-kit has no word for.
--
-- KOREAN IS SEARCHED BY SUBSTRING, as the product's conversations are (its 0065 says why, and
-- what was measured): `pg_trgm` turns an `ILIKE '%…%'` condition of three characters or
-- more into an index read. It ships in the plain `postgres:17` image and is a trusted extension,
-- so the database's owner, who runs this, may create it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "hub_chunks_text_trgm" ON "hub_chunks" USING gin ("text" gin_trgm_ops);--> statement-breakpoint
-- NOT OPTIONAL, for the reason 0065 measured: with the default statistics target `ANALYZE` of a
-- table of long Korean text ran for minutes at a full core, and autovacuum would pay that on the
-- hub's one core as the table grows. The planner has no use for a histogram of whole chunks. On
-- the column and not the index, as 0065 could not: Postgres keeps an index's own statistics only
-- for an expression, and this index is on the plain column.
ALTER TABLE "hub_chunks" ALTER COLUMN "text" SET STATISTICS 0;
--> statement-breakpoint
-- CHUNKS ARE KEPT AS THEY ARE, NOT COMPRESSED. 1,200 Korean characters are about 3.6 KB, past the
-- 2 KB at which Postgres compresses a row by default, so every row a search reads would be
-- decompressed first — and a word of two characters, which has no trigram, reads every row.
-- Measured on 10,000 chunks: the same `LIKE` scan took 103 ms compressed (pglz) and 20 ms stored
-- plain. A chunk is at most 1,200 characters, so a row stays under this target and is never
-- compressed or moved out of line; the price is the disk the compression would have saved
-- (about half, on this text).
ALTER TABLE "hub_chunks" SET (toast_tuple_target = 8160);--> statement-breakpoint
ALTER TABLE "hub_chunks" ALTER COLUMN "text" SET STORAGE MAIN;
