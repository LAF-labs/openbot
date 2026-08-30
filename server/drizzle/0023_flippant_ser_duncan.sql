ALTER TYPE "public"."credential_kind" ADD VALUE 'mcp_oauth_client';--> statement-breakpoint
ALTER TYPE "public"."credential_kind" ADD VALUE 'mcp_user_token';--> statement-breakpoint
CREATE TABLE "mcp_user_credentials" (
	"server_id" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_user_credentials_server_id_user_id_pk" PRIMARY KEY("server_id","user_id")
);
--> statement-breakpoint
-- Hand-edited: drizzle emits the bare ALTER, which Postgres refuses for text -> uuid without a
-- USING clause. Values that are not uuid-shaped are nulled first rather than failing the whole
-- migration: this column never had a foreign key, so such a value was already a pointer to nothing.
UPDATE "mcp_servers" SET "credential_id" = NULL
  WHERE "credential_id" IS NOT NULL
    AND "credential_id" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';--> statement-breakpoint
ALTER TABLE "mcp_servers" ALTER COLUMN "credential_id" SET DATA TYPE uuid USING "credential_id"::uuid;--> statement-breakpoint
ALTER TABLE "mcp_user_credentials" ADD CONSTRAINT "mcp_user_credentials_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_user_credentials" ADD CONSTRAINT "mcp_user_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_user_credentials" ADD CONSTRAINT "mcp_user_credentials_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_user_credentials_user_idx" ON "mcp_user_credentials" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Hand-edited: the unique index below asserts at most one LIVE credential per key, and databases
-- written before this migration legitimately hold several — the old create path never rotated.
-- All but the newest per key are revoked (kept for the trail, exactly as a rotation would have
-- left them), newest decided the same way readModelSecret already breaks ties: created_at, then id.
UPDATE "credentials" SET "revoked_at" = now(), "updated_at" = now()
  WHERE "revoked_at" IS NULL
    AND "id" NOT IN (
      SELECT DISTINCT ON ("kind", "provider", "key_id") "id"
        FROM "credentials"
       WHERE "revoked_at" IS NULL
       ORDER BY "kind", "provider", "key_id", "created_at" DESC, "id" DESC
    );--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_active_key_idx" ON "credentials" USING btree ("kind","provider","key_id") WHERE "credentials"."revoked_at" IS NULL;