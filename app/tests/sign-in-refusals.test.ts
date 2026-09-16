import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RATE_LIMITED } from "../../server/src/middleware/security";
import {
  KNOWN_REFUSAL_KEYS,
  refusalForCode,
  refusalForStart,
  refusalKey,
  refusalOnArrival,
  refusalSentence,
  type SignInRefusal,
} from "../src/lib/auth/sign-in-refusal";
import { SESSION_REVOKED } from "../src/lib/auth/session-revoked";
import { ko } from "../src/lib/i18n-ko";
import type { Scenario, Shown } from "./support/sign-in-render";

/**
 * A REFUSED SIGN-IN SAYS WHY, IN KOREAN, WHICHEVER ROAD IT CAME BACK BY — AND NEVER IN ENGLISH.
 *
 * The screen used to print better-auth's message as it came ("Too many requests. Please try again
 * later."), and drew nothing at all for a refusal that came back through the callback. Every code
 * below is RENDERED: the screen is opened, in Korean, the way the refusal opens it, and what is under
 * the buttons is read back.
 *
 * Where the codes come from matters as much as what they say, so the callback's are read out of the
 * better-auth this workspace installed rather than copied here: an upgrade that adds a code fails
 * this file instead of drawing the generic sentence on a VM.
 */

const betterAuthDist = dirname(
  fileURLToPath(import.meta.resolve("better-auth")),
);
const readDist = (path: string) =>
  readFileSync(join(betterAuthDist, path), "utf8");

/** Every literal code better-auth's two callbacks redirect with (`redirectOnError(ctx, url, "…")`). */
function callbackCodes(): string[] {
  const codes = new Set<string>();
  for (const file of [
    "api/routes/callback.mjs",
    "plugins/generic-oauth/routes.mjs",
    "oauth2/link-account.mjs",
    "oauth2/state.mjs",
  ]) {
    const source = readDist(file);
    for (const match of source.matchAll(
      /redirectOnError\(\s*\w+,\s*[^,]+,\s*"([^"]+)"/g,
    )) {
      codes.add(match[1] as string);
    }
    // …and the fallback when the provider sent neither an error nor a code: `error || "oAuth_code_missing"`.
    for (const match of source.matchAll(
      /redirectOnError\(\s*\w+,\s*[^,]+,\s*[\w.]+\s*\|\|\s*"([^"]+)"/g,
    )) {
      codes.add(match[1] as string);
    }
  }
  // The state's own refusals (`state.mjs`), which `oauth2/state.mjs` passes on as their code.
  for (const match of readDist("state.mjs").matchAll(/code: "([a-z_]+)"/g)) {
    codes.add(match[1] as string);
  }
  // `oauth2/state.mjs`: a state that throws something other than a StateError.
  for (const match of readDist("oauth2/state.mjs").matchAll(
    /let code = "([a-z_]+)"/g,
  )) {
    codes.add(match[1] as string);
  }
  // The account step returns sentences, which both callbacks send on with the spaces swapped.
  for (const match of readDist("oauth2/link-account.mjs").matchAll(
    /error: "([a-z ]+)"/g,
  )) {
    codes.add((match[1] as string).split(" ").join("_"));
  }
  return [...codes];
}

/**
 * This deployment's own refusal of an email not on its list, as the callback spells it: the hook's
 * message with the spaces swapped (`result.error.split(" ").join("_")`).
 *
 * The message was a sentence and arrived as `This_deployment_belongs_to_someone_else.`; since
 * 2026-09-14 it is the code `laf:sign_in_not_admitted`, in the message and in the error's `code` —
 * which is also what makes better-auth redirect a struck-off account's SESSION refusal here instead
 * of answering the callback with raw JSON (`server/tests/laf-oidc.integration.test.ts`).
 */
const signInSource = readFileSync(
  join(import.meta.dir, "../../server/src/auth/index.ts"),
  "utf8",
);

/**
 * A code the sign-in hooks refuse with, read out of the server: exported under `name`, and thrown
 * through the one `refuse` that puts it in both fields (`new APIError("FORBIDDEN", { message: code,
 * code })`), which is what lets either road carry it here.
 */
const refusalCode = (name: string): string => {
  const code = new RegExp(`export const ${name} = "([^"]+)"`).exec(
    signInSource,
  )?.[1];
  const inBothFields =
    /new APIError\("FORBIDDEN", \{\s*message: code,\s*code,?\s*\}\)/.test(
      signInSource,
    );
  const thrown = new RegExp(`refuse\\(${name}\\)`).test(signInSource);
  if (!code || !inBothFields || !thrown) {
    throw new Error(`server/src/auth/index.ts no longer refuses with ${name}`);
  }
  return code.split(" ").join("_");
};

const refusedEmailCode = refusalCode("SIGN_IN_NOT_ADMITTED");

/**
 * The deployment already belongs to somebody, and this is a second person (2026-09-16: one account per
 * deployment, enforced in code). Refused while the account is being made, through the same `refuse`.
 */
const secondPersonCode = refusalCode("DEPLOYMENT_HAS_ACCOUNT");

/**
 * A session TAKEN AWAY, as the server's guard answers it (`server/src/auth/session-revocation.ts`) and
 * as the app carries it to this screen in `?error=` (`load-current-user.ts`, `use-session-gate.ts`).
 * Read out of the server rather than copied, like the refusal above, and held to the app's own copy.
 */
const revokedSessionCode = (() => {
  const source = readFileSync(
    join(import.meta.dir, "../../server/src/auth/session-revocation.ts"),
    "utf8",
  );
  const code = /export const SESSION_REVOKED = "([^"]+)"/.exec(source)?.[1];
  if (!code) {
    throw new Error("server/src/auth/session-revocation.ts no longer names it");
  }
  return code;
})();

/**
 * What an authorization server may redirect back with: RFC 6749 §4.1.2.1, then OpenID Connect Core
 * §3.1.2.6, then the ones the broker's `oidc-provider` adds. The social providers' callbacks pass the
 * same `?error=` through untouched (`api/routes/callback.mjs`), and so does the broker's.
 */
const PROVIDER_CODES = [
  "invalid_request",
  "unauthorized_client",
  "access_denied",
  "unsupported_response_type",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
  "interaction_required",
  "login_required",
  "account_selection_required",
  "consent_required",
  "invalid_request_uri",
  "invalid_request_object",
  "request_not_supported",
  "request_uri_not_supported",
  "registration_not_supported",
  "invalid_target",
  "unsupported_response_mode",
  "unmet_authentication_requirements",
];

/**
 * The codes the two START routes answer with, and the origin check in front of them. Named here
 * rather than read, because the files they live in also serve email sign-in, which this deployment
 * does not have — but each one is checked to still be thrown where it is said to be.
 */
const START_CODES: { code: string; status: number; thrownIn: string }[] = [
  {
    code: "PROVIDER_NOT_FOUND",
    status: 404,
    thrownIn: "api/routes/sign-in.mjs",
  },
  {
    code: "INVALID_OAUTH_CONFIGURATION",
    status: 400,
    thrownIn: "plugins/generic-oauth/routes.mjs",
  },
  { code: "CALLBACK_URL_REQUIRED", status: 400, thrownIn: "oauth2/state.mjs" },
  {
    code: "INVALID_CALLBACK_URL",
    status: 403,
    thrownIn: "api/middlewares/origin-check.mjs",
  },
  {
    code: "INVALID_ERROR_CALLBACK_URL",
    status: 403,
    thrownIn: "api/middlewares/origin-check.mjs",
  },
  {
    code: "INVALID_ORIGIN",
    status: 403,
    thrownIn: "api/middlewares/origin-check.mjs",
  },
  {
    code: "MISSING_OR_NULL_ORIGIN",
    status: 403,
    thrownIn: "api/middlewares/origin-check.mjs",
  },
  {
    code: "CROSS_SITE_NAVIGATION_LOGIN_BLOCKED",
    status: 403,
    thrownIn: "api/middlewares/origin-check.mjs",
  },
];

/**
 * What the front door answers for an API that is not behind it, read out of `app/Caddyfile`: a 503
 * the API's own "no sign-in configured" 503 has to be told apart from.
 */
const frontDoorCode = (() => {
  const caddyfile = readFileSync(join(import.meta.dir, "../Caddyfile"), "utf8");
  const code = /\{"code":"(laf:[a-z_]+)"\}/.exec(caddyfile)?.[1];
  if (!code)
    throw new Error("app/Caddyfile no longer answers for a missing API");
  return code;
})();

/** The words for a refusal, in the Korean the screen is expected to show. */
const koreanFor = (refusal: SignInRefusal): string => {
  const english = refusalSentence(refusal);
  const korean = ko[english];
  if (!korean) throw new Error(`no Korean for "${english}"`);
  return korean;
};

const PROSE =
  "The+user+denied+access+to+the+application+and+this+is+English+prose";

const arrive = (code: string): Scenario => ({
  kind: "arrive",
  path: `/sign?error=${encodeURIComponent(code)}&error_description=${PROSE}`,
});

const press = (status: number, body?: unknown, path = "/sign"): Scenario => ({
  kind: "press",
  path,
  status,
  body,
});

type Case = { label: string; scenario: Scenario; expected: SignInRefusal };

const cases: Case[] = [
  ...[
    ...new Set([
      ...callbackCodes(),
      refusedEmailCode,
      secondPersonCode,
      revokedSessionCode,
      ...PROVIDER_CODES,
    ]),
  ].map((code) => ({
    label: `?error=${code}`,
    scenario: arrive(code),
    expected: refusalForCode(code),
  })),
  // better-auth's own error page's road: `/?error=…`, forwarded here by the signed-out root.
  {
    label: "?redirect=/?error=state_mismatch",
    scenario: {
      kind: "arrive",
      path: `/sign?redirect=${encodeURIComponent("/?error=state_mismatch&error_description=State mismatch")}`,
    },
    expected: "expired",
  },
  // …and a code that page rewrote because it did not like a character in it.
  {
    label: "?redirect=/?error=UNKNOWN",
    scenario: {
      kind: "arrive",
      path: `/sign?redirect=${encodeURIComponent("/?error=UNKNOWN")}`,
    },
    expected: "unknown",
  },
  ...[
    "UNKNOWN",
    "<img src=x onerror=alert(1)>",
    "Something went wrong: ECONNRESET at 10.0.0.1",
    "123",
  ].map((code) => ({
    label: `unknown ?error=${code}`,
    scenario: arrive(code),
    expected: "unknown" as const,
  })),
  {
    label: "the fourth start inside ten seconds (429)",
    scenario: press(429, {
      message: "Too many requests. Please try again later.",
    }),
    expected: "rate_limited",
  },
  {
    label: "the twenty-first start inside a minute (the API's own 429)",
    scenario: press(429, RATE_LIMITED),
    expected: "rate_limited",
  },
  ...START_CODES.map(({ code, status }) => ({
    label: `start ${status} ${code}`,
    scenario: press(status, { code, message: "English for a developer" }),
    expected: refusalForCode(code),
  })),
  {
    label: "start 400 VALIDATION_ERROR",
    scenario: press(400, { code: "VALIDATION_ERROR", message: "Invalid body" }),
    expected: "misconfigured",
  },
  {
    label: "start 503 from the front door, with no API behind it",
    scenario: press(503, { code: frontDoorCode }),
    expected: "unreachable",
  },
  {
    label: "start 503 from an API with no sign-in configured",
    scenario: press(503, {
      error: "laf:auth_not_configured",
      code: "laf:auth_not_configured",
    }),
    expected: "misconfigured",
  },
  {
    label: "start 502 with nothing behind the proxy",
    scenario: press(502),
    expected: "unreachable",
  },
  {
    label: "start 500",
    scenario: press(500, { message: "Internal Server Error" }),
    expected: "server_trouble",
  },
  {
    label: "start 400 with a message and no code",
    scenario: press(400, { message: "No config found for provider laf" }),
    expected: "unknown",
  },
  {
    label: "start that never got an answer",
    scenario: { kind: "press", path: "/sign", throws: true },
    expected: "unreachable",
  },
  // A press after arriving refused: the new refusal replaces the old, and the error leaves the destination.
  {
    label: "press after ?redirect=/?error=access_denied",
    scenario: press(
      429,
      { message: "Too many requests. Please try again later." },
      `/sign?redirect=${encodeURIComponent("/?error=access_denied")}`,
    ),
    expected: "rate_limited",
  },
  {
    label: "press from a deep link",
    scenario: press(
      429,
      {},
      `/sign?redirect=${encodeURIComponent("/channels/c-1")}`,
    ),
    expected: "rate_limited",
  },
];

let rendering: Promise<Shown[]> | undefined;

/** One Korean process for the whole file: it opens the screen once per case. */
function renderedInKorean(): Promise<Shown[]> {
  rendering ??= (async () => {
    const directory = mkdtempSync(join(tmpdir(), "sign-in-render-"));
    const file = join(directory, "scenarios.json");
    writeFileSync(file, JSON.stringify(cases.map((one) => one.scenario)));
    const child = Bun.spawn(
      ["bun", join(import.meta.dir, "support/sign-in-render.tsx"), file],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const line = stdout
      .split("\n")
      .find((candidate) => candidate.startsWith("SIGN_IN_RENDER "));
    if (status !== 0 || !line) {
      throw new Error(
        `the Korean render did not finish (exit ${status}):\n${stderr.slice(-3000)}`,
      );
    }
    return JSON.parse(line.slice("SIGN_IN_RENDER ".length)) as Shown[];
  })();
  return rendering;
}

describe("the codes a sign-in can come back with", () => {
  test("are read out of the installed better-auth, and there are as many as it has", () => {
    const codes = callbackCodes();
    // A regex that stopped matching would make every test below pass over nothing.
    for (const code of [
      "state_mismatch",
      "no_code",
      "invalid_code",
      "email_not_found",
      "oAuth_code_missing",
      "oauth_code_verification_failed",
      "email_is_missing",
      "account_not_linked",
      "signup_disabled",
      "internal_server_error",
      "state_not_found",
    ]) {
      expect(codes).toContain(code);
    }
    expect(codes.length).toBeGreaterThan(25);
    expect(refusedEmailCode).toBe("laf:sign_in_not_admitted");
    // A second person on a deployment that already has its one account: its own words, not the
    // "not on the list" sentence, because the person may well be on it.
    expect(secondPersonCode).toBe("laf:deployment_has_account");
    expect(refusalForCode(secondPersonCode)).toBe("deployment_has_account");
    // The code the app brings a revoked session here with is the one the server answers.
    expect(revokedSessionCode).toBe("laf:session_revoked");
    expect(SESSION_REVOKED).toBe(revokedSessionCode);
    expect(refusalForCode(revokedSessionCode)).toBe("revoked");
  });

  test("every start code is still thrown where this file says it is", () => {
    for (const { code, thrownIn } of START_CODES) {
      expect({ code, thrown: readDist(thrownIn).includes(`.${code}`) }).toEqual(
        { code, thrown: true },
      );
    }
  });

  test("each has words of its own — none of them falls to the generic sentence", () => {
    const generic = [
      ...new Set([
        ...callbackCodes(),
        refusedEmailCode,
        secondPersonCode,
        revokedSessionCode,
        RATE_LIMITED.code,
        ...PROVIDER_CODES,
        ...START_CODES.map(({ code }) => code),
        "VALIDATION_ERROR",
        frontDoorCode,
      ]),
    ].filter((code) => refusalForCode(code) === "unknown");
    expect(generic).toEqual([]);
  });

  test("the table holds no code that nothing sends", () => {
    // Words for a code that cannot arrive are words nobody checks; the table is exactly the set above.
    const sent = new Set(
      [
        ...callbackCodes(),
        refusedEmailCode,
        secondPersonCode,
        revokedSessionCode,
        RATE_LIMITED.code,
        ...PROVIDER_CODES,
        ...START_CODES.map(({ code }) => code),
        "VALIDATION_ERROR",
        frontDoorCode,
      ].map(refusalKey),
    );
    expect(KNOWN_REFUSAL_KEYS.filter((key) => !sent.has(key))).toEqual([]);
  });
});

describe("the sign-in screen, in Korean", () => {
  test("says one Korean sentence for each code, with nothing of the code or the provider's prose in it", async () => {
    const shown = await renderedInKorean();
    expect(shown).toHaveLength(cases.length);
    const wrong: string[] = [];
    cases.forEach(({ label, expected }, index) => {
      const alert = shown[index]?.alert ?? null;
      if (alert !== koreanFor(expected)) {
        wrong.push(
          `${label}: expected "${koreanFor(expected)}", shown ${JSON.stringify(alert)}`,
        );
      }
      // No code, no status text, no provider prose: nothing Latin at all reaches the line.
      if (alert !== null && /[A-Za-z]/.test(alert)) {
        wrong.push(`${label}: Latin letters in ${JSON.stringify(alert)}`);
      }
    });
    expect(wrong).toEqual([]);
  }, 180_000);

  test("sends a failed callback back to this screen, with where they were going", async () => {
    const shown = await renderedInKorean();
    const startedFor = (label: string) =>
      shown[cases.findIndex((one) => one.label === label)]?.started;

    expect(
      startedFor("the fourth start inside ten seconds (429)"),
    ).toMatchObject({
      providerId: "laf",
      callbackURL: "http://localhost:3110/",
      errorCallbackURL: "http://localhost:3110/sign",
      additionalData: { provider: "kakao" },
    });
    expect(startedFor("press from a deep link")).toMatchObject({
      callbackURL: "http://localhost:3110/channels/c-1",
      errorCallbackURL: "http://localhost:3110/sign?redirect=%2Fchannels%2Fc-1",
    });
    // The code that opened the screen is not carried into the next sign-in's destination.
    expect(
      startedFor("press after ?redirect=/?error=access_denied"),
    ).toMatchObject({
      callbackURL: "http://localhost:3110/",
      errorCallbackURL: "http://localhost:3110/sign",
    });
  }, 180_000);
});

describe("reading the refusal a screen was opened with", () => {
  test("takes the code from ?error=, or from the root's address in ?redirect=", () => {
    expect(
      refusalOnArrival({ error: "access_denied", redirect: "/channels/c-1" }),
    ).toEqual({ code: "access_denied", redirect: "/channels/c-1" });
    expect(
      refusalOnArrival({
        redirect: "/?error=state_mismatch&error_description=State%20mismatch",
      }),
    ).toEqual({ code: "state_mismatch", redirect: "/" });
    // Only the root is better-auth's error page's destination; a screen's own `error` is its own.
    expect(refusalOnArrival({ redirect: "/settings?error=x" })).toEqual({
      code: null,
      redirect: "/settings?error=x",
    });
    expect(refusalOnArrival({})).toEqual({ code: null, redirect: undefined });
  });

  test("keeps a start's code ahead of its status, and a missing answer apart from both", () => {
    expect(refusalForStart({ status: 403, code: "INVALID_ORIGIN" })).toBe(
      "misconfigured",
    );
    expect(refusalForStart({ status: 503, code: frontDoorCode })).toBe(
      "unreachable",
    );
    expect(refusalForStart({ status: 503 })).toBe("misconfigured");
    expect(refusalForStart({ status: 429, code: null })).toBe("rate_limited");
    expect(refusalForStart({ status: 0 })).toBe("unreachable");
    expect(refusalKey("email_doesn't_match")).toBe("email_doesn_t_match");
    expect(refusalKey("oAuth_code_missing")).toBe("oauth_code_missing");
  });
});
