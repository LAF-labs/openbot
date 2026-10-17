import { asc, eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { HubMemberList, HubRole } from "../../shared/hub/protocol";
import type { MemberVariables } from "./auth";
import type { HubDatabase } from "./db/client";
import { hubMembers } from "./db/schema";

/**
 * `GET /members`: who is in the company, for any member.
 *
 * A room's messages name their authors as `m:<id>`, and a room lists its people by id, so a member
 * who cannot read the roster sees ids where colleagues' names belong. Appendix A of the design had
 * `GET /members` as an admin's door — for inviting and removing, which stay the registry's
 * (`fleet.ts`). What every member reads here is the part a colleague already knows from working
 * beside them: the name and the role. Never the address, the VM origin or anything about the pass.
 *
 * Only members still in the company: one who left is a name the screen no longer needs to offer,
 * and their old messages still show `m:<id>`, which the screen draws as a member who left.
 */
export function memberRoutes(input: {
  database: HubDatabase;
  member: MiddlewareHandler<{ Variables: MemberVariables }>;
}) {
  const route = new Hono<{ Variables: MemberVariables }>();
  route.use("*", input.member);

  route.get("/", async (context) => {
    const rows = await input.database
      .select({
        id: hubMembers.id,
        name: hubMembers.name,
        role: hubMembers.role,
      })
      .from(hubMembers)
      .where(eq(hubMembers.state, "active"))
      .orderBy(asc(hubMembers.joinedAt), asc(hubMembers.id));
    const body: HubMemberList = {
      ok: true,
      members: rows.map((row) => ({
        id: row.id,
        name: row.name,
        role: row.role as HubRole,
      })),
    };
    return context.json(body);
  });

  return route;
}
