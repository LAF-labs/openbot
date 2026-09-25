import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { ATTACHMENT_MAX_BYTES, type AttachmentPart } from "@shared/attachments";
import { toVisibleChatItems } from "@/components/channels/chat-messages";
import type { ComposerDraft } from "@/components/channels/composer/draft";
import { reduceQueue } from "@/components/channels/composer/queue";
import { contentOf } from "@/lib/attachments/message";
import {
  refusalBeforeUpload,
  uploadRefusalText,
} from "@/lib/attachments/upload";
import { ko } from "@/lib/i18n-ko";

/** A sentence the Korean table carries, whichever locale the test process resolved to. */
function isTranslated(said: string): boolean {
  return said in ko || Object.values(ko).includes(said);
}

/**
 * A file in the composer, in the message and in the transcript: the parts that can be checked
 * without a browser. The upload and the model are checked on the real stack.
 */

const receipt: AttachmentPart = {
  type: "binary",
  mimeType: "image/jpeg",
  id: "11111111-1111-4111-8111-111111111111",
  filename: "영수증.jpg",
};
const sales: AttachmentPart = {
  type: "binary",
  mimeType: "text/csv",
  id: "22222222-2222-4222-8222-222222222222",
  filename: "매출.csv",
};

describe("the message a file rides in", () => {
  test("words alone stay a string, byte for byte what they always were", () => {
    expect(contentOf("안녕", [])).toBe("안녕");
  });

  test("files go first and the words after; files alone need no words", () => {
    expect(contentOf("합계 알려줘", [receipt])).toEqual([
      receipt,
      { type: "text", text: "합계 알려줘" },
    ]);
    expect(contentOf("", [receipt, sales])).toEqual([receipt, sales]);
  });

  test("the transcript draws the files of a message, including one with no words", () => {
    const messages = [
      { id: "m1", role: "user", content: contentOf("합계 알려줘", [receipt]) },
      { id: "m2", role: "user", content: contentOf("", [sales]) },
    ] as Message[];
    expect(toVisibleChatItems(messages)).toEqual([
      {
        kind: "text",
        id: "m1",
        role: "user",
        text: "합계 알려줘",
        attachments: [receipt],
      },
      { kind: "text", id: "m2", role: "user", text: "", attachments: [sales] },
    ]);
  });
});

describe("files parked while the Bot works", () => {
  const draft = (text: string, attachments: AttachmentPart[] = []) =>
    ({
      text,
      commandIds: [],
      isEmpty: text.length === 0,
      ...(attachments.length ? { attachments } : {}),
    }) satisfies ComposerDraft;

  test("go with the words they were parked with, all of them, in order", () => {
    const first = reduceQueue([], {
      type: "submit",
      id: "q1",
      busy: true,
      draft: draft("", [receipt]),
    });
    const second = reduceQueue(first.queue, {
      type: "submit",
      id: "q2",
      busy: true,
      draft: draft("이것도 봐 줘", [sales]),
    });
    const settled = reduceQueue(second.queue, { type: "settle" });
    expect(settled.run).toEqual({
      attachments: [receipt, sales],
      text: "이것도 봐 줘",
      commandIds: [],
      isEmpty: false,
    });
  });
});

describe("what the composer says before anything is sent", () => {
  const file = (name: string, size: number, type = "") =>
    ({ name, size, type }) as File;

  test("takes a photo, a sheet, a CSV and a PDF", () => {
    for (const name of ["영수증.jpg", "매출.xlsx", "매출.csv", "메뉴.pdf"]) {
      expect(refusalBeforeUpload(file(name, 1000), true)).toBeNull();
    }
  });

  test("says why, in Korean, for a wrong type, an empty file and a large one", () => {
    const wrong = refusalBeforeUpload(file("setup.exe", 1000), true);
    const big = refusalBeforeUpload(
      file("매출.xlsx", ATTACHMENT_MAX_BYTES + 1),
      true,
    );
    const empty = refusalBeforeUpload(file("매출.csv", 0), true);
    for (const said of [wrong, big, empty]) {
      expect(said).not.toBeNull();
      expect(isTranslated(said as string)).toBe(true);
    }
  });

  test("does not offer photos where the model cannot see them", () => {
    const said = refusalBeforeUpload(file("영수증.jpg", 1000), false);
    expect(said).not.toBeNull();
    expect(said).toBe(uploadRefusalText("laf:attachment_image_unsupported"));
  });

  test("every refusal the server can send has Korean words, and an unknown one has a fallback", () => {
    for (const code of [
      "laf:attachment_too_large",
      "laf:attachment_type_unsupported",
      "laf:attachment_image_unsupported",
      "laf:attachment_empty",
      "laf:attachment_unreadable",
      "laf:attachment_network",
    ]) {
      const said = uploadRefusalText(code);
      expect(said).not.toContain("laf:");
      expect(isTranslated(said)).toBe(true);
    }
  });
});
