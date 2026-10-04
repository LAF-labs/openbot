/**
 * What a computer call hands back to the model, read off the reply the acting route gave.
 *
 * ONE MAPPING, TWO CALLERS. The window made computer calls over HTTP and turned the status and body
 * into the outcome the model reads (`app/src/lib/copilot/computer-tools.tsx`); a turn the server
 * owns makes the same calls without HTTP (`server/src/turns/chat-tools.ts`) and has to hand the
 * model the same object — a Bot that reads `staleRefs: true` from one path and a bare failure from
 * the other would learn two different things about the same page. So the reading lives here, and
 * both of them call it.
 *
 * The pause for a person (a 409 carrying `awaitingApproval`) is NOT read here: each caller waits
 * for the answer in its own way and sends the same call again, so the model never sees that reply.
 */
import { noteTexts, toolResultText } from "../prompt/tool-results.ko";

/** What every computer call returns to the model: the result, or a reason it did not happen. */
export type ComputerOutcome = Record<string, unknown> & { ok: boolean };

export function computerReplyOutcome(
  status: number,
  body: Record<string, unknown> | null,
): ComputerOutcome {
  if (status < 200 || status >= 300) {
    /*
     * The computer answers with a fact code where it has one — `laf:human_has_control` is the whole
     * of the sentence the container used to ship — so the words the model reads are chosen here, in
     * Korean, rather than by a service that has never heard of a locale. Anything that is not a code
     * is passed through: an English sentence from somewhere upstream reaching the person is a
     * regression, and it is visible rather than swallowed.
     */
    const said = typeof body?.error === "string" ? body.error : "";
    const code = said.startsWith("laf:") ? said : undefined;
    return {
      ok: false,
      ...(code ? { code } : {}),
      reason: code ? toolResultText(code) : said || "That did not work.",
      // Preserve refusal/stale-ref/control distinctions for the model's next step.
      ...(status === 403 ? { refused: true, rule: body?.rule ?? null } : {}),
      /*
       * By the code: the server answers a failure as its code and nothing beside it, so the
       * container's `humanHasControl: true` never reached this line, and a person at the wheel was
       * handed to the model as `staleRefs: true` beside a sentence telling it to wait.
       */
      ...(status === 409
        ? code === "laf:human_has_control" || body?.humanHasControl === true
          ? { humanHasControl: true }
          : { staleRefs: true }
        : {}),
    };
  }
  /*
   * The facts the browser noticed, put into the words the model reads. The computer ships
   * `{code: "laf:dialog", message}` and knows no locale; translated here, on the one path every
   * successful computer call comes back through.
   */
  const said = body ? noteTexts(body.notes) : undefined;
  return { ok: true, ...(body ?? {}), ...(said ? { notes: said } : {}) };
}

/**
 * The navigation result as the model is shown it: the page, not everything the gateway knew about
 * the trip there. The window's handler has always cut it to these fields.
 */
export function navigationOutcome(result: ComputerOutcome): ComputerOutcome {
  if (!result.ok) return result;
  return {
    ok: true,
    title: result.title,
    url: result.url,
    text: result.text,
    truncated: result.truncated,
    // The site refused ("Access Denied"): the card ends the task on it (`task-ending.ts`).
    ...(typeof result.httpStatus === "number"
      ? { httpStatus: result.httpStatus }
      : {}),
  };
}
