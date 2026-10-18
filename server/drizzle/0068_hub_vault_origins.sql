CREATE TABLE "hub_vault_origins" (
	"origin" text PRIMARY KEY NOT NULL,
	"first_filled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_filled_at" timestamp with time zone DEFAULT now() NOT NULL
);
