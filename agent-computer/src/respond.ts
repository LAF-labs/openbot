/**
 * How an answer leaves this process.
 *
 * Every route writes its body through here, so the shape of an answer is decided in one file.
 */

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A request's JSON body, or null for one that has none or cannot be read. */
export async function bodyOf<T>(request: Request): Promise<T | null> {
  return (await request.json().catch(() => null)) as T | null;
}

export function describe(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
