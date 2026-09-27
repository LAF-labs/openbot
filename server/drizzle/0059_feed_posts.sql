CREATE TABLE "laf_feed_posts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"routine_id" text,
	"run_id" text,
	"topic" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_at" timestamp with time zone,
	"liked_at" timestamp with time zone,
	"hidden_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "laf_routines" ADD COLUMN "delivery" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "laf_feed_posts" ADD CONSTRAINT "laf_feed_posts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laf_feed_posts" ADD CONSTRAINT "laf_feed_posts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laf_feed_posts" ADD CONSTRAINT "laf_feed_posts_routine_id_laf_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."laf_routines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "laf_feed_posts_user_created_idx" ON "laf_feed_posts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "laf_feed_posts_routine_idx" ON "laf_feed_posts" USING btree ("routine_id");