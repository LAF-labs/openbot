import { defineConfig } from "drizzle-kit";

/**
 * Generating only: `bun run db:generate` writes the next migration from the schema. Applying is the
 * hub's own job at boot (`src/db/migrate.ts`), so this file needs no database.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/db/schema.ts"],
  out: "./drizzle",
});
