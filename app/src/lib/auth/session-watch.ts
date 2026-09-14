/**
 * The one moment every request shares: the server saying the session is over.
 *
 * MEASURED 2026-09-10 (audit A4, finding 2): with every `/api/**` answering 401, pressing 루틴 in
 * the rail put "루틴을 불러오지 못했습니다 · 다시 시도" on the screen, and 봇 put "봇 목록을 불러오지
 * 못했습니다" — and a minute later it was still there. Four call sites in the app read a 401; the
 * other hundred-odd `fetch(` calls turn every non-OK status into the same sentence about loading.
 * A fleet sign-in is a broker session, and its expiry is a normal event, not a fault: the person
 * should be at the door, with where they were carried through it.
 *
 * There is no shared HTTP client to hook (audit finding 11 — a `lib/http.ts` would be the place),
 * so this wraps `fetch` itself, once, at boot. Every request in the app goes through it, CopilotKit's
 * runtime calls included, and none of the hundred call sites needs to learn a convention. It changes
 * nothing about any response: it looks at the status and lets it go.
 */

export const sessionState = new EventTarget();
/** The server answered 401 to a request this app made while it thought it was signed in. */
export const SESSION_LOST = "session-lost";

/**
 * A `SESSION_LOST` event, and the refusal's code when the body had one (`session-revoked.ts`).
 *
 * A property on a plain `Event` rather than a `CustomEvent`'s `detail`: under the test DOM the two
 * constructors can come from different places than this module's `EventTarget`, and a `CustomEvent`
 * the target did not make was refused outright (see `session-revoked.ts` for the measurement).
 */
export type SessionLostEvent = Event & { code?: string | null };

/**
 * Is this request one of ours: same origin, under `/api/`.
 *
 * Only those can carry a verdict on the session. A 401 from somewhere else — an image, a plugin's
 * own endpoint reached through a proxy, a third party — says nothing about this deployment.
 */
export function isApiRequest(
  input: RequestInfo | URL,
  origin = window.location.origin,
): boolean {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  try {
    const url = new URL(raw, origin);
    return url.origin === origin && url.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

/**
 * Watch the session through `fetch`. Returns the way to stop watching.
 *
 * Installed over whatever `fetch` is at the time, and restores exactly that: a test that stubs
 * `fetch` before watching gets its stub back, and a test that stubs it AFTER simply replaces the
 * watch, which is the same thing a page reload does.
 */
export function watchSession(
  scope: { fetch: typeof fetch } = globalThis,
): () => void {
  const original = scope.fetch;
  const watching = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const response = await original(input, init);
    if (response.status === 401 && isApiRequest(input)) {
      // Made now, while this request runs, exactly as it always was; only the dispatch waits.
      const lost: SessionLostEvent = new Event(SESSION_LOST);
      /*
       * The code decides which sentence the door shows, so it is read — from a copy, after the
       * response has been handed back, so the caller's own read of the body is untouched and
       * nothing waits on this one.
       */
      let copy: Response | undefined;
      try {
        copy = response.clone();
      } catch {
        // A body that cannot be copied still ended the session; it just says nothing about why.
      }
      void (copy ? copy.json() : Promise.resolve(null))
        .then(
          (body: { code?: unknown } | null) =>
            typeof body?.code === "string" ? body.code : null,
          () => null,
        )
        .then((code) => {
          lost.code = code;
          sessionState.dispatchEvent(lost);
        });
    }
    return response;
  };
  // Bun's `fetch` carries `preconnect`; the wrapper has to be the same shape to be assignable.
  scope.fetch = Object.assign(watching, {
    preconnect: original.preconnect,
  }) as unknown as typeof fetch;
  return () => {
    scope.fetch = original;
  };
}
