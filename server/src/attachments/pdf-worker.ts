/**
 * One PDF, read off the server's thread (`readPdf` in extract.ts starts this and ends it).
 *
 * Built as its own entry beside the server's bundle (server/Dockerfile), because a worker is loaded
 * from a file at run time and `bun build` does not follow `new Worker(...)` into its output.
 */
import { readPdfHere } from "./extract";

declare const self: Worker;

self.onmessage = async (event: MessageEvent<Uint8Array>) => {
  try {
    postMessage({ ok: true, extracted: await readPdfHere(event.data) });
  } catch (error) {
    // The name only, as the service logs it: never the words of the file.
    postMessage({
      ok: false,
      name: error instanceof Error ? error.name : "Error",
    });
  }
};
