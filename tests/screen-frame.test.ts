import { describe, expect, test } from "bun:test";
import {
  decodeScreenFrame,
  encodeScreenFrame,
  type FrameHeader,
} from "../shared/screen-frame";

/**
 * A live-screen frame on the wire (`shared/screen-frame.ts`): the computer writes it, the app reads
 * it, and the server passes it along without looking. One format, so it is tested once, here.
 */

const header: FrameHeader = {
  type: "frame",
  width: 1280,
  height: 800,
  site: "news.naver.com",
};

describe("a screen frame", () => {
  test("reads back as the header and the same picture", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const decoded = decodeScreenFrame(encodeScreenFrame(header, jpeg));
    expect(decoded?.header).toEqual(header);
    expect([...(decoded?.jpeg ?? [])]).toEqual([...jpeg]);
  });

  test("reads from an ArrayBuffer, as a browser socket hands it over", () => {
    const bytes = encodeScreenFrame(
      { ...header, site: null },
      new Uint8Array([9]),
    );
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
    expect(decodeScreenFrame(buffer as ArrayBuffer)?.header.site).toBeNull();
  });

  test("is a third smaller than the base64 JSON it replaced", () => {
    const jpeg = new Uint8Array(90_000).fill(7);
    const before = JSON.stringify({
      ...header,
      data: Buffer.from(jpeg).toString("base64"),
    }).length;
    expect(encodeScreenFrame(header, jpeg).length).toBeLessThan(before * 0.76);
  });

  test("anything else is not a frame", () => {
    expect(decodeScreenFrame(new Uint8Array([0, 0]))).toBeNull();
    expect(decodeScreenFrame(new Uint8Array([0, 0, 0, 99, 1]))).toBeNull();
    const notFrame = new TextEncoder().encode('{"type":"probe"}');
    const message = new Uint8Array(4 + notFrame.length);
    new DataView(message.buffer).setUint32(0, notFrame.length);
    message.set(notFrame, 4);
    expect(decodeScreenFrame(message)).toBeNull();
  });
});
