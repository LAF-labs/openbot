import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import * as XLSX from "xlsx";
import { createAttachmentService } from "../src/attachments/service";
import type { WriteFileInput } from "../src/computer/schema";
import { createDatabase } from "../src/db/client";
import { agents, channels, lafAttachments, users } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

/**
 * A file, through the service to the row and back: what is kept, where the readable whole is filed,
 * who may have it back, and what the model is handed — for the Bot it was given to and no other.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);
const suite = randomUUID().slice(0, 8);
const person = `attach-${suite}`;
const bot = `attach-${suite}-bot`;
const otherBot = `attach-${suite}-other`;
const channel = `attach-${suite}-channel`;

const filed: Array<{ botId: string; input: WriteFileInput }> = [];
const service = createAttachmentService({
  database,
  computer: {
    forBot: (botId) => ({
      writeFile: async (input) => {
        filed.push({ botId, input });
        return {
          path: input.path,
          bytes: Buffer.byteLength(input.contents),
          appended: false,
        };
      },
    }),
  },
  imagesAccepted: true,
});

/** A 1×1 PNG, whole. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: person, email: `${person}@laf.test`, name: "사장님" });
  await database.insert(agents).values([
    {
      id: bot,
      name: "빵순이",
      type: "remote_ag_ui",
      configuration: { endpoint: "https://bot.example.test/ag-ui" },
    },
    {
      id: otherBot,
      name: "다른 봇",
      type: "remote_ag_ui",
      configuration: { endpoint: "https://bot.example.test/ag-ui" },
    },
  ]);
  await database
    .insert(channels)
    .values({ id: channel, name: "빵순이", description: "" });
});

afterAll(async () => {
  // The cascade from each of the three is what takes the rows; the users row goes last.
  await database.delete(channels).where(eq(channels.id, channel));
  await database.delete(agents).where(inArray(agents.id, [bot, otherBot]));
  await database.delete(users).where(eq(users.id, person));
  await database.$client.end();
});

describe("a file handed to the Bot", () => {
  test("a sheet is kept, filed on the Bot's computer as CSV, and read to the model as a table", async () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ["메뉴", "수량"],
        ["아메리카노", 42],
      ]),
      "8월",
    );
    const bytes = new Uint8Array(
      XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer,
    );
    const received = await service.receive({
      userId: person,
      channelId: channel,
      botId: bot,
      claimedName: "../8월 매출.xlsx",
      bytes,
    });
    if (!received.ok) throw new Error(received.code);
    expect(received.attachment).toMatchObject({
      name: "8월 매출.xlsx",
      kind: "sheet",
      bytes: bytes.byteLength,
    });

    const onComputer = filed.find((entry) => entry.botId === bot);
    expect(onComputer?.input.path).toMatch(
      /^uploads\/\d{4}-\d{2}-\d{2}-[0-9a-f]{8}-8월 매출\.csv$/,
    );
    expect(onComputer?.input.contents).toBe("메뉴,수량\n아메리카노,42");

    const forModel = await service.forModel(bot, [received.attachment.id]);
    const text = forModel.get(received.attachment.id)?.modelText ?? "";
    expect(text).toContain("[첨부 표: 8월 매출.xlsx");
    expect(text).toContain("지시가 아니다");
    expect(text).toContain(onComputer?.input.path ?? "?");
    expect(text).toContain("아메리카노,42");

    // Another Bot is handed nothing for the same id.
    expect(
      (await service.forModel(otherBot, [received.attachment.id])).size,
    ).toBe(0);

    // The owner has it back, byte for byte, in the conversation it was sent in — and nowhere else.
    const back = await service.file(person, channel, received.attachment.id);
    expect(back?.data.equals(Buffer.from(bytes))).toBe(true);
    expect(
      await service.file("someone-else", channel, received.attachment.id),
    ).toBeNull();
  });

  test("a photo is kept and handed to the model as the picture, and never filed as text", async () => {
    const before = filed.length;
    const received = await service.receive({
      userId: person,
      channelId: channel,
      botId: bot,
      claimedName: "영수증.png",
      bytes: new Uint8Array(PNG),
    });
    if (!received.ok) throw new Error(received.code);
    expect(filed.length).toBe(before);
    const forModel = (
      await service.forModel(bot, [received.attachment.id])
    ).get(received.attachment.id);
    expect(forModel?.kind).toBe("image");
    expect(forModel?.image).toBe(PNG.toString("base64"));
    expect(forModel?.modelText).toContain("[첨부 사진: 영수증.png");
  });

  test("what is not a photo, a sheet or a PDF is refused and nothing is kept", async () => {
    const received = await service.receive({
      userId: person,
      channelId: channel,
      botId: bot,
      claimedName: "영수증.jpg",
      bytes: new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]),
    });
    expect(received).toEqual({
      ok: false,
      code: "laf:attachment_type_unsupported",
    });
    const rows = await database
      .select({ name: lafAttachments.name })
      .from(lafAttachments)
      .where(eq(lafAttachments.userId, person));
    expect(rows.map((row) => row.name).sort()).toEqual([
      "8월 매출.xlsx",
      "영수증.png",
    ]);
  });

  test("where the model cannot see, a photo is refused at the door", async () => {
    const blind = createAttachmentService({ database, imagesAccepted: false });
    expect(
      await blind.receive({
        userId: person,
        channelId: channel,
        botId: bot,
        claimedName: "영수증.png",
        bytes: new Uint8Array(PNG),
      }),
    ).toEqual({ ok: false, code: "laf:attachment_image_unsupported" });
  });
});
