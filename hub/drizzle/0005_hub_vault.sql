CREATE TABLE "hub_vault_devices" (
	"login_id" text NOT NULL,
	"vm_origin" text NOT NULL,
	"verified_by" text,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_vault_devices_login_id_vm_origin_pk" PRIMARY KEY("login_id","vm_origin")
);
--> statement-breakpoint
CREATE TABLE "hub_vault_grants" (
	"login_id" text NOT NULL,
	"member_id" text NOT NULL,
	"granted_by" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_vault_grants_login_id_member_id_pk" PRIMARY KEY("login_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "hub_vault_leases" (
	"id" text PRIMARY KEY NOT NULL,
	"login_id" text NOT NULL,
	"member_id" text NOT NULL,
	"vm_origin" text,
	"run_id" text,
	"origin" text NOT NULL,
	"exclusive" boolean NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"opened_at" timestamp with time zone,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hub_vault_logins" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"site" text,
	"origins" text[] NOT NULL,
	"wrapped_key" text NOT NULL,
	"kek_id" text NOT NULL,
	"sealed_username" text NOT NULL,
	"sealed_password" text NOT NULL,
	"concurrent" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" text,
	"changed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "hub_vault_devices" ADD CONSTRAINT "hub_vault_devices_login_id_hub_vault_logins_id_fk" FOREIGN KEY ("login_id") REFERENCES "public"."hub_vault_logins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_vault_grants" ADD CONSTRAINT "hub_vault_grants_login_id_hub_vault_logins_id_fk" FOREIGN KEY ("login_id") REFERENCES "public"."hub_vault_logins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_vault_grants" ADD CONSTRAINT "hub_vault_grants_member_id_hub_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."hub_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_vault_leases" ADD CONSTRAINT "hub_vault_leases_login_id_hub_vault_logins_id_fk" FOREIGN KEY ("login_id") REFERENCES "public"."hub_vault_logins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_vault_leases" ADD CONSTRAINT "hub_vault_leases_member_id_hub_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."hub_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hub_vault_grants_member" ON "hub_vault_grants" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "hub_vault_leases_login" ON "hub_vault_leases" USING btree ("login_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hub_vault_leases_one_exclusive" ON "hub_vault_leases" USING btree ("login_id") WHERE "hub_vault_leases"."exclusive";