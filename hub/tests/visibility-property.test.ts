import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  HubFileList,
  HubSearchResult,
  HubSync,
} from "../../shared/hub/protocol";
import { joinTask, put, search } from "./support/files";
import {
  asMember,
  newPass,
  putMember,
  startTestHub,
  type TestHub,
} from "./support/hub";

/**
 * Random members on random tasks put random files where they may, and then every member asks
 * every way there is — the list, each file by id, its bytes, its text, a search for every file,
 * the event feed — and is answered exactly what the rule says they may see. Seeded, so a failure
 * names a run that can be had again.
 */

/** mulberry32: small, seeded, good enough to shuffle a test's choices. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TASKS = ["alpha", "beta", "gamma"];
const MEMBERS = 4;
const FILES = 16;
/** A word every file of a run holds, so one search reaches all of them at once. */
const common = (seed: number) => `공통자료${seed}묶음`;
/** Each file's own word, which only that file holds. */
const own = (seed: number, index: number) =>
  `고유${seed}표식${String.fromCharCode(0xac00 + index * 7)}다`;

type Member = { id: string; pass: string; tasks: Set<string> };
type Placed = { id: string; visibility: string };

let hub: TestHub;
beforeAll(async () => {
  hub = await startTestHub();
});
afterAll(() => hub.stop());

const allows = (member: Member, visibility: string) =>
  visibility === "company" ||
  visibility === `me:${member.id}` ||
  (visibility.startsWith("task:") && member.tasks.has(visibility.slice(5)));

async function status(pass: string, path: string): Promise<number> {
  const response = await fetch(`${hub.url}/hub/v1${path}`, asMember(pass));
  await response.arrayBuffer();
  return response.status;
}

describe("visibility, by property", () => {
  test.each([7, 2026, 31337])(
    "seed %d: no member sees a file they must not, every way of asking, and sees every one they may",
    async (seed) => {
      const next = random(seed);
      const members: Member[] = [];
      for (let index = 0; index < MEMBERS; index += 1) {
        const pass = newPass();
        const { id } = await putMember(hub, {
          email: `p${seed}-${index}@example.com`,
          vmOrigin: `https://p${seed}-${index}.example`,
          pass,
        });
        const tasks = new Set(TASKS.filter(() => next() < 0.5));
        for (const task of tasks) await joinTask(hub, `${seed}-${task}`, id);
        members.push({
          id,
          pass,
          tasks: new Set([...tasks].map((task) => `${seed}-${task}`)),
        });
      }
      const first = members[0] as Member;
      const startSeq = (
        (await fetch(
          `${hub.url}/hub/v1/sync?since=0`,
          asMember(first.pass),
        ).then((response) => response.json())) as HubSync
      ).seq;

      const placed: Placed[] = [];
      for (let index = 0; index < FILES; index += 1) {
        const uploader = members[Math.floor(next() * MEMBERS)] as Member;
        const choices = [
          "company",
          `me:${uploader.id}`,
          ...[...uploader.tasks].map((task) => `task:${task}`),
        ];
        const visibility = choices[
          Math.floor(next() * choices.length)
        ] as string;
        const file = await put(hub, uploader.pass, {
          meta: {
            name: `파일-${seed}-${index}.txt`,
            folder: `/p${seed}`,
            visibility,
          },
          text: `${common(seed)} ${own(seed, index)} 내용`,
          bytes: `bytes ${seed} ${index}`,
        });
        placed.push({ id: file.id, visibility });
      }
      // Each run should exercise all three kinds; a seed that does not is a weak seed.
      expect(
        new Set(placed.map((file) => file.visibility.split(":")[0])),
      ).toEqual(new Set(["company", "me", "task"]));

      for (const member of members) {
        const may = placed
          .filter((file) => allows(member, file.visibility))
          .map((file) => file.id)
          .sort();

        const list = (await fetch(
          `${hub.url}/hub/v1/files?folder=/p${seed}`,
          asMember(member.pass),
        ).then((response) => response.json())) as HubFileList;
        expect(list.files.map((file) => file.id).sort()).toEqual(may);

        for (const file of placed) {
          const expected = allows(member, file.visibility) ? 200 : 404;
          for (const path of [
            `/files/${file.id}`,
            `/files/${file.id}/content`,
            `/files/${file.id}/text`,
          ]) {
            expect([path, await status(member.pass, path)]).toEqual([
              path,
              expected,
            ]);
          }
        }

        const all = (await search(hub, member.pass, {
          q: common(seed),
          limit: 30,
        }).then((response) => response.json())) as HubSearchResult;
        expect(all.hits.map((hit) => hit.id).sort()).toEqual(may);

        for (const [index, file] of placed.entries()) {
          const found = (await search(hub, member.pass, {
            q: own(seed, index),
          }).then((response) => response.json())) as HubSearchResult;
          expect([file.id, found.hits.map((hit) => hit.id)]).toEqual([
            file.id,
            allows(member, file.visibility) ? [file.id] : [],
          ]);
        }

        const sync = (await fetch(
          `${hub.url}/hub/v1/sync?since=${startSeq}`,
          asMember(member.pass),
        ).then((response) => response.json())) as HubSync;
        const told = sync.events
          .filter((event) => event.type === "file.changed")
          .map((event) => event.refId as string)
          .sort();
        expect(told).toEqual(may);
      }
    },
    30_000,
  );
});
