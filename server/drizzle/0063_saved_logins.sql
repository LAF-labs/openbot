CREATE TABLE "laf_saved_logins" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"site" text,
	"origins" text[] NOT NULL,
	"wrapped_key" text NOT NULL,
	"kek_id" text NOT NULL,
	"sealed_username" text NOT NULL,
	"sealed_password" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "laf_saved_logins" ADD CONSTRAINT "laf_saved_logins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "laf_saved_logins_user_idx" ON "laf_saved_logins" USING btree ("user_id");