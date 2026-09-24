import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SQL } from "bun";

/**
 * The migration that dropped what rooms and several Bots left behind (2026-09-24), run the way an
 * upgrade runs it.
 *
 * Every other test sees the schema after it, so none of them can show what it did to a database
 * that still HAD rooms — and a migration that deletes rows is exactly the kind whose mistake is
 * found afterwards, on top of the data it took. So this builds its own databases on the test
 * server: migrates each to the migration before this one with the same `drizzle-kit migrate` the
 * `migrate` service runs, seeds the one with rooms, runs the real config over both, and reads what
 * is left.
 *
 * THE LINE IT HOLDS: a conversation with ONE Bot is never touched. A room is a channel with more
 * than one Bot, and only rooms go — with their messages, runs, notifications and ratings — while a
 * 1:1 conversation next to them keeps every row, and the audit trail keeps every row whatever it
 * is about.
 */

const serverDirectory = resolve(import.meta.dir, "..");
const migrationsDirectory = join(serverDirectory, "drizzle");
const TAG = "_drop_multi_bot_leftovers";

const testUrl = new URL(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
);
const run = randomUUID().replaceAll("-", "").slice(0, 8);
const base = decodeURIComponent(testUrl.pathname.slice(1)).slice(0, 40);
const scratch = {
  withRooms: `${base}_m47r_${run}`,
  withoutRooms: `${base}_m47e_${run}`,
};

const maintenanceUrl = new URL(testUrl);
maintenanceUrl.pathname = "/postgres";
const admin = new SQL(maintenanceUrl.toString(), { max: 1 });

const urlOf = (name: string) => {
  const url = new URL(testUrl);
  url.pathname = `/${name}`;
  return url.toString();
};

/** The migrations folder as it stood before this migration: every entry up to it, and not it. */
const before = mkdtempSync(join(tmpdir(), "laf-m47-"));
{
  const journal = JSON.parse(
    readFileSync(join(migrationsDirectory, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> };
  const at = journal.entries.findIndex((entry) => entry.tag.endsWith(TAG));
  if (at < 1) throw new Error(`The journal has no ${TAG} migration.`);
  mkdirSync(join(before, "drizzle/meta"), { recursive: true });
  for (const file of readdirSync(migrationsDirectory)) {
    if (file.endsWith(".sql")) {
      copyFileSync(
        join(migrationsDirectory, file),
        join(before, "drizzle", file),
      );
    }
  }
  writeFileSync(
    join(before, "drizzle/meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, at) }),
  );
  // No import: this file lives outside the workspace, where `drizzle-kit` does not resolve.
  writeFileSync(
    join(before, "drizzle.config.ts"),
    `export default { dialect: "postgresql", out: ${JSON.stringify(join(before, "drizzle"))}, dbCredentials: { url: process.env.DATABASE_URL } };\n`,
  );
}

/** `drizzle-kit migrate`, as the `migrate` service and the gate run it. */
async function migrate(database: string, config: string): Promise<void> {
  const child = Bun.spawn(
    ["bunx", "drizzle-kit", "migrate", `--config=${config}`],
    {
      cwd: serverDirectory,
      env: { ...process.env, DATABASE_URL: urlOf(database) },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`drizzle-kit migrate exited ${code}:\n${out}\n${err}`);
  }
}

async function createScratch(name: string): Promise<void> {
  await admin.unsafe(`create database "${name}"`);
}

afterAll(async () => {
  for (const name of Object.values(scratch)) {
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
  }
  await admin.close();
  rmSync(before, { recursive: true, force: true });
});

describe("migration 0047, on a database that had rooms", () => {
  test("deletes the rooms and what was in them, and leaves a 1:1 conversation whole", async () => {
    await createScratch(scratch.withRooms);
    await migrate(scratch.withRooms, join(before, "drizzle.config.ts"));

    const db = new SQL(urlOf(scratch.withRooms), { max: 1 });
    try {
      /*
       * One person, three Bots — an account from before the cap came down.
       *
       *  - `solo`: a 1:1 conversation with `bot-a`. Every row of it must survive.
       *  - `room`: `bot-a` and `bot-b` together. Every row of it must go.
       *  - `shrunk`: a room whose other member was taken out before 2026-09-24, so one Bot is left.
       *    By the one test there is — how many Bots — it is a 1:1 conversation and stays; only the
       *    room's receipts key comes off its messages.
       */
      await db`insert into users (id, email) values ('u1', 'u1@m47.test')`;
      for (const bot of ["bot-a", "bot-b", "bot-c"]) {
        await db`insert into agents (id, name, type, configuration)
                 values (${bot}, ${bot}, 'remote_ag_ui', '{}'::jsonb)`;
      }
      await db`insert into agent_profiles (agent_id, owner_user_id, title, role_description, avatar_seed, preset_id)
               values ('bot-a', 'u1', '리뷰 담당', '리뷰에 답한다', 's:a', 'review-replies'),
                      ('bot-b', 'u1', '', '', 's:b', null),
                      ('bot-c', 'u1', '', '', 's:c', null)`;
      await db`insert into agent_preferences (user_id, agent_id, hidden_at, pinned_at, notify)
               values ('u1', 'bot-a', null, now(), true), ('u1', 'bot-b', now(), null, false)`;

      await db`insert into channels (id, name, description, room_turn_epoch)
               values ('solo', 'bot-a', '', 0), ('room', 'bot-a, bot-b', '', 7), ('shrunk', 'bot-c', '', 3)`;
      await db`insert into channel_agents (channel_id, agent_id)
               values ('solo', 'bot-a'), ('room', 'bot-a'), ('room', 'bot-b'), ('shrunk', 'bot-c')`;
      await db`insert into channel_memberships (channel_id, user_id)
               values ('solo', 'u1'), ('room', 'u1'), ('shrunk', 'u1')`;
      await db`insert into channel_threads (user_id, channel_id, thread_id)
               values ('u1', 'solo', 't-solo'), ('u1', 'room', 't-room'), ('u1', 'shrunk', 't-shrunk')`;

      // As text, cast twice: a string bound straight to `::jsonb` lands as a jsonb STRING (json.ts).
      const message = (body: Record<string, unknown>) => JSON.stringify(body);
      await db`insert into laf_thread_messages (thread_id, seq, message) values
        ('t-solo', 1, ${message({ id: "s1", role: "user", content: "오늘 주문 정리해 줘" })}::text::jsonb),
        ('t-solo', 2, ${message({ id: "s2", role: "assistant", content: "세 건입니다", lafAgentId: "bot-a" })}::text::jsonb),
        ('t-room', 1, ${message({ id: "r1", role: "user", content: "둘 다 봐 줘", lafRoomReceipts: { "bot-a": "read" } })}::text::jsonb),
        ('t-room', 2, ${message({ id: "r2", role: "assistant", content: "봤어요", lafAgentId: "bot-b" })}::text::jsonb),
        ('t-shrunk', 1, ${message({ id: "h1", role: "user", content: "정산 알려 줘", lafRoomReceipts: { "bot-c": "read" } })}::text::jsonb),
        ('t-shrunk', 2, ${message({ id: "h2", role: "assistant", content: "알려 드릴게요", lafAgentId: "bot-c" })}::text::jsonb)`;

      await db`insert into laf_thread_runs (run_id, thread_id, agent_id, user_id, status, origin) values
        ('run-solo', 't-solo', 'bot-a', 'u1', 'done', 'chat'),
        ('run-room-turn', 't-room', 'bot-b', 'u1', 'done', 'room'),
        ('run-room-chat', 't-room', 'bot-a', 'u1', 'done', 'chat'),
        ('run-handoff', null, 'bot-b', 'u1', 'done', 'handoff'),
        ('run-routine', null, 'bot-a', 'u1', 'done', 'routine')`;
      await db`insert into laf_notifications (id, kind, bot_id, user_id, channel_id) values
        ('n-solo', 'run.finished', 'bot-a', 'u1', 'solo'),
        ('n-room', 'run.finished', 'bot-b', 'u1', 'room'),
        ('n-none', 'run.finished', 'bot-a', 'u1', null)`;
      await db`insert into laf_answer_ratings (id, user_id, channel_id, message_id, agent_id, rating) values
        ('rate-solo', 'u1', 'solo', 's2', 'bot-a', 'up'),
        ('rate-room', 'u1', 'room', 'r2', 'bot-b', 'down')`;
      await db`insert into audit_events (actor_user_id, event_type, target_type, target_id, payload) values
        ('u1', 'room.member_turn', 'channel', 'room', '{}'::jsonb),
        ('u1', 'coworker.asked', 'agent', 'bot-b', '{}'::jsonb),
        ('u1', 'routine.ran', 'routine', 'r-1', '{}'::jsonb)`;

      // The upgrade: the real config, over what is missing — this one migration.
      await migrate(
        scratch.withRooms,
        join(serverDirectory, "drizzle.config.ts"),
      );

      const ids = async (query: Promise<Array<Record<string, string>>>) =>
        (await query).map((row) => Object.values(row)[0]).sort();

      // The room is gone, with everything that hangs off it.
      expect(await ids(db`select id from channels`)).toEqual([
        "shrunk",
        "solo",
      ]);
      expect(
        await ids(db`select channel_id || ':' || agent_id from channel_agents`),
      ).toEqual(["shrunk:bot-c", "solo:bot-a"]);
      expect(await ids(db`select channel_id from channel_memberships`)).toEqual(
        ["shrunk", "solo"],
      );
      expect(await ids(db`select thread_id from channel_threads`)).toEqual([
        "t-shrunk",
        "t-solo",
      ]);
      expect(
        await ids(
          db`select thread_id || ':' || (message ->> 'id') from laf_thread_messages`,
        ),
      ).toEqual(["t-shrunk:h1", "t-shrunk:h2", "t-solo:s1", "t-solo:s2"]);
      expect(await ids(db`select run_id from laf_thread_runs`)).toEqual([
        "run-routine",
        "run-solo",
      ]);
      expect(await ids(db`select id from laf_notifications`)).toEqual([
        "n-none",
        "n-solo",
      ]);
      expect(await ids(db`select id from laf_answer_ratings`)).toEqual([
        "rate-solo",
      ]);

      // The 1:1 conversation is exactly what it was, word for word.
      const [said] = await db`select message from laf_thread_messages
                              where thread_id = 't-solo' and seq = 2`;
      expect(said.message).toEqual({
        id: "s2",
        role: "assistant",
        content: "세 건입니다",
        lafAgentId: "bot-a",
      });
      // And the shrunk room keeps its messages, without the room's key.
      const [kept] = await db`select message from laf_thread_messages
                              where thread_id = 't-shrunk' and seq = 1`;
      expect(kept.message).toEqual({
        id: "h1",
        role: "user",
        content: "정산 알려 줘",
      });

      // The Bots and the person are untouched; only the columns went.
      expect(await ids(db`select agent_id from agent_profiles`)).toEqual([
        "bot-a",
        "bot-b",
        "bot-c",
      ]);
      const [profile] =
        await db`select * from agent_profiles where agent_id = 'bot-a'`;
      expect(profile).not.toHaveProperty("title");
      expect(profile).not.toHaveProperty("preset_id");
      expect(profile.role_description).toBe("리뷰에 답한다");
      const preferences =
        await db`select * from agent_preferences order by agent_id`;
      expect(
        preferences.map((row: { agent_id: string }) => row.agent_id),
      ).toEqual(["bot-a", "bot-b"]);
      expect(preferences[0]).not.toHaveProperty("pinned_at");
      expect(preferences[1].hidden_at).toBeInstanceOf(Date);
      const [channel] = await db`select * from channels where id = 'solo'`;
      expect(channel).not.toHaveProperty("room_turn_epoch");

      // The audit trail is the record of what happened, and keeps every row of it.
      expect(await ids(db`select event_type from audit_events`)).toEqual([
        "coworker.asked",
        "room.member_turn",
        "routine.ran",
      ]);

      // The enum is rebuilt without the two values, and a run can still be written.
      expect(
        await ids(
          db`select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
             where t.typname = 'laf_run_origin'`,
        ),
      ).toEqual(["chat", "routine", "wake"]);
      await db`insert into laf_thread_runs (run_id, status) values ('run-after', 'running')`;
      const [after] =
        await db`select origin from laf_thread_runs where run_id = 'run-after'`;
      expect(after.origin).toBe("chat");
      // Settled by hand: `expect(query).rejects` spins on a Bun SQL query (measured, Bun 1.3.11).
      const refused =
        await db`insert into laf_thread_runs (run_id, status, origin)
                               values ('run-bad', 'running', 'room')`.then(
          () => false,
          () => true,
        );
      expect(refused).toBe(true);
    } finally {
      await db.close();
    }
  }, 120_000);
});

describe("migration 0047, on a database that never had a room", () => {
  test("applies over an empty deployment and changes only the shape", async () => {
    await createScratch(scratch.withoutRooms);
    await migrate(scratch.withoutRooms, join(before, "drizzle.config.ts"));
    await migrate(
      scratch.withoutRooms,
      join(serverDirectory, "drizzle.config.ts"),
    );

    const db = new SQL(urlOf(scratch.withoutRooms), { max: 1 });
    try {
      const applied =
        await db`select count(*)::int as n from drizzle.__drizzle_migrations`;
      const journal = JSON.parse(
        readFileSync(join(migrationsDirectory, "meta/_journal.json"), "utf8"),
      ) as { entries: unknown[] };
      expect(applied[0].n).toBe(journal.entries.length);
      const dropped = await db`select table_name || '.' || column_name as c
                               from information_schema.columns
                               where table_schema = 'public'
                                 and column_name in ('title', 'preset_id', 'pinned_at', 'room_turn_epoch')
                                 and table_name in ('agent_profiles', 'agent_preferences', 'channels')`;
      expect(dropped).toEqual([]);
    } finally {
      await db.close();
    }
  }, 120_000);
});
