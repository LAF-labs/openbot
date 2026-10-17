/**
 * The company login vault, as this VM asks the hub for it (`hub/src/vault.ts`, the hub's side).
 *
 * The one place a path under `/vault` is spelled and a vault answer is read. The gateway
 * (`computer/gateway/secrets.ts`) asks this which company logins are this site's, takes a lease,
 * opens it once, and gives it back; it never reads a hub body itself.
 *
 * A VALUE PASSES THROUGH HERE AND STAYS NOWHERE. `open` hands the two values to its caller and
 * keeps no copy: nothing here caches, logs or queues an answer, and no call here goes through the
 * outbox (`outbox.ts`), whose rows are kept and offered again later. A lease or a value that could
 * not be had now is not wanted later — the run that asked has moved on — so every vault call is
 * one attempt and its failure is a fact for the run, never a row to send again.
 *
 * READ LENIENTLY, SHAPED STRICTLY, as `wire.ts` reads the hub's other answers: a row that is not
 * the shape is dropped, and a field the VM does not know is not passed on.
 */
import { isSavedOrigin } from "../../../shared/login-origin";
import { toolResultText } from "../../../shared/prompt/tool-results.ko";
import type { SavedLoginAnswer } from "../computer/gateway/secrets";
import type { HubHttp } from "./http";

/** A company login as the Bot's side may know it: what it is called and where it goes. No value. */
export type CompanyLogin = {
  /** The hub's id. Shown to the Bot with {@link COMPANY_LOGIN_PREFIX} in front. */
  id: string;
  label: string;
  site: string | null;
  origins: string[];
  /** Any number of VMs may sign in with it at once: it is never busy and never held. */
  concurrent: boolean;
  /** Another member's VM holds it now: whose (the hub's member id) and until when (ISO 8601). */
  busy?: { member: string; until: string };
};

/** What the Bot is shown in front of a company login's id, so it can never name a personal one. */
export const COMPANY_LOGIN_PREFIX = "company:";

/** Why the vault could not be used just now. The Bot is told one fact for all of them. */
export type VaultUnavailable = { unavailable: string };

export type VaultLease =
  | { lease: string; until: string; concurrent: boolean }
  | { busy: { member: string; until: string } }
  | VaultUnavailable;

const VAULT = "/vault";
const segment = (value: string) => encodeURIComponent(value);
const BUSY = "laf:vault_busy";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

function readBusy(value: unknown): { member: string; until: string } | null {
  if (!isObject(value)) return null;
  const member = str(value.member);
  const until = str(value.until);
  return member && until ? { member, until } : null;
}

/** `GET /vault`'s rows this member may use. Null when the body is not the shape at all. */
export function readCompanyLogins(body: unknown): CompanyLogin[] | null {
  if (!isObject(body) || !Array.isArray(body.logins)) return null;
  return body.logins.filter(isObject).flatMap((row): CompanyLogin[] => {
    const id = str(row.id);
    if (!id || row.canUse !== true) return [];
    const origins = Array.isArray(row.origins)
      ? row.origins.filter((one): one is string => typeof one === "string")
      : [];
    const busy = readBusy(row.busy);
    return [
      {
        id,
        label: str(row.label) ?? id,
        site: str(row.site),
        origins,
        concurrent: row.concurrent === true,
        ...(busy ? { busy } : {}),
      },
    ];
  });
}

export type CompanyVault = ReturnType<typeof createCompanyVault>;

export function createCompanyVault(input: {
  http: HubHttp;
  /** A developer's stack: a page under test on a loopback address (`shared/login-origin.ts`). */
  allowLoopbackHttp?: boolean;
}) {
  const { http } = input;
  const originOptions = { allowLoopbackHttp: input.allowLoopbackHttp === true };
  /**
   * The last list the hub gave, names and origins only — never a value. Kept so that a hub that
   * does not answer can still be told apart from a hub that has nothing for this site: with a
   * company login known for the site, the Bot is told the company login cannot be had now; with
   * none, the sign-in goes on the way it would on a VM with no company at all.
   */
  let lastList: CompanyLogin[] | null = null;

  return {
    /**
     * The company logins this member may use on a document at this address, by the same origin
     * rule as the person's own (`LoginVault.forOrigin`): HTTPS, or a developer's loopback.
     * `known` on a failure is what the last good list said of this address.
     */
    async forOrigin(
      address: string,
    ): Promise<CompanyLogin[] | (VaultUnavailable & { known: boolean })> {
      const answer = await http.request({ path: VAULT, retry: false });
      const listed = answer.ok ? readCompanyLogins(answer.body) : null;
      const here = (logins: readonly CompanyLogin[]) =>
        logins.filter((login) =>
          isSavedOrigin(login.origins, address, originOptions),
        );
      if (!listed) {
        return {
          unavailable: answer.ok ? "laf:hub_unreadable" : answer.code,
          known: here(lastList ?? []).length > 0,
        };
      }
      lastList = listed;
      return here(listed);
    },

    /**
     * A lease for one run, or the run's own lease renewed (`renew`). One attempt: a hub that does
     * not answer is a fact now, not a lease taken later behind the run's back.
     */
    async lease(
      id: string,
      ask: { origin: string; runId?: string; renew?: string },
    ): Promise<VaultLease> {
      const answer = await http.request({
        method: "POST",
        path: `${VAULT}/${segment(id)}/lease`,
        body: {
          origin: ask.origin,
          ...(ask.runId ? { runId: ask.runId } : {}),
          ...(ask.renew ? { lease: ask.renew } : {}),
        },
        retry: false,
      });
      if (!answer.ok) {
        if (answer.code === BUSY) {
          // A refusal comes back as its code alone (`http.ts`), so whose VM holds it and until
          // when is read off the list, where the hub says the same of every login.
          const listed = await http.request({ path: VAULT, retry: false });
          const row = listed.ok
            ? readCompanyLogins(listed.body)?.find((login) => login.id === id)
            : undefined;
          return { busy: row?.busy ?? { member: "", until: "" } };
        }
        return { unavailable: answer.code };
      }
      const body = answer.body;
      if (!isObject(body)) return { unavailable: "laf:hub_unreadable" };
      const busy = readBusy(body.busy);
      if (busy) return { busy };
      const lease = str(body.lease);
      const until = str(body.until);
      if (!lease || !until) return { unavailable: "laf:hub_unreadable" };
      return { lease, until, concurrent: body.concurrent === true };
    },

    /**
     * The two values, once per lease. Handed to the caller and kept by nothing here; the caller
     * puts them into the page and lets go of them.
     */
    async open(
      id: string,
      lease: string,
    ): Promise<{ username: string; password: string } | VaultUnavailable> {
      const answer = await http.request<unknown>({
        method: "POST",
        path: `${VAULT}/${segment(id)}/open`,
        body: { lease },
        retry: false,
      });
      if (!answer.ok) return { unavailable: answer.code };
      const body = answer.body;
      const username = isObject(body) ? str(body.username) : null;
      const password = isObject(body) ? str(body.password) : null;
      if (username === null || password === null) {
        return { unavailable: "laf:hub_unreadable" };
      }
      return { username, password };
    },

    /**
     * The run is done with it. Never throws and is never queued: a release that does not reach
     * the hub is a lease that lapses at its `until` on the hub's own clock.
     */
    async release(id: string, lease: string): Promise<boolean> {
      const answer = await http
        .request({
          method: "POST",
          path: `${VAULT}/${segment(id)}/release`,
          body: { lease },
          retry: false,
        })
        .catch(() => null);
      return answer?.ok === true;
    },

    /** This VM signed in on the login's site for the first time. Never throws, never queued. */
    async verified(id: string, runId?: string): Promise<boolean> {
      const answer = await http
        .request({
          method: "POST",
          path: `${VAULT}/${segment(id)}/verified`,
          body: {},
          ...(runId ? { run: runId } : {}),
          retry: false,
        })
        .catch(() => null);
      return answer?.ok === true;
    },

    /** A member's name, for saying whose VM holds a login. Null where the hub does not say. */
    async memberName(memberId: string): Promise<string | null> {
      if (!memberId) return null;
      const answer = await http
        .request({ path: "/members", retry: false })
        .catch(() => null);
      if (!answer?.ok || !isObject(answer.body)) return null;
      const members = answer.body.members;
      if (!Array.isArray(members)) return null;
      const found = members
        .filter(isObject)
        .find((member) => member.id === memberId);
      return found ? str(found.name) : null;
    },
  };
}

/**
 * What the Bot is told when a company login answered — or could not — a request for a sign-in's
 * values (`gateway/secrets.ts`), the same for a conversation's turn and a routine's run. Null
 * where no company login was in it, and the caller answers as it always has. Never a value: the
 * busy holder's name and the lease's end are the most it carries.
 */
export function companyLoginResult(
  asked: object,
): (Record<string, unknown> & { ok: boolean }) | null {
  const answered = asked as SavedLoginAnswer;
  if (answered.companyLoginUnavailable) {
    return {
      ok: false,
      code: "laf:company_login_unavailable",
      reason: toolResultText("laf:company_login_unavailable"),
    };
  }
  if (answered.loginBusy) {
    const { by, until } = answered.loginBusy;
    return {
      ok: false,
      code: "laf:vault_busy",
      reason: toolResultText("laf:vault_busy"),
      busy: { by, until },
    };
  }
  if (answered.loginFilled?.company) {
    return {
      ok: true,
      code: "laf:company_login_filled",
      result: toolResultText("laf:company_login_filled"),
    };
  }
  return null;
}
