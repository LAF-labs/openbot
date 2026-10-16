import { randomUUID } from "node:crypto";
import type { HubFilePut } from "../../../shared/hub/protocol";
import { hubTaskMembers } from "../../src/db/schema";
import type { TestHub } from "./hub";

export type UploadInput = {
  meta: Record<string, unknown>;
  text?: string;
  bytes: Uint8Array<ArrayBuffer> | string;
  mime?: string;
  key?: string;
};

/** `PUT /files` as a VM sends it: multipart, with an idempotency key. */
export function upload(
  hub: TestHub,
  pass: string,
  input: UploadInput,
): Promise<Response> {
  const form = new FormData();
  form.append(
    "meta",
    new Blob([JSON.stringify(input.meta)], { type: "application/json" }),
  );
  if (input.text !== undefined) form.append("text", input.text);
  form.append(
    "blob",
    new Blob([input.bytes], {
      type: input.mime ?? "application/octet-stream",
    }),
    "blob",
  );
  return fetch(`${hub.url}/hub/v1/files`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${pass}`,
      "idempotency-key": input.key ?? randomUUID(),
    },
    body: form,
  });
}

/** An upload that must succeed. */
export async function put(
  hub: TestHub,
  pass: string,
  input: UploadInput,
): Promise<HubFilePut> {
  const response = await upload(hub, pass, input);
  const body = (await response.json()) as HubFilePut;
  if (response.status !== 200) {
    throw new Error(
      `upload answered ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  return body;
}

export function search(
  hub: TestHub,
  pass: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${hub.url}/hub/v1/search`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${pass}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/** Task membership, written directly: the tasks change will own the route that does it. */
export async function joinTask(
  hub: TestHub,
  taskId: string,
  memberId: string,
): Promise<void> {
  await hub.database.insert(hubTaskMembers).values({ taskId, memberId });
}
