/**
 * The API server's side of the converter: hand it a file, get back what the file is and says.
 *
 * THREE PLACES A FILE CAN BE READ, AND ONE THAT IS NEVER ALLOWED.
 *
 * - `sidecar` — `LAF_CONVERTER_SOCKET` names the socket of the `converter` service: no network, not
 *   root, no capabilities, a read-only root, a fresh child per file (converter-daemon.ts). Every
 *   deployment. Set, it is the only place: a socket that does not answer refuses the file, and
 *   nothing falls back to reading it here.
 * - `local` — no socket, not production: a laptop, a test. The same child as the sidecar's, started
 *   from this process with the same bounds and an empty environment, but as this user and with this
 *   machine's network. Development keeps working without compose, and a hung parser is still
 *   killed rather than wedging the server.
 * - `refused` — no socket in production. A deployment that lost the sidecar (a compose file from
 *   before it, a spare claimed without it) refuses every file with its own code and says so in the
 *   log, rather than quietly parsing hostile bytes as root beside every key this server holds.
 * - In this process: never, anywhere. SheetJS is synchronous; a file that loops it would stop this
 *   server answering anybody, and nothing here could kill it.
 */
import { ATTACHMENT_MAX_BYTES } from "../../../shared/attachments";
import { log } from "../log";
import { conversionFrom, FILE_NAME_HEADER } from "./conversion";
import {
  CONVERSION_LIMITS,
  type ConversionFailure,
  type ConversionOutcome,
  convertInFreshProcess,
  jobCommandFor,
} from "./converter-process";

export type ConverterSetting =
  | { kind: "sidecar"; socketPath: string }
  | { kind: "local" }
  | { kind: "refused" };

/** Where this deployment reads files, from its configuration (config.ts). */
export function converterSettingFor(input: {
  socketPath: string | undefined;
  production: boolean;
}): ConverterSetting {
  if (input.socketPath)
    return { kind: "sidecar", socketPath: input.socketPath };
  return input.production ? { kind: "refused" } : { kind: "local" };
}

/** Beyond what the child itself can fail with: the file was too large, or nobody could read it. */
export type ConvertFailure = ConversionFailure | "too_large" | "unavailable";

export type ConvertOutcome =
  | Extract<ConversionOutcome, { ok: true }>
  | { ok: false; failure: ConvertFailure };

export type Converter = {
  readonly setting: ConverterSetting["kind"];
  convert(input: { name: string; bytes: Uint8Array }): Promise<ConvertOutcome>;
};

/**
 * How long the server waits on the sidecar: two files' worth, since one may be ahead of this one in
 * its queue, and a margin for the socket. Past it the upload is answered rather than left hanging.
 */
const SIDECAR_WAIT_MS = CONVERSION_LIMITS.timeoutMs * 2 + 5_000;

const FAILURES: ReadonlySet<string> = new Set<ConversionFailure>([
  "timeout",
  "memory",
  "crashed",
  "malformed",
]);

/** The sidecar's answer, read as untrusted as the child's: it is on the other side of the same wall. */
function outcomeFrom(value: unknown): ConvertOutcome {
  if (typeof value !== "object" || value === null) {
    return { ok: false, failure: "malformed" };
  }
  const record = value as Record<string, unknown>;
  if (record.ok === true) {
    const conversion = conversionFrom(record.conversion);
    return conversion
      ? { ok: true, conversion }
      : { ok: false, failure: "malformed" };
  }
  return {
    ok: false,
    failure:
      typeof record.failure === "string" && FAILURES.has(record.failure)
        ? (record.failure as ConversionFailure)
        : "malformed",
  };
}

async function viaSidecar(
  socketPath: string,
  input: { name: string; bytes: Uint8Array },
  waitMs: number,
): Promise<ConvertOutcome> {
  let response: Response;
  try {
    response = await fetch("http://converter/convert", {
      method: "POST",
      unix: socketPath,
      // A copy on a plain ArrayBuffer: the body type wants one, and the bytes are the file's own.
      body: new Uint8Array(input.bytes),
      headers: {
        "content-type": "application/octet-stream",
        [FILE_NAME_HEADER]: encodeURIComponent(input.name),
      },
      signal: AbortSignal.timeout(waitMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    log.warn("converter_unreachable", {
      reason: timedOut
        ? "timeout"
        : error instanceof Error
          ? error.name
          : "unknown",
    });
    return { ok: false, failure: timedOut ? "timeout" : "unavailable" };
  }
  if (response.status === 413) return { ok: false, failure: "too_large" };
  if (!response.ok) {
    // Busy, or broken: either way the file was not read, and it is not the file's fault.
    log.warn("converter_unreachable", { status: response.status });
    return { ok: false, failure: "unavailable" };
  }
  return outcomeFrom(await response.json().catch(() => null));
}

export function createConverter(
  setting: ConverterSetting,
  options: {
    /** The child's entry for `local`. Defaults to this tree's `converter.ts`. */
    localEntry?: string;
    /** How long the server waits on the sidecar. A test shortens it. */
    sidecarWaitMs?: number;
  } = {},
): Converter {
  if (setting.kind === "refused") {
    log.warn("converter_missing", {
      note: "NODE_ENV is production and LAF_CONVERTER_SOCKET is unset, so every uploaded file is refused (laf:attachment_converter_unavailable) rather than read inside the API server. Run the compose file's `converter` service and pass its socket.",
    });
  }
  const localCommand = jobCommandFor(
    options.localEntry ?? `${import.meta.dir}/../converter.ts`,
  );
  return {
    setting: setting.kind,
    async convert(input) {
      if (input.bytes.byteLength > ATTACHMENT_MAX_BYTES) {
        return { ok: false, failure: "too_large" };
      }
      switch (setting.kind) {
        case "sidecar":
          return viaSidecar(
            setting.socketPath,
            input,
            options.sidecarWaitMs ?? SIDECAR_WAIT_MS,
          );
        case "local":
          return convertInFreshProcess(input, { command: localCommand });
        case "refused":
          log.warn("converter_refused_file", { setting: "refused" });
          return { ok: false, failure: "unavailable" };
      }
    },
  };
}
