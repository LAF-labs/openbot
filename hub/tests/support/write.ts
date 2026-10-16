import { randomUUID } from "node:crypto";
import type { HubEvent, HubSync } from "../../../shared/hub/protocol";
import type { TestHub } from "./hub";

export type Reply = { status: number; body: Record<string, unknown> };

/** A member's call to the hub, a write carrying a fresh `Idempotency-Key` unless one is given. */
export async function call(
  hub: TestHub,
  pass: string,
  method: "GET" | "PUT" | "POST" | "DELETE",
  path: string,
  options: { body?: unknown; key?: string | null; run?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${pass}`,
  };
  if (method !== "GET" && options.key !== null) {
    headers["idempotency-key"] = options.key ?? randomUUID();
  }
  if (options.run) headers["x-laf-run"] = options.run;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${hub.url}/hub/v1${path}`, {
    method,
    headers,
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

/** Every event after `since` this member may see. */
export async function eventsAfter(
  hub: TestHub,
  pass: string,
  since: number,
): Promise<HubEvent[]> {
  const response = await fetch(`${hub.url}/hub/v1/sync?since=${since}`, {
    headers: { authorization: `Bearer ${pass}` },
  });
  return ((await response.json()) as HubSync).events;
}

/** The newest event number now, as `/me` reports it. */
export async function headOf(hub: TestHub, pass: string): Promise<number> {
  const response = await fetch(`${hub.url}/hub/v1/me`, {
    headers: { authorization: `Bearer ${pass}` },
  });
  return ((await response.json()) as { seq: number }).seq;
}
