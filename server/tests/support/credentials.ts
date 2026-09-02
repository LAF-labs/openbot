/**
 * A vault stub that still has to be the shape of a vault.
 *
 * Every suite that needs a credential store implements the two or three members it exercises and
 * used to write `as never` over the rest. `as never` does not narrow a stub, it deletes the
 * contract: the object literal loses its contextual type, so the callbacks' parameters become
 * implicit `any` and a stub whose `create` took the wrong shape typechecked exactly as well as one
 * that took the right one. That was invisible while `server/tests` sat outside `tsc`.
 *
 * So the missing members are filled in with functions that throw instead. The parameters keep their
 * types, and a test that reaches a member it did not stub fails saying which one rather than
 * wandering into `undefined is not a function`.
 */
import type {
  CredentialAdminService,
  CredentialSecretReader,
  CredentialStore,
} from "../../src/credentials";

function unstubbed(member: string): never {
  throw new Error(
    `credential store stub: ${member} was called but this test did not stub it`,
  );
}

export function credentialStoreStub(
  overrides: Partial<CredentialStore>,
): CredentialStore {
  return {
    create: () => unstubbed("create"),
    updateSecret: () => unstubbed("updateSecret"),
    rotate: () => unstubbed("rotate"),
    revoke: () => unstubbed("revoke"),
    isLive: () => unstubbed("isLive"),
    findLiveByKey: () => unstubbed("findLiveByKey"),
    ...overrides,
  };
}

/** The admin-facing service the app takes, for route tests that exercise one verb of it. */
export function credentialAdminStub(
  overrides: Partial<CredentialAdminService>,
): CredentialAdminService {
  return {
    list: () => unstubbed("list"),
    create: () => unstubbed("create"),
    rotate: () => unstubbed("rotate"),
    revoke: () => unstubbed("revoke"),
    ...overrides,
  };
}

/** The same, for the seams that want a reader and a store in one object. */
export function credentialVaultStub(
  overrides: Partial<CredentialSecretReader & CredentialStore>,
): CredentialSecretReader & CredentialStore {
  return {
    readSecret: () => unstubbed("readSecret"),
    ...credentialStoreStub(overrides),
    ...overrides,
  };
}
