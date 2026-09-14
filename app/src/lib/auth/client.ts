import { createAuthClient } from "better-auth/react";
import { genericOAuthClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [genericOAuthClient()],
});

export type SignInProvider = "google" | "kakao" | "naver";

/**
 * A start the server refused: the status and the code, which are facts, and none of its prose.
 *
 * The message used to be better-auth's sentence, and the sign-in screen printed it — "Too many
 * requests. Please try again later." on a Korean screen. The screen now says what the code means
 * (`sign-in-refusal.ts`), and this message is for a console, not a person.
 */
export class SignInRefusedError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null) {
    super(`sign-in refused: ${status}${code ? ` ${code}` : ""}`);
    this.name = "SignInRefusedError";
    this.status = status;
    this.code = code;
  }
}

export async function signInWithProvider(
  provider: SignInProvider,
  next = "/",
  /**
   * Through the fleet's broker (`laf`) rather than a directly registered
   * OAuth app. The pressed button still decides which provider the person
   * meets: it rides along and becomes the broker's provider_hint.
   */
  viaBroker = false,
) {
  // Resolved against our own origin by the caller; this only joins it to the host.
  const callbackURL = new URL(next, window.location.origin).toString();
  /*
   * THE CALLBACK'S ERROR PAGE IS THIS APP'S SIGN-IN SCREEN, with where they were going.
   *
   * Without it better-auth sends a failed callback to its own `/api/auth/error`, which on a production
   * deployment is `302 /?error=<code>` — losing the destination, and rewriting any code with a
   * character it does not like to `UNKNOWN`. Measured: the rehearsal VM's page answers this
   * deployment's own refusal of an unlisted email, `This_deployment_belongs_to_someone_else.`, with
   * `/?error=UNKNOWN`, and a local production stack landed an unlisted sign-in on
   * `/sign?redirect=/?error=UNKNOWN`. With it, the same sign-in lands on
   * `/sign?redirect=/settings&error=This_deployment_belongs_to_someone_else.`. (A provider's own
   * `?error=` on the broker's road, and a state that cannot be read at all, still take better-auth's
   * page; the screen reads those too.)
   */
  const errorCallbackURL = new URL(
    next === "/"
      ? "/sign"
      : `/sign?${new URLSearchParams({ redirect: next }).toString()}`,
    window.location.origin,
  ).toString();
  const result = viaBroker
    ? await authClient.signIn.oauth2({
        providerId: "laf",
        callbackURL,
        errorCallbackURL,
        additionalData: { provider },
      })
    : await authClient.signIn.social({
        provider: provider as never,
        callbackURL,
        errorCallbackURL,
      });

  if (result.error) {
    const { status, code } = result.error as {
      status?: number;
      code?: unknown;
    };
    throw new SignInRefusedError(
      typeof status === "number" ? status : 0,
      typeof code === "string" ? code : null,
    );
  }
}
