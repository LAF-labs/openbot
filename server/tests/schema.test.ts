import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  accounts,
  agentPreferences,
  agentProfiles,
  agents,
  agentVisibility,
  auditEvents,
  channelAgents,
  channelMemberships,
  channels,
  credentials,
  channelThreads,
  lafThreadMessages,
  sessions,
  userRoles,
  users,
  verifications,
} from "../src/db/schema";

describe("LAF Agent database schema", () => {
  test("defines the core runtime records", () => {
    expect(
      [
        users,
        sessions,
        accounts,
        verifications,
        userRoles,
        agents,
        channels,
        channelMemberships,
        channelAgents,
        credentials,
        auditEvents,
        channelThreads,
      ].map(getTableName),
    ).toEqual([
      "users",
      "sessions",
      "accounts",
      "verifications",
      "user_roles",
      "agents",
      "channels",
      "channel_memberships",
      "channel_agents",
      "credentials",
      "audit_events",
      "channel_threads",
    ]);
  });

  /*
   * The conversation store, and the shape that makes it append-only.
   *
   * `laf_thread_snapshots` held one jsonb array per thread and three call sites wrote it two
   * different ways; an append landing between the runner's read and its overwrite was gone. The
   * primary key is what says a message has a place in a thread rather than a place in an array, and
   * the unique index on the message id is what lets the same message arrive twice — every run hands
   * the whole history back — without becoming two.
   */
  test("stores a conversation as one append-only row per message", async () => {
    const schema = (await import("../src/db/schema")) as Record<
      string,
      unknown
    >;
    expect(schema.lafThreadSnapshots).toBeUndefined();

    const config = getTableConfig(lafThreadMessages);
    expect(getTableName(lafThreadMessages)).toBe("laf_thread_messages");
    expect(config.columns.map((column) => column.name)).toEqual([
      "thread_id",
      "seq",
      "message",
      "at",
      "run_id",
    ]);
    expect(
      config.primaryKeys.map((key) => key.columns.map((c) => c.name)),
    ).toEqual([["thread_id", "seq"]]);
    expect(
      config.indexes.map((index) => ({
        name: index.config.name,
        unique: index.config.unique,
      })),
    ).toEqual([{ name: "laf_thread_messages_message_id_idx", unique: true }]);
    // No foreign key on thread_id: a thread is an id this deployment mints, not a row.
    expect(config.foreignKeys).toHaveLength(0);
  });

  /*
   * The migration behind it, and the half of it that is a DATA migration.
   *
   * Dropping the old table without moving its rows across is every conversation in the deployment
   * gone, and it would type-check, pass every unit test, and be discovered by somebody opening the
   * app. The `INSERT … SELECT` and the self-heal for the double-encoded rows are what this asserts.
   */
  test("ships the migration that moves the conversations across", async () => {
    const migration = await readFile(
      new URL("../drizzle/0026_one_conversation_store.sql", import.meta.url),
      "utf8",
    );
    const normalized = migration.replace(/\s+/g, " ").trim();

    expect(normalized).toContain(`CREATE TABLE "laf_thread_messages"`);
    expect(normalized).toContain(
      `INSERT INTO "laf_thread_messages" ("thread_id", "seq", "message", "at")`,
    );
    // The double-encoded rows are re-parsed rather than read as an empty conversation.
    expect(normalized).toContain(`WHEN 'string' THEN`);
    expect(normalized).toContain(`DROP TABLE "laf_thread_snapshots" CASCADE`);
    // And the copy happens BEFORE the drop, which is the whole difference.
    expect(
      normalized.indexOf(`INSERT INTO "laf_thread_messages"`),
    ).toBeLessThan(normalized.indexOf(`DROP TABLE "laf_thread_snapshots"`));
    expect(normalized).toContain(
      `ALTER TABLE "intelligence_channel_mappings" RENAME TO "channel_threads"`,
    );
    expect(normalized).toContain(
      `ALTER TABLE "laf_routines" RENAME COLUMN "daily_utc" TO "daily_local"`,
    );
  });

  /*
   * The references the `laf_*` and `computer_*` tables never had.
   *
   * Deleting a Bot left its routines `enabled` and claimed on every tick, and its standing
   * allowances standing. The `onDelete` on each one is the decision, so each one is named here:
   * a routine and an allowance go with the Bot, a run record keeps its history and loses the name,
   * and a routine outlives the person who typed it.
   */
  test("names a parent for every laf_* row that has one", async () => {
    const {
      computerStandingApprovals,
      lafRoutineRuns,
      lafRoutines,
      lafThreadRuns,
    } = (await import("../src/db/schema")) as Record<string, never>;

    const references = (table: never) =>
      getTableConfig(table).foreignKeys.map((foreignKey) => {
        const reference = foreignKey.reference();
        return [
          reference.columns.map((column) => column.name).join(","),
          getTableName(reference.foreignTable),
          foreignKey.onDelete,
        ].join(" -> ");
      });

    expect(references(lafRoutines)).toEqual([
      "agent_id -> agents -> cascade",
      "created_by_id -> users -> set null",
    ]);
    expect(references(lafRoutineRuns)).toEqual([
      "routine_id -> laf_routines -> cascade",
    ]);
    expect(references(lafThreadRuns)).toEqual([
      "agent_id -> agents -> set null",
    ]);
    expect(references(computerStandingApprovals)).toEqual([
      "bot_id -> agents -> cascade",
    ]);
  });

  /*
   * The upstream knowledge plane is gone, and this is the assertion that it stays gone.
   *
   * `documents`, `chunks`, `document_acls`, `sync_runs`, `connector_cursors`,
   * `webhook_subscriptions` and `connector_instances` were created by 0000 and never written to by
   * anything. The test above used to name six of them as though they were part of the product, and
   * a list that protects dead tables is worse than no list: it makes deleting them look like
   * breaking something. Migration 0024 drops them; a schema file that reintroduces one fails here.
   *
   * `chunks.embedding` was the only `vector` column, which is the whole reason the Postgres image
   * had to carry pgvector. The image is `postgres:17` now, so a re-added vector column would not
   * merely be dead — it would fail to migrate.
   */
  test("does not define the knowledge plane it deleted", async () => {
    const schema = (await import("../src/db/schema")) as Record<
      string,
      unknown
    >;

    for (const name of [
      "documents",
      "chunks",
      "documentAcls",
      "syncRuns",
      "connectorCursors",
      "webhookSubscriptions",
      "connectorInstances",
      "lafWatchSources",
      "lafWatchEvents",
      "lafDigestLog",
    ]) {
      expect(schema[name]).toBeUndefined();
    }
  });

  /*
   * The state that belongs in memory, and the assertion that it stays out of the database.
   *
   * `computer_approvals`, `computer_repeat_calls` and `computer_repeat_reports` were the database
   * twins of the approval registry and the repeat counter, and the server wired them rather than
   * the Maps beside them. Their stated reason was several servers behind a load balancer; this
   * deployment is one API process per VM (docs/laf/deployment-model.md), so the code was arguing
   * with the decision record. Migration 0025 drops all three, and a schema file that reintroduces
   * one fails here.
   *
   * `computer_standing_approvals` is deliberately NOT in this list. An allowance whose whole point
   * is to outlive the turn must outlive the process, so it stays in the database — the test below
   * is what says so.
   */
  test("does not define the pending state it moved back into memory", async () => {
    const schema = (await import("../src/db/schema")) as Record<
      string,
      unknown
    >;

    for (const name of [
      "computerApprovals",
      "computerRepeatCalls",
      "computerRepeatReports",
    ]) {
      expect(schema[name]).toBeUndefined();
    }
    expect(schema.computerStandingApprovals).toBeDefined();
  });

  /*
   * The migration behind the assertion above. A table removed from the schema with no migration
   * behind it leaves the table standing on every database that already has it, and nothing here or
   * in the type system would say so — the same trap the pin-and-notification test below covers from
   * the other direction.
   */
  test("ships the migration that drops the three orphaned tables", async () => {
    const migration = await readFile(
      new URL("../drizzle/0025_simple_selene.sql", import.meta.url),
      "utf8",
    );
    const normalized = migration.replace(/\s+/g, " ").trim();

    for (const table of [
      "computer_approvals",
      "computer_repeat_calls",
      "computer_repeat_reports",
    ]) {
      // `IF EXISTS`, so a database created after this migration — which never had them — walks the
      // chain without stopping.
      expect(normalized).toContain(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
    expect(normalized).not.toContain(`"computer_standing_approvals"`);
  });

  test("includes Better Auth's verified Google identity records", () => {
    expect(Object.keys(users)).toContain("emailVerified");
    expect(Object.keys(sessions)).toEqual(
      expect.arrayContaining(["ipAddress", "userAgent"]),
    );
    expect(Object.keys(accounts)).toEqual(
      expect.arrayContaining(["userId", "providerId", "accountId"]),
    );
  });

  test("defines the exact agent profile and roster preference contracts", () => {
    expect([agentProfiles, agentPreferences].map(getTableName)).toEqual([
      "agent_profiles",
      "agent_preferences",
    ]);
    expect(agentVisibility.enumName).toBe("agent_visibility");
    expect(agentVisibility.enumValues).toEqual(["public", "private"]);

    const profileConfig = getTableConfig(agentProfiles);
    const preferenceConfig = getTableConfig(agentPreferences);

    expect(
      profileConfig.columns.map((column) => ({
        name: column.name,
        notNull: column.notNull,
        hasDefault: column.hasDefault,
        primary: column.primary,
      })),
    ).toEqual([
      { name: "agent_id", notNull: true, hasDefault: false, primary: true },
      {
        name: "owner_user_id",
        notNull: false,
        hasDefault: false,
        primary: false,
      },
      { name: "title", notNull: true, hasDefault: false, primary: false },
      {
        name: "role_description",
        notNull: true,
        hasDefault: false,
        primary: false,
      },
      {
        name: "avatar_seed",
        notNull: true,
        hasDefault: false,
        primary: false,
      },
      {
        // Defaulted, unlike the columns around it: every Bot that existed before this column did has
        // one, and nothing had to be backfilled. See `agentEffort`.
        name: "effort",
        notNull: true,
        hasDefault: true,
        primary: false,
      },
      {
        // The sentence deciding whether this Bot gets asked about. Defaulted to empty, which means
        // ask about everything the boundary stops — the behaviour before the column existed.
        name: "auto_review",
        notNull: true,
        hasDefault: true,
        primary: false,
      },
      {
        name: "visibility",
        notNull: true,
        hasDefault: false,
        primary: false,
      },
      {
        name: "deleted_at",
        notNull: false,
        hasDefault: false,
        primary: false,
      },
      {
        name: "created_at",
        notNull: true,
        hasDefault: true,
        primary: false,
      },
      {
        name: "updated_at",
        notNull: true,
        hasDefault: true,
        primary: false,
      },
    ]);

    expect(
      preferenceConfig.columns.map((column) => ({
        name: column.name,
        sqlType: column.getSQLType(),
        notNull: column.notNull,
        hasDefault: column.hasDefault,
        primary: column.primary,
      })),
    ).toEqual([
      {
        name: "user_id",
        sqlType: "text",
        notNull: true,
        hasDefault: false,
        primary: false,
      },
      {
        name: "agent_id",
        sqlType: "text",
        notNull: true,
        hasDefault: false,
        primary: false,
      },
      {
        name: "hidden_at",
        sqlType: "timestamp with time zone",
        notNull: false,
        hasDefault: false,
        primary: false,
      },
      {
        name: "pinned_at",
        sqlType: "timestamp with time zone",
        notNull: false,
        hasDefault: false,
        primary: false,
      },
      {
        // Defaulted true, and NOT NULL, so a Bot nobody has an opinion about still speaks up. A
        // nullable flag would make "never asked" indistinguishable from "muted" at the column.
        name: "notify",
        sqlType: "boolean",
        notNull: true,
        hasDefault: true,
        primary: false,
      },
    ]);

    expect(
      [...profileConfig.foreignKeys, ...preferenceConfig.foreignKeys].map(
        (foreignKey) => {
          const reference = foreignKey.reference();
          return {
            sourceColumns: reference.columns.map((column) => column.name),
            targetTable: getTableName(reference.foreignTable),
            targetColumns: reference.foreignColumns.map(
              (column) => column.name,
            ),
            onDelete: foreignKey.onDelete,
            onUpdate: foreignKey.onUpdate,
          };
        },
      ),
    ).toEqual([
      {
        sourceColumns: ["agent_id"],
        targetTable: "agents",
        targetColumns: ["id"],
        onDelete: "cascade",
        onUpdate: "no action",
      },
      {
        sourceColumns: ["owner_user_id"],
        targetTable: "users",
        targetColumns: ["id"],
        onDelete: "set null",
        onUpdate: "no action",
      },
      {
        sourceColumns: ["user_id"],
        targetTable: "users",
        targetColumns: ["id"],
        onDelete: "cascade",
        onUpdate: "no action",
      },
      {
        sourceColumns: ["agent_id"],
        targetTable: "agents",
        targetColumns: ["id"],
        onDelete: "cascade",
        onUpdate: "no action",
      },
    ]);

    expect(
      preferenceConfig.primaryKeys.map((primaryKey) => ({
        name: primaryKey.getName(),
        columns: primaryKey.columns.map((column) => column.name),
      })),
    ).toEqual([
      {
        name: "agent_preferences_user_id_agent_id_pk",
        columns: ["user_id", "agent_id"],
      },
    ]);

    expect(
      profileConfig.indexes.map((index) => ({
        name: index.config.name,
        columns: index.config.columns.map((column) =>
          "name" in column ? column.name : undefined,
        ),
        unique: index.config.unique,
        method: index.config.method,
      })),
    ).toEqual([
      {
        name: "agent_profiles_visibility_deleted_idx",
        columns: ["visibility", "deleted_at"],
        unique: false,
        method: "btree",
      },
    ]);
  });

  test("keeps the agent profile migration aligned with the schema", async () => {
    const migration = await readFile(
      new URL("../drizzle/0000_schema.sql", import.meta.url),
      "utf8",
    );
    const normalizedMigration = migration.replace(/\s+/g, " ").trim();

    expect(normalizedMigration).toContain(
      `CREATE TYPE "public"."agent_visibility" AS ENUM('public', 'private')`,
    );
    expect(normalizedMigration).toContain(
      `"agent_id" text PRIMARY KEY NOT NULL, "owner_user_id" text, "title" text NOT NULL, "role_description" text NOT NULL, "avatar_seed" text NOT NULL, "visibility" "agent_visibility" NOT NULL, "deleted_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL`,
    );
    expect(normalizedMigration).toContain(
      `CREATE TABLE "agent_preferences" ( "user_id" text NOT NULL, "agent_id" text NOT NULL, "hidden_at" timestamp with time zone,`,
    );
    expect(normalizedMigration).toContain(
      `CONSTRAINT "agent_preferences_user_id_agent_id_pk" PRIMARY KEY("user_id","agent_id")`,
    );
    expect(normalizedMigration).toContain(
      `ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action`,
    );
    expect(normalizedMigration).toContain(
      `ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action`,
    );
    expect(normalizedMigration).toContain(
      `ALTER TABLE "agent_preferences" ADD CONSTRAINT "agent_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`,
    );
    expect(normalizedMigration).toContain(
      `ALTER TABLE "agent_preferences" ADD CONSTRAINT "agent_preferences_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action`,
    );
    expect(normalizedMigration).toContain(
      `CREATE INDEX "agent_profiles_visibility_deleted_idx" ON "agent_profiles" USING btree ("visibility","deleted_at")`,
    );
  });

  /*
   * The columns above arrived after 0000, so the assertion on that file cannot see them — and a
   * column added to the schema with no migration behind it type-checks, passes every unit test,
   * and fails on a fresh database. This is the check that the two halves agree.
   */
  test("ships the migration that added the pin and notification preferences", async () => {
    const migration = await readFile(
      new URL("../drizzle/0011_smiling_morlun.sql", import.meta.url),
      "utf8",
    );
    const normalized = migration.replace(/\s+/g, " ").trim();

    expect(normalized).toContain(
      `ALTER TABLE "agent_preferences" ADD COLUMN "pinned_at" timestamp with time zone`,
    );
    expect(normalized).toContain(
      `ALTER TABLE "agent_preferences" ADD COLUMN "notify" boolean DEFAULT true NOT NULL`,
    );
  });
});
