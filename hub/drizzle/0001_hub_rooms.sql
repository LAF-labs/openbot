CREATE TABLE "hub_messages" (
	"room_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"by" text NOT NULL,
	"text" text NOT NULL,
	"mentions" text[] DEFAULT '{}'::text[] NOT NULL,
	"run_id" text,
	"files" text[] DEFAULT '{}'::text[] NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_messages_room_id_seq_pk" PRIMARY KEY("room_id","seq"),
	CONSTRAINT "hub_messages_by" CHECK ("hub_messages"."by" ~ '^(m|bot):.+$')
);
--> statement-breakpoint
CREATE TABLE "hub_room_members" (
	"room_id" text NOT NULL,
	"member_id" text NOT NULL,
	"added_by" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_room_members_room_id_member_id_pk" PRIMARY KEY("room_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "hub_rooms" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hub_messages" ADD CONSTRAINT "hub_messages_room_id_hub_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."hub_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_room_members" ADD CONSTRAINT "hub_room_members_room_id_hub_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."hub_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_room_members" ADD CONSTRAINT "hub_room_members_member_id_hub_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."hub_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_room_members" ADD CONSTRAINT "hub_room_members_added_by_hub_members_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."hub_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_rooms" ADD CONSTRAINT "hub_rooms_created_by_hub_members_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."hub_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hub_room_members_member" ON "hub_room_members" USING btree ("member_id");