import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { HubMemberList } from "../../shared/hub/protocol";
import {
  asMember,
  newPass,
  putMember,
  startTestHub,
  type TestHub,
} from "./support/hub";

/**
 * `GET /members`: the roster a room needs to put names where its messages say `m:<id>` — names and
 * roles of the members still in the company, to any member, and nothing that reaches anybody.
 */

let hub: TestHub;
const ann = {
  email: "ann@members.example",
  name: "안나",
  role: "admin" as const,
  vmOrigin: "https://ann.members.example",
  pass: newPass(),
};
const ben = {
  email: "ben@members.example",
  name: null,
  vmOrigin: "https://ben.members.example",
  pass: newPass(),
};
const cy = {
  email: "cy@members.example",
  name: "떠난 사람",
  vmOrigin: "https://cy.members.example",
  pass: newPass(),
};
let annId = "";
let benId = "";

beforeAll(async () => {
  hub = await startTestHub();
  annId = (await putMember(hub, ann)).id;
  benId = (await putMember(hub, ben)).id;
  await putMember(hub, cy);
  await putMember(hub, { ...cy, state: "left" });
});
afterAll(() => hub.stop());

describe("/members", () => {
  test("a plain member reads every active colleague's name and role, and nobody who left", async () => {
    const response = await fetch(
      `${hub.url}/hub/v1/members`,
      asMember(ben.pass),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text) as HubMemberList).toEqual({
      ok: true,
      members: [
        { id: annId, name: "안나", role: "admin" },
        { id: benId, name: null, role: "member" },
      ],
    });
    // The roster is names: no address, no VM, nothing of the pass.
    expect(text).not.toContain("members.example");
    expect(text).not.toContain("떠난 사람");
  });

  test("is behind the pass", async () => {
    const anonymous = await fetch(`${hub.url}/hub/v1/members`);
    expect(anonymous.status).toBe(401);
    const departed = await fetch(
      `${hub.url}/hub/v1/members`,
      asMember(cy.pass),
    );
    expect(departed.status).toBe(401);
  });
});
