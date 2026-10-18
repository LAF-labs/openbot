import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type {
  HubDocBlock,
  HubDocList,
  HubDocLockFrame,
  HubDocMarkdown,
  HubDocOpsResult,
  HubDocRead,
  HubDocVersion,
  HubSearchResult,
  HubSync,
} from "../../shared/hub/protocol";
import { hubAudit, hubChunks } from "../src/db/schema";
import { search } from "./support/files";
import { newPass, putMember, startTestHub, type TestHub } from "./support/hub";
import { openSocket, type TestSocket } from "./support/socket";

let hub: TestHub;
const ann = {
  email: "ann@example.com",
  name: "앤",
  vmOrigin: "https://ann.example",
  pass: newPass(),
};
const bob = {
  email: "bob@example.com",
  name: "밥",
  vmOrigin: "https://bob.example",
  pass: newPass(),
};
const cid = {
  email: "cid@example.com",
  vmOrigin: "https://cid.example",
  pass: newPass(),
};
let annId = "";
let bobId = "";

beforeAll(async () => {
  hub = await startTestHub();
  annId = (await putMember(hub, ann)).id;
  bobId = (await putMember(hub, bob)).id;
  await putMember(hub, cid);
});
afterAll(() => hub.stop());

type Reply<T = Record<string, unknown>> = { status: number; body: T };

async function call<T = Record<string, unknown>>(
  pass: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply<T>> {
  const response = await fetch(`${hub.url}/hub/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${pass}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(method === "GET" ? {} : { "idempotency-key": randomUUID() }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as T };
}

/** A new company document from markdown; its blocks in order. */
async function newDoc(
  pass: string,
  markdown: string,
  extra: Record<string, unknown> = {},
): Promise<HubDocRead> {
  const reply = await call<HubDocRead>(pass, "POST", "/docs", {
    title: "회의록",
    markdown,
    ...extra,
  });
  if (reply.status !== 200) {
    throw new Error(
      `POST /docs answered ${reply.status}: ${JSON.stringify(reply.body)}`,
    );
  }
  return reply.body;
}

const ops = (
  pass: string,
  docId: string,
  list: unknown[],
  origin = "person",
  key?: string,
) =>
  call<
    HubDocOpsResult & {
      code?: string;
      op?: number;
      block?: HubDocBlock | null;
      holder?: { member: string };
    }
  >(
    pass,
    "POST",
    `/docs/${docId}/blocks`,
    { ops: list },
    { "x-laf-origin": origin, ...(key ? { "idempotency-key": key } : {}) },
  );

const read = async (pass: string, docId: string) =>
  (await call<HubDocRead>(pass, "GET", `/docs/${docId}`)).body;

const texts = (doc: HubDocRead) => doc.blocks.map((block) => block.text);

async function frameFor(
  socket: TestSocket,
  match: (frame: HubDocLockFrame) => boolean,
): Promise<HubDocLockFrame> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const found = (socket.frames as unknown as HubDocLockFrame[]).find(
      (frame) => frame.kind === "doc.lock" && match(frame),
    );
    if (found) return found;
    await Bun.sleep(10);
  }
  throw new Error("no doc.lock frame arrived");
}

describe("documents", () => {
  test("a document made from markdown keeps its blocks in order, and its markdown says the same", async () => {
    const doc = await newDoc(
      ann.pass,
      "# 주간 회의\n\n안건 하나\n\n- [ ] 견적 보내기\n\n| 품목 | 수량 |\n|---|---|\n| 사과 | 3 |",
    );
    expect(doc.blocks.map((block) => block.kind)).toEqual([
      "heading1",
      "paragraph",
      "check",
      "table",
    ]);
    const ranks = doc.blocks.map((block) => block.rank);
    expect([...ranks].sort()).toEqual(ranks);
    const again = await read(bob.pass, doc.doc.id);
    expect(texts(again)).toEqual(["주간 회의", "안건 하나", "견적 보내기", ""]);
    const markdown = await call<HubDocMarkdown>(
      bob.pass,
      "GET",
      `/docs/${doc.doc.id}/markdown`,
    );
    const [first] = doc.blocks;
    expect(
      markdown.body.markdown.startsWith(
        `<!-- ${first?.id} ${first?.hash} -->\n# 주간 회의\n\n`,
      ),
    ).toBe(true);
    expect(markdown.body.markdown).toContain("| 사과 | 3 |");
  });

  test("two members save two different blocks at the same moment, and both saves stand", async () => {
    const doc = await newDoc(ann.pass, "첫째\n\n둘째\n\n셋째");
    const [, second, third] = doc.blocks as HubDocBlock[];
    const [a, b] = await Promise.all([
      ops(ann.pass, doc.doc.id, [
        { op: "replace", id: second?.id, version: 1, text: "앤이 고친 둘째" },
      ]),
      ops(bob.pass, doc.doc.id, [
        { op: "replace", id: third?.id, version: 1, text: "밥이 고친 셋째" },
      ]),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const after = await read(cid.pass, doc.doc.id);
    expect(texts(after)).toEqual(["첫째", "앤이 고친 둘째", "밥이 고친 셋째"]);
    expect(after.blocks.map((block) => block.version)).toEqual([1, 2, 2]);
    expect(after.blocks[1]?.by).toBe(annId);
    expect(after.blocks[2]?.by).toBe(bobId);
    expect(after.doc.rev).toBe(3);
  });

  test("two saves of the same block from the same version: one stands, the other is told and handed the latest", async () => {
    const doc = await newDoc(ann.pass, "같은 문단");
    const id = doc.blocks[0]?.id;
    const replies = await Promise.all([
      ops(ann.pass, doc.doc.id, [
        { op: "replace", id, version: 1, text: "앤의 글" },
      ]),
      ops(bob.pass, doc.doc.id, [
        { op: "replace", id, version: 1, text: "밥의 글" },
      ]),
    ]);
    const statuses = replies.map((reply) => reply.status).sort();
    expect(statuses).toEqual([200, 409]);
    const won = replies.find((reply) => reply.status === 200);
    const lost = replies.find((reply) => reply.status === 409);
    expect(lost?.body).toMatchObject({
      ok: false,
      code: "laf:doc_block_changed",
      op: 0,
      block: { id, version: 2, text: won?.body.blocks[0]?.text },
    });
    expect(texts(await read(ann.pass, doc.doc.id))).toEqual([
      won?.body.blocks[0]?.text ?? "",
    ]);
  });

  test("eight saves racing on one block from the same version: exactly one stands", async () => {
    // Many at once, so the saves overlap inside the hub rather than arrive one after another: the
    // document's row, taken `for update`, is what makes the checks and the writes one at a time.
    const doc = await newDoc(ann.pass, "경주");
    const id = doc.blocks[0]?.id;
    const replies = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        ops(index % 2 ? bob.pass : ann.pass, doc.doc.id, [
          { op: "replace", id, version: 1, text: `글 ${index}` },
        ]),
      ),
    );
    expect(replies.filter((reply) => reply.status === 200)).toHaveLength(1);
    expect(replies.filter((reply) => reply.status === 409)).toHaveLength(7);
    const after = await read(ann.pass, doc.doc.id);
    expect(after.blocks[0]?.version).toBe(2);
    expect(after.doc.rev).toBe(2);
  });

  test("a block a person is writing in: 라피 is told busy, anybody's 라피, while the writer's own save goes through", async () => {
    const doc = await newDoc(ann.pass, "하나\n\n둘\n\n셋");
    const block = doc.blocks[1] as HubDocBlock;
    const lock = await call(
      ann.pass,
      "POST",
      `/docs/${doc.doc.id}/blocks/${block.id}/lock`,
    );
    expect(lock).toMatchObject({
      status: 200,
      body: { ok: true, ttlMs: 15_000, renewMs: 5_000 },
    });
    for (const pass of [bob.pass, ann.pass]) {
      const tried = await ops(
        pass,
        doc.doc.id,
        [
          {
            op: "replace",
            id: block.id,
            expectHash: block.hash,
            text: "라피의 글",
          },
        ],
        "chat",
      );
      expect(tried.status).toBe(409);
      expect(tried.body).toMatchObject({
        code: "laf:doc_block_busy",
        op: 0,
        holder: { member: annId, name: "앤" },
      });
    }
    const bobSave = await ops(bob.pass, doc.doc.id, [
      { op: "replace", id: block.id, version: 1, text: "밥" },
    ]);
    expect(bobSave.body.code).toBe("laf:doc_block_busy");
    const own = await ops(ann.pass, doc.doc.id, [
      { op: "replace", id: block.id, version: 1, text: "앤이 쓰는 중" },
    ]);
    expect(own.status).toBe(200);
    // A second member cannot take the hold, and it goes when its holder lets go.
    const taken = await call(
      bob.pass,
      "POST",
      `/docs/${doc.doc.id}/blocks/${block.id}/lock`,
    );
    expect(taken).toMatchObject({
      status: 409,
      body: { code: "laf:doc_block_busy", holder: { member: annId } },
    });
    expect(await read(bob.pass, doc.doc.id)).toMatchObject({
      locks: [{ block: block.id, member: annId, name: "앤" }],
    });
    await call(
      ann.pass,
      "POST",
      `/docs/${doc.doc.id}/blocks/${block.id}/unlock`,
    );
    const latest = (await read(bob.pass, doc.doc.id)).blocks[1] as HubDocBlock;
    const after = await ops(
      bob.pass,
      doc.doc.id,
      [
        {
          op: "replace",
          id: block.id,
          expectHash: latest.hash,
          text: "라피의 글",
        },
      ],
      "chat",
    );
    expect(after.status).toBe(200);
  });

  test("라피 with a stale hash is told the block changed and handed it; read again, its change goes through", async () => {
    const doc = await newDoc(ann.pass, "원래 문장");
    const old = doc.blocks[0] as HubDocBlock;
    await ops(bob.pass, doc.doc.id, [
      { op: "replace", id: old.id, version: 1, text: "밥이 바꾼 문장" },
    ]);
    const stale = await ops(
      ann.pass,
      doc.doc.id,
      [{ op: "replace", id: old.id, expectHash: old.hash, text: "라피" }],
      "chat",
    );
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      code: "laf:doc_block_changed",
      block: { text: "밥이 바꾼 문장", version: 2 },
    });
    const refusedRows = await hub.database
      .select({ outcome: hubAudit.outcome, payload: hubAudit.payload })
      .from(hubAudit)
      .where(
        and(eq(hubAudit.target, doc.doc.id), eq(hubAudit.action, "doc.blocks")),
      );
    expect(refusedRows).toContainEqual({
      outcome: "laf:doc_block_changed",
      payload: { ops: 1, op: 0, field: null, block: old.id, by: "lafi" },
    });
    const fresh = stale.body.block as HubDocBlock;
    const retried = await ops(
      ann.pass,
      doc.doc.id,
      [
        {
          op: "replace",
          id: old.id,
          expectHash: fresh.hash,
          text: "라피가 다듬은 문장",
        },
      ],
      "chat",
    );
    expect(retried.status).toBe(200);
    expect(retried.body.blocks[0]).toMatchObject({
      text: "라피가 다듬은 문장",
      version: 3,
    });
  });

  test("a run's change must name a hash, and a person's save a version", async () => {
    const doc = await newDoc(ann.pass, "문단");
    const id = doc.blocks[0]?.id;
    const byVersion = await ops(
      ann.pass,
      doc.doc.id,
      [{ op: "replace", id, version: 1, text: "x" }],
      "job",
    );
    expect(byVersion).toMatchObject({
      status: 400,
      body: { field: "ops[0].expectHash" },
    });
    const unchecked = await ops(ann.pass, doc.doc.id, [{ op: "delete", id }]);
    expect(unchecked).toMatchObject({
      status: 400,
      body: { field: "ops[0].version" },
    });
    const whole = await ops(ann.pass, doc.doc.id, [
      { op: "replace_all", markdown: "x" },
    ]);
    expect(whole).toMatchObject({ status: 400, body: { field: "ops[0].op" } });
  });

  test("a batch is all or none: a refused op leaves the ones before it unwritten", async () => {
    const doc = await newDoc(ann.pass, "가\n\n나");
    const [first, second] = doc.blocks as HubDocBlock[];
    const refused = await ops(ann.pass, doc.doc.id, [
      { op: "replace", id: first?.id, version: 1, text: "바뀐 가" },
      { op: "replace", id: second?.id, version: 7, text: "바뀐 나" },
    ]);
    expect(refused.body).toMatchObject({
      code: "laf:doc_block_changed",
      op: 1,
    });
    const after = await read(ann.pass, doc.doc.id);
    expect(texts(after)).toEqual(["가", "나"]);
    expect(after.doc.rev).toBe(1);
  });

  test("inserts, a move and a delete leave the blocks in the order asked, ranks ascending", async () => {
    const doc = await newDoc(ann.pass, "일\n\n이\n\n삼\n\n사");
    const [one, two, three, four] = doc.blocks as HubDocBlock[];
    const done = await ops(ann.pass, doc.doc.id, [
      { op: "move", id: four?.id, after: null, version: 1 },
      { op: "delete", id: two?.id, version: 1 },
      {
        op: "insert_after",
        id: one?.id,
        newId: "b_newblock01",
        kind: "check",
        text: "새 할 일",
      },
      { op: "insert_after", id: "b_newblock01", text: "그 뒤" },
      { op: "move", id: three?.id, after: four?.id, version: 1 },
    ]);
    expect(done.status).toBe(200);
    expect(done.body.deleted).toEqual([two?.id]);
    const after = await read(ann.pass, doc.doc.id);
    expect(texts(after)).toEqual(["사", "삼", "일", "새 할 일", "그 뒤"]);
    const ranks = after.blocks.map((block) => block.rank);
    expect([...ranks].sort()).toEqual(ranks);
    expect(after.blocks[3]).toMatchObject({
      id: "b_newblock01",
      kind: "check",
      version: 1,
    });
    const gone = await call(
      ann.pass,
      "GET",
      `/docs/${doc.doc.id}/blocks/${two?.id}`,
    );
    expect(gone.status).toBe(404);
  });

  test("a block inserted and rewritten in one save keeps the version it answered, so the next save naming it goes through", async () => {
    const doc = await newDoc(ann.pass, "첫 줄");
    const done = await ops(ann.pass, doc.doc.id, [
      {
        op: "insert_after",
        id: doc.blocks[0]?.id,
        newId: "b_newblock02",
        text: "처음",
      },
      { op: "replace", id: "b_newblock02", version: 1, text: "고친 것" },
    ]);
    expect(done.status).toBe(200);
    const answered = done.body.blocks.find(
      (block) => block.id === "b_newblock02",
    );
    const stored = (await read(ann.pass, doc.doc.id)).blocks.find(
      (block) => block.id === "b_newblock02",
    );
    expect(stored?.version).toBe(answered?.version);
    const next = await ops(ann.pass, doc.doc.id, [
      {
        op: "replace",
        id: "b_newblock02",
        version: answered?.version,
        text: "또 고친 것",
      },
    ]);
    expect(next.status).toBe(200);
  });

  test("400 inserts right after one block renumber the document once its ranks grow long, and keep the order", async () => {
    const doc = await newDoc(ann.pass, "앞\n\n뒤");
    const anchor = doc.blocks[0]?.id;
    const before = (await call<HubSync>(ann.pass, "GET", "/sync")).body.seq;
    for (let batch = 0; batch < 2; batch += 1) {
      const reply = await ops(
        ann.pass,
        doc.doc.id,
        Array.from({ length: 200 }, (_, index) => ({
          op: "insert_after",
          id: anchor,
          text: `끼움 ${batch * 200 + index}`,
        })),
      );
      expect(reply.status).toBe(200);
    }
    const after = await read(ann.pass, doc.doc.id);
    expect(after.blocks).toHaveLength(402);
    // Each insert went right after the anchor, so the newest is first after it.
    expect(texts(after).slice(0, 3)).toEqual(["앞", "끼움 399", "끼움 398"]);
    expect(texts(after).at(-1)).toBe("뒤");
    const ranks = after.blocks.map((block) => block.rank);
    expect([...ranks].sort()).toEqual(ranks);
    expect(Math.max(...ranks.map((rank) => rank.length))).toBeLessThanOrEqual(
      3,
    );
    const events = (
      await call<HubSync>(bob.pass, "GET", `/sync?since=${before}`)
    ).body.events;
    expect(
      events
        .filter((event) => event.refId === doc.doc.id)
        .map((event) => event.type),
    ).toContain("doc.changed");
  });

  test("a word typed into a block is found right after its save, and not after it is taken out", async () => {
    const doc = await newDoc(ann.pass, "처음 문장\n\n다른 문장", {
      title: "거래처 메모",
    });
    const block = doc.blocks[1] as HubDocBlock;
    await ops(bob.pass, doc.doc.id, [
      {
        op: "replace",
        id: block.id,
        version: 1,
        text: "밥이 적은 반짝임낱말 하나",
      },
    ]);
    const found = await search(hub, cid.pass, { q: "반짝임낱말" });
    const result = (await found.json()) as HubSearchResult;
    expect(result.hits).toEqual([
      expect.objectContaining({
        kind: "doc",
        id: doc.doc.id,
        title: "거래처 메모",
        where: { folder: "/", block: block.id },
        by: bobId,
      }),
    ]);
    expect(result.hits[0]?.snippet).toContain("반짝임낱말");
    await ops(bob.pass, doc.doc.id, [
      { op: "replace", id: block.id, version: 2, text: "지웠다" },
    ]);
    const gone = (await (
      await search(hub, cid.pass, { q: "반짝임낱말" })
    ).json()) as HubSearchResult;
    expect(gone.hits).toEqual([]);
    const onlyFiles = (await (
      await search(hub, cid.pass, { q: "지웠다", kinds: ["file"] })
    ).json()) as HubSearchResult;
    expect(onlyFiles.hits).toEqual([]);
    const byTitle = (await (
      await search(hub, cid.pass, { q: "거래처" })
    ).json()) as HubSearchResult;
    expect(byTitle.hits).toEqual([
      expect.objectContaining({
        kind: "doc",
        id: doc.doc.id,
        where: { folder: "/", block: null },
        snippet: "처음 문장",
      }),
    ]);
  });

  test("a snapshot keeps the block list it was taken of", async () => {
    const doc = await newDoc(ann.pass, "# 계획\n\n첫 안");
    const [heading, body] = doc.blocks as HubDocBlock[];
    const saved = await call<{ version: number }>(
      ann.pass,
      "POST",
      `/docs/${doc.doc.id}/versions`,
    );
    expect(saved).toMatchObject({ status: 200, body: { version: 1 } });
    await ops(ann.pass, doc.doc.id, [
      { op: "replace", id: body?.id, version: 1, text: "둘째 안" },
      { op: "insert_after", id: body?.id, text: "덧붙임" },
      { op: "delete", id: heading?.id, version: 1 },
    ]);
    expect(texts(await read(ann.pass, doc.doc.id))).toEqual([
      "둘째 안",
      "덧붙임",
    ]);
    const old = await call<HubDocVersion>(
      bob.pass,
      "GET",
      `/docs/${doc.doc.id}/versions/1`,
    );
    expect(old.body).toMatchObject({ version: 1, title: "회의록", by: annId });
    expect(old.body.blocks).toEqual([
      {
        id: heading?.id,
        kind: "heading1",
        text: "계획",
        attrs: {},
        version: 1,
        hash: heading?.hash,
      },
      {
        id: body?.id,
        kind: "paragraph",
        text: "첫 안",
        attrs: {},
        version: 1,
        hash: body?.hash,
      },
    ]);
    const list = await call<{
      versions: { version: number; blocks: number }[];
    }>(bob.pass, "GET", `/docs/${doc.doc.id}/versions`);
    expect(list.body.versions).toEqual([
      expect.objectContaining({ version: 1, blocks: 2 }),
    ]);
    expect(
      (await call(bob.pass, "GET", `/docs/${doc.doc.id}/versions/2`)).status,
    ).toBe(404);
  });

  test("a document only its writer may see is not found by anybody else, by any way of asking", async () => {
    const doc = await newDoc(ann.pass, "비밀 메모장낱말", {
      visibility: `me:${annId}`,
    });
    const id = doc.doc.id;
    const block = doc.blocks[0]?.id;
    for (const [method, path] of [
      ["GET", `/docs/${id}`],
      ["GET", `/docs/${id}/markdown`],
      ["GET", `/docs/${id}/blocks/${block}`],
      ["GET", `/docs/${id}/versions`],
      ["POST", `/docs/${id}/blocks/${block}/lock`],
      ["POST", `/docs/${id}/versions`],
      ["DELETE", `/docs/${id}`],
    ] as const) {
      expect([
        method,
        path,
        (await call(bob.pass, method, path)).status,
      ]).toEqual([method, path, 404]);
    }
    expect(
      (
        await ops(bob.pass, id, [
          { op: "replace", id: block, version: 1, text: "x" },
        ])
      ).status,
    ).toBe(404);
    const list = await call<HubDocList>(bob.pass, "GET", "/docs");
    expect(list.body.docs.map((one) => one.id)).not.toContain(id);
    expect(
      (await call<HubDocList>(ann.pass, "GET", "/docs")).body.docs.map(
        (one) => one.id,
      ),
    ).toContain(id);
    const searched = (await (
      await search(hub, bob.pass, { q: "메모장낱말" })
    ).json()) as HubSearchResult;
    expect(searched.hits).toEqual([]);
    const own = (await (
      await search(hub, ann.pass, { q: "메모장낱말" })
    ).json()) as HubSearchResult;
    expect(own.hits.map((hit) => hit.id)).toEqual([id]);
  });

  test("a hold reaches the sockets of the members who may see the document, and only theirs", async () => {
    const open = await newDoc(ann.pass, "모두의 문단");
    const own = await newDoc(ann.pass, "앤만의 문단", {
      visibility: `me:${annId}`,
    });
    const bobSocket = await openSocket(hub.url, bob.pass);
    const annSocket = await openSocket(hub.url, ann.pass);
    try {
      const ownBlock = own.blocks[0]?.id ?? "";
      await call(
        ann.pass,
        "POST",
        `/docs/${own.doc.id}/blocks/${ownBlock}/lock`,
      );
      const openBlock = open.blocks[0]?.id ?? "";
      await call(
        ann.pass,
        "POST",
        `/docs/${open.doc.id}/blocks/${openBlock}/lock`,
      );
      const seen = await frameFor(
        bobSocket,
        (frame) => frame.doc === open.doc.id,
      );
      expect(seen).toMatchObject({
        kind: "doc.lock",
        block: openBlock,
        member: annId,
        name: "앤",
      });
      expect(Date.parse(seen.until ?? "")).toBeGreaterThan(Date.now());
      // Frames go out in order: the open document's came after the private one's, which bob never got.
      expect(
        (bobSocket.frames as unknown as HubDocLockFrame[]).some(
          (frame) => frame.doc === own.doc.id,
        ),
      ).toBe(false);
      expect(
        await frameFor(annSocket, (frame) => frame.doc === own.doc.id),
      ).toMatchObject({ block: ownBlock });
      await call(
        ann.pass,
        "POST",
        `/docs/${open.doc.id}/blocks/${openBlock}/unlock`,
      );
      expect(
        await frameFor(
          bobSocket,
          (frame) => frame.doc === open.doc.id && frame.until === null,
        ),
      ).toMatchObject({ member: annId });
    } finally {
      bobSocket.close();
      annSocket.close();
    }
  });

  test("a save is an event per block for the members who may see it, and a trail row without the words", async () => {
    const doc = await newDoc(ann.pass, "사건 문단");
    const block = doc.blocks[0]?.id;
    const before = (await call<HubSync>(bob.pass, "GET", "/sync")).body.seq;
    await ops(ann.pass, doc.doc.id, [
      { op: "replace", id: block, version: 1, text: "기록되면 안 되는 낱말" },
    ]);
    const events = (
      await call<HubSync>(bob.pass, "GET", `/sync?since=${before}`)
    ).body.events;
    expect(events).toEqual([
      expect.objectContaining({
        type: "doc.block_changed",
        refId: `${doc.doc.id}/${block}`,
        actor: annId,
      }),
    ]);
    const trail = await hub.database
      .select()
      .from(hubAudit)
      .where(
        and(eq(hubAudit.target, doc.doc.id), eq(hubAudit.action, "doc.blocks")),
      );
    expect(trail).toHaveLength(1);
    expect(JSON.stringify(trail)).not.toContain("기록되면");
  });

  test("the same key sent twice writes once", async () => {
    const doc = await newDoc(ann.pass, "한 번");
    const key = randomUUID();
    const change = [{ op: "insert_after", id: doc.blocks[0]?.id, text: "덧" }];
    const first = await ops(ann.pass, doc.doc.id, change, "person", key);
    const second = await ops(ann.pass, doc.doc.id, change, "person", key);
    expect(second.body).toEqual(first.body);
    const after = await read(ann.pass, doc.doc.id);
    expect(texts(after)).toEqual(["한 번", "덧"]);
    expect(after.doc.rev).toBe(2);
  });

  test("a company document is deleted by its writer or an admin, and its words leave search with it", async () => {
    const doc = await newDoc(ann.pass, "지울 문서의 사라짐낱말");
    expect((await call(bob.pass, "DELETE", `/docs/${doc.doc.id}`)).status).toBe(
      403,
    );
    expect((await call(ann.pass, "DELETE", `/docs/${doc.doc.id}`)).status).toBe(
      200,
    );
    expect((await call(ann.pass, "GET", `/docs/${doc.doc.id}`)).status).toBe(
      404,
    );
    const chunks = await hub.database
      .select({ id: hubChunks.id })
      .from(hubChunks)
      .where(eq(hubChunks.sourceId, `${doc.doc.id}/${doc.blocks[0]?.id}`));
    expect(chunks).toEqual([]);
    const searched = (await (
      await search(hub, ann.pass, { q: "사라짐낱말" })
    ).json()) as HubSearchResult;
    expect(searched.hits).toEqual([]);
  });

  test("a rename is what search names the document by", async () => {
    const doc = await newDoc(ann.pass, "이름표낱말이 든 문단");
    const renamed = await call(ann.pass, "PATCH", `/docs/${doc.doc.id}`, {
      title: "새 이름",
    });
    expect(renamed).toMatchObject({
      status: 200,
      body: { doc: { title: "새 이름", rev: 2 } },
    });
    const searched = (await (
      await search(hub, ann.pass, { q: "이름표낱말" })
    ).json()) as HubSearchResult;
    expect(searched.hits.map((hit) => hit.title)).toEqual(["새 이름"]);
  });

  test("the list pages newest change first, and a page's end is where the next begins", async () => {
    const folder = `/페이지${randomUUID().slice(0, 8)}`;
    const made: string[] = [];
    for (let index = 0; index < 101; index += 1) {
      made.push((await newDoc(ann.pass, `${index}`, { folder })).doc.id);
    }
    const first = await call<HubDocList>(
      bob.pass,
      "GET",
      `/docs?folder=${encodeURIComponent(folder)}`,
    );
    expect(first.body.docs).toHaveLength(100);
    expect(first.body.next).not.toBeNull();
    const second = await call<HubDocList>(
      bob.pass,
      "GET",
      `/docs?folder=${encodeURIComponent(folder)}&cursor=${first.body.next}`,
    );
    expect(second.body).toMatchObject({ next: null });
    const listed = [...first.body.docs, ...second.body.docs].map(
      (one) => one.id,
    );
    expect(listed).toEqual([...made].reverse());
    expect((await call(bob.pass, "GET", "/docs?cursor=nope")).status).toBe(400);
  });

  test.each([
    ["no title", { markdown: "a" }, "title"],
    ["somebody else's me:", { title: "t", visibility: "me:someone" }, null],
    [
      "blocks and markdown both",
      { title: "t", markdown: "a", blocks: [] },
      "blocks",
    ],
    [
      "a bad block",
      { title: "t", blocks: [{ kind: "heading1", text: "a\nb" }] },
      "blocks[0].text",
    ],
  ])("POST /docs refuses %s", async (_name, body, field) => {
    const reply = await call(ann.pass, "POST", "/docs", body);
    if (field === null) expect(reply).toMatchObject({ status: 403 });
    else expect(reply).toMatchObject({ status: 400, body: { field } });
  });
});
