/**
 * Every request this VM makes to its company hub goes through here: the pass, the headers the
 * hub's trail joins on, the retries, and the one translation of a failure into a fact.
 *
 * RETRIED ONLY WHERE A SECOND TRY CAN BE ANSWERED DIFFERENTLY. A network failure or a 5xx is the
 * hub not answering, and is tried again after 0.5 s, 2 s and 8 s — `fleet/notify.ts`'s discipline,
 * stretched for a hub that may be mid-upgrade (about fifteen seconds). A 4xx is the hub
 * understanding the request and refusing it; the same bytes get the same answer, so it is never
 * retried. A 429 is the one 4xx that asks to be retried, after `Retry-After`.
 *
 * THE PASS GOES IN ONE HEADER AND NOWHERE ELSE. Never into a URL, a log line or an error message:
 * this module throws nothing that carries a request, and the facts it returns are codes.
 */
import {
  HUB_FACTS,
  HUB_HEADERS,
  HUB_PREFIX,
} from "../../../shared/hub/protocol";

export type HubAnswer<T> =
  | { ok: true; status: number; body: T }
  | {
      ok: false;
      /** Null when the hub never answered. */
      status: number | null;
      /** One of `HUB_FACTS`, or the hub's own `laf:` code for a refusal it named. */
      code: string;
      /** The field the hub named in refusing, so the person is told which part to change. */
      field?: string;
    };

export type HubRequest = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Under `HUB_PREFIX`: `/me`, `/sync?since=4`. */
  path: string;
  body?: unknown;
  idempotencyKey?: string;
  /** `x-laf-run`. */
  run?: string;
  /** `x-laf-origin`: chat, room, job or person. */
  origin?: string;
  /** False for one attempt only. The outbox spaces its own attempts. */
  retry?: boolean;
};

/**
 * One request whose body or answer is bytes rather than JSON: a team file going up, or coming back
 * down. Tried once — a body that is a stream cannot be sent twice, and a download a person started
 * is theirs to press again.
 */
export type HubRawRequest = {
  method: "GET" | "PUT";
  path: string;
  /** Passed as they are: `content-type`, `content-length`. The pass is added here, never there. */
  headers?: Record<string, string>;
  body?: ReadableStream<Uint8Array> | null;
  idempotencyKey?: string;
  origin?: string;
  /** Aborted with the person's own request, so a closed tab stops the hub sending. */
  signal?: AbortSignal;
};

export type HubRawAnswer =
  | { ok: true; response: Response }
  | { ok: false; status: number | null; code: string };

export type HubHttp = {
  request<T = unknown>(request: HubRequest): Promise<HubAnswer<T>>;
  /** Bytes in or out, one attempt. A refusal is read into a fact the way `request` reads it. */
  raw?(request: HubRawRequest): Promise<HubRawAnswer>;
  /** The `ws(s)://…/events?since=` address and the headers its upgrade carries. */
  socket(since: number): { url: string; headers: Record<string, string> };
};

/** The waits between attempts: three retries after the first try. */
export const HUB_RETRY_MS = [500, 2_000, 8_000] as const;

/** One attempt's bound. A hub that has not answered in this long is not answering. */
const ATTEMPT_TIMEOUT_MS = 5_000;

/** The longest `Retry-After` honoured. Longer is a hub that is not coming back in this call. */
const RETRY_AFTER_CAP_MS = 30_000;

export type HubHttpOptions = {
  /** `LAF_HUB_URL`: an origin. */
  url: string;
  /** `LAF_HUB_VM_KEY`. */
  vmKey: string;
  /** `PUBLIC_ORIGIN`, sent as `x-laf-vm` when present. */
  vmOrigin?: string;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
};

/** What a status the hub answered with says, as a fact. */
export function factOfStatus(status: number, body: unknown): string {
  if (status === 401) return HUB_FACTS.passRefused;
  if (status === 403) return HUB_FACTS.forbidden;
  if (status === 404) return HUB_FACTS.notFound;
  if (status >= 500) return HUB_FACTS.unreachable;
  const code = (body as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("laf:")
    ? code
    : HUB_FACTS.forbidden;
}

/** A field name the hub's refusal carried — a name only, never the hub's prose. */
const FIELD_SHAPE = /^[A-Za-z]{1,40}$/;

function fieldOf(body: unknown): { field?: string } {
  const field = (body as { field?: unknown } | null)?.field;
  return typeof field === "string" && FIELD_SHAPE.test(field) ? { field } : {};
}

function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return HUB_RETRY_MS[0];
  return Math.min(seconds * 1_000, RETRY_AFTER_CAP_MS);
}

export function createHubHttp(options: HubHttpOptions): HubHttp {
  const send = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const base = `${options.url}${HUB_PREFIX}`;
  const identity: Record<string, string> = {
    authorization: `Bearer ${options.vmKey}`,
    ...(options.vmOrigin ? { [HUB_HEADERS.vm]: options.vmOrigin } : {}),
  };

  return {
    async request<T>(request: HubRequest): Promise<HubAnswer<T>> {
      const headers: Record<string, string> = {
        ...identity,
        accept: "application/json",
        ...(request.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(request.idempotencyKey
          ? { [HUB_HEADERS.idempotencyKey]: request.idempotencyKey }
          : {}),
        ...(request.run ? { [HUB_HEADERS.run]: request.run } : {}),
        ...(request.origin ? { [HUB_HEADERS.origin]: request.origin } : {}),
      };
      const body =
        request.body === undefined ? undefined : JSON.stringify(request.body);
      const attempts = request.retry === false ? 1 : HUB_RETRY_MS.length + 1;

      let last: HubAnswer<T> = {
        ok: false,
        status: null,
        code: HUB_FACTS.unreachable,
      };
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        let wait: number = HUB_RETRY_MS[attempt] ?? 0;
        try {
          const response = await send(`${base}${request.path}`, {
            method: request.method ?? "GET",
            headers,
            ...(body === undefined ? {} : { body }),
            signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
          });
          const parsed: unknown = await response.json().catch(() => null);
          if (response.ok) {
            return { ok: true, status: response.status, body: parsed as T };
          }
          last = {
            ok: false,
            status: response.status,
            code: factOfStatus(response.status, parsed),
            ...fieldOf(parsed),
          };
          if (response.status === 429) {
            wait = retryAfterMs(response.headers.get("retry-after"));
            last = {
              ok: false,
              status: 429,
              code: HUB_FACTS.unreachable,
            };
          } else if (response.status < 500) {
            return last;
          }
        } catch {
          // Refused, reset, timed out: the hub did not answer. Which of them is not the VM's to act on.
          last = { ok: false, status: null, code: HUB_FACTS.unreachable };
        }
        if (attempt < attempts - 1) await sleep(wait);
      }
      return last;
    },

    async raw(request) {
      const headers: Record<string, string> = {
        ...(request.headers ?? {}),
        ...identity,
        ...(request.idempotencyKey
          ? { [HUB_HEADERS.idempotencyKey]: request.idempotencyKey }
          : {}),
        ...(request.origin ? { [HUB_HEADERS.origin]: request.origin } : {}),
      };
      try {
        const response = await send(`${base}${request.path}`, {
          method: request.method,
          headers,
          ...(request.body ? { body: request.body, duplex: "half" } : {}),
          // No timeout of this module's own: a gigabyte takes as long as it takes. The person's own
          // request ending is what stops it.
          ...(request.signal ? { signal: request.signal } : {}),
        } as RequestInit);
        if (response.ok) return { ok: true, response };
        const parsed: unknown = await response.json().catch(() => null);
        /*
         * An upload's refusals name themselves — the hub is full (507), one file is too large (413),
         * the hub is taking as many uploads as it can (503) — and each wants different words than
         * "cannot reach the company server". So a `laf:` code the hub named is kept, here only;
         * a 401 is always the pass, whatever the body says.
         */
        const named = (parsed as { code?: unknown } | null)?.code;
        return {
          ok: false,
          status: response.status,
          code:
            response.status !== 401 &&
            typeof named === "string" &&
            named.startsWith("laf:")
              ? named
              : response.status === 429
                ? HUB_FACTS.unreachable
                : factOfStatus(response.status, parsed),
        };
      } catch {
        return { ok: false, status: null, code: HUB_FACTS.unreachable };
      }
    },

    socket(since) {
      const url = new URL(`${base}/events`);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("since", String(since));
      return { url: url.toString(), headers: { ...identity } };
    },
  };
}
