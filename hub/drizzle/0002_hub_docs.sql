CREATE TABLE "hub_doc_blocks" (
	"doc_id" text NOT NULL,
	"id" text NOT NULL,
	"rank" text NOT NULL,
	"kind" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"attrs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"hash" text NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_doc_blocks_doc_id_id_pk" PRIMARY KEY("doc_id","id"),
	CONSTRAINT "hub_doc_blocks_kind" CHECK ("hub_doc_blocks"."kind" in ('paragraph', 'heading1', 'heading2', 'heading3', 'list', 'check', 'quote', 'code', 'divider', 'table', 'file', 'task-link'))
);
--> statement-breakpoint
CREATE TABLE "hub_doc_versions" (
	"doc_id" text NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"blocks" jsonb NOT NULL,
	"by" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_doc_versions_doc_id_version_pk" PRIMARY KEY("doc_id","version")
);
--> statement-breakpoint
CREATE TABLE "hub_docs" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"folder" text DEFAULT '/' NOT NULL,
	"visibility" text DEFAULT 'company' NOT NULL,
	"task_id" text,
	"rev" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "hub_docs_visibility" CHECK ("hub_docs"."visibility" = 'company' or "hub_docs"."visibility" like 'me:_%' or "hub_docs"."visibility" like 'task:_%')
);
--> statement-breakpoint
ALTER TABLE "hub_doc_blocks" ADD CONSTRAINT "hub_doc_blocks_doc_id_hub_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."hub_docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_doc_blocks" ADD CONSTRAINT "hub_doc_blocks_updated_by_hub_members_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."hub_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_doc_versions" ADD CONSTRAINT "hub_doc_versions_doc_id_hub_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."hub_docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_doc_versions" ADD CONSTRAINT "hub_doc_versions_by_hub_members_id_fk" FOREIGN KEY ("by") REFERENCES "public"."hub_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_docs" ADD CONSTRAINT "hub_docs_created_by_hub_members_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."hub_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_docs" ADD CONSTRAINT "hub_docs_updated_by_hub_members_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."hub_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hub_docs_updated" ON "hub_docs" USING btree ("updated_at","id");