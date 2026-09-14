/**
 * The 401 that is not an expiry: the session was TAKEN AWAY — its person struck off the sign-in list,
 * or removed by an administrator (`server/src/auth/session-revocation.ts`). The door says so.
 *
 * ITS OWN MODULE, WITH NOTHING ELSE IN IT, because of who imports it. It sat in `session-watch.ts`
 * for one gate run, and that module makes its `EventTarget` when it is evaluated: `queries.ts` and a
 * test with no DOM imported the code from there, evaluated it before happy-dom was registered, and the
 * target Bun made refused every event the DOM's constructors made in the files after — measured,
 * 54 app tests failing on one `dispatchEvent` in the full run and none alone (2026-09-14).
 */
export const SESSION_REVOKED = "laf:session_revoked";
