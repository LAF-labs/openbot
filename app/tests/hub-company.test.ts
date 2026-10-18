import { describe, expect, test } from "bun:test";
import {
  authorOf,
  companyFactText,
  companyKeys,
  fileIdentity,
  hubKeysForFrame,
  keyFor,
  memberName,
  refusalBeforeTeamUpload,
  roomColleagues,
  sizeLabel,
  teamUploadBody,
} from "../src/lib/hub/company";
import { hubKeys } from "../src/lib/hub/status";
import { ko } from "../src/lib/i18n-ko";

/**
 * 회사: which reads a hub frame makes stale (a message in one room asks that room again, and nothing
 * else), whose a message is, the facts in the surface's words, and the body a team file goes up in.
 */

const ROOM = "r_0b6f3c4e-1d2a-4f5b-9c8d-7e6f5a4b3c2d";
const members = [
  { id: "m_a", name: "김민수", role: "admin" as const },
  { id: "m_b", name: null, role: "member" as const },
];

describe("a hub frame makes stale only what it names", () => {
  test("a message asks its own room again, and the list of rooms", () => {
    expect(
      hubKeysForFrame({ kind: "hub.room.message", refId: `${ROOM}:12` }),
    ).toEqual([companyKeys.messages(ROOM), companyKeys.rooms]);
    expect(
      hubKeysForFrame({ kind: "hub.room.mention", refId: `${ROOM}:3` }),
    ).toEqual([companyKeys.messages(ROOM), companyKeys.rooms]);
  });

  test.each([
    ["hub.file.changed", [companyKeys.files]],
    ["hub.skill.changed", [companyKeys.skills]],
    ["hub.memory.changed", [companyKeys.memory, companyKeys.proposals]],
    ["hub.memory.proposals", [companyKeys.proposals]],
    ["hub.status", [hubKeys.status]],
    [
      "hub.member.changed",
      [companyKeys.members, companyKeys.me, hubKeys.status],
    ],
  ])("%s", (kind, keys) => {
    expect(hubKeysForFrame({ kind, refId: "x_1" })).toEqual(keys);
  });

  test("a kind this build does not know asks nothing again", () => {
    // `hub.task.changed` was the example until the board learned it (`hub-tasks.test.ts`).
    expect(
      hubKeysForFrame({ kind: "hub.vault.changed", refId: "v_1" }),
    ).toEqual([]);
  });

  test("one room's key is not another's, and not the files'", () => {
    expect(companyKeys.messages("r_1")).not.toEqual(
      companyKeys.messages("r_2"),
    );
    // A prefix of the room's key would refetch it on every file change.
    expect(companyKeys.messages("r_1").slice(0, 2)).not.toEqual(
      companyKeys.files,
    );
  });
});

describe("whose a message is", () => {
  test("a person's, a person's Bot's, and somebody who left", () => {
    expect(authorOf("m:m_a", members)).toEqual({
      name: "김민수",
      isBot: false,
      memberId: "m_a",
    });
    expect(authorOf("bot:m_a", members)).toEqual({
      name: "김민수's Bot",
      isBot: true,
      memberId: "m_a",
    });
    expect(authorOf("m:m_gone", members).name).toBe("A former member");
    expect(memberName("m_b", members)).toBe("A member");
  });

  test("before the roster arrives nobody is taken for somebody who left", () => {
    expect(memberName("m_a", undefined)).toBe("Company member");
    expect(authorOf("bot:m_a", undefined).name).toBe("Company member's Bot");
  });
});

describe("a new room's colleagues", () => {
  test("are everyone but this person", () => {
    expect(roomColleagues(members, "m_a").map((one) => one.id)).toEqual([
      "m_b",
    ]);
  });

  test("are nobody until it is known who this person is", () => {
    expect(roomColleagues(members, undefined)).toEqual([]);
    expect(roomColleagues(undefined, "m_a")).toEqual([]);
  });
});

describe("a write pressed again", () => {
  let minted = 0;
  const mint = () => `k_${++minted}`;

  test("keeps its key while it is the same thing", () => {
    const first = keyFor(null, "room:영업", mint);
    expect(keyFor(first, "room:영업", mint).key).toBe(first.key);
  });

  test("gets a new key when it is something else, or after it went through", () => {
    const first = keyFor(null, "room:영업", mint);
    expect(keyFor(first, "room:회계", mint).key).not.toBe(first.key);
    expect(keyFor(null, "room:영업", mint).key).not.toBe(first.key);
  });

  test("a file is the same pick by its name, size and last change", () => {
    const one = { name: "3월 매출.csv", size: 9, lastModified: 1 };
    expect(fileIdentity({ ...one })).toBe(fileIdentity(one));
    expect(fileIdentity({ ...one, lastModified: 2 })).not.toBe(
      fileIdentity(one),
    );
    expect(fileIdentity({ ...one, size: 10 })).not.toBe(fileIdentity(one));
  });
});

describe("the hub's facts in this surface's words", () => {
  test.each([
    "laf:hub_full",
    "laf:hub_file_too_large",
    "laf:hub_busy",
    "laf:memory_not_proposed",
    "laf:request_invalid",
    "laf:hub_unreachable",
    "laf:hub_forbidden",
  ])("%p has a sentence, and a Korean one", (code) => {
    const sentence = companyFactText(code);
    expect(sentence).toBeTruthy();
    expect(ko[sentence ?? ""]).toBeTruthy();
  });

  test("a code it does not know is no sentence, never the code", () => {
    expect(companyFactText("laf:something_else")).toBeNull();
  });
});

describe("a team file from the person's computer", () => {
  test("is refused before it is sent when it is empty or past a gigabyte", () => {
    expect(refusalBeforeTeamUpload({ size: 0 })).toBe("This file is empty.");
    expect(refusalBeforeTeamUpload({ size: 1024 * 1024 * 1024 + 1 })).toBe(
      "This file is too large. Files up to 1 GB can be shared.",
    );
    expect(refusalBeforeTeamUpload({ size: 1024 * 1024 * 1024 })).toBeNull();
  });

  test("goes up as `meta` and then `blob`, in that order, as the hub reads it", () => {
    const file = new File(["날짜,매출"], "3월 매출.csv", { type: "text/csv" });
    const parts = [...teamUploadBody(file).entries()];
    expect(parts.map(([name]) => name)).toEqual(["meta", "blob"]);
    expect(JSON.parse(String(parts[0]?.[1]))).toEqual({
      name: "3월 매출.csv",
      folder: "/",
    });
    const blob: unknown = parts[1]?.[1];
    expect(blob instanceof File ? blob.name : null).toBe("3월 매출.csv");
  });

  test("its size reads as a person reads one", () => {
    expect(sizeLabel(35)).toBe("35 B");
    expect(sizeLabel(2048)).toBe("2 KB");
    expect(sizeLabel(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
