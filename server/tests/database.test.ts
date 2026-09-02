import { expect, test } from "bun:test";
import * as schema from "../src/db/schema";
import { createDatabase } from "../src/db/client";
import { TEST_POOL } from "./support/database";

/**
 * What `createDatabase` is for, asserted rather than assumed.
 *
 * The one line here used to be `expect(database.query.users).toBeDefined()`, against a real
 * database URL — which would have passed against a drizzle instance built with no schema at all,
 * and would have passed if the constructor had opened a connection to somebody's development
 * database on the spot. Both of those are the things this function has to get right.
 */

/** Nothing listens here. A constructor that connects would fail; a lazy one cannot tell. */
const NOWHERE = "postgres://nobody:nobody@127.0.0.1:1/does-not-exist";

test("hands back every table in the schema, typed", () => {
  const database = createDatabase(NOWHERE, TEST_POOL);

  // Drizzle builds `query` from the schema it is given, so an instance constructed without one has
  // an empty object here and every relational read in the server silently becomes `undefined`.
  const tables = Object.keys(schema).filter(
    (name) => (schema as Record<string, unknown>)[name] instanceof Object,
  );
  expect(tables.length).toBeGreaterThan(20);
  for (const name of ["users", "agents", "auditEvents", "lafThreadSnapshots"]) {
    expect([name, name in database.query]).toEqual([name, true]);
  }

  void database.$client.close();
});

test("opens nothing until somebody asks a question", async () => {
  /*
   * Construction is lazy, and it has to be: `createDatabase` is called at import time by a dozen
   * modules, and one that dialled out on construction would make importing a route module a
   * network call — which is how a test suite ends up writing to whatever DATABASE_URL happens to be
   * set on the machine running it.
   */
  const database = createDatabase(NOWHERE, TEST_POOL);

  // The proof is on the other side: the failure arrives at the first query, not before it. The
  // builder is a thenable rather than a promise, so it is awaited inside a function to become one.
  await expect(
    (async () => await database.select().from(schema.users))(),
  ).rejects.toThrow();

  void database.$client.close();
});
