/**
 * A value held to the origin it was saved for, and what is thrown when a box is not in one.
 *
 * In a file of its own because two read it: the routes that put a saved login into a page
 * (`login-routes.ts`) throw it, and the one place a failure becomes an answer (`failures.ts`) has
 * to know it from every other — and neither of those may import the other.
 */

/** The box is not in a document of an origin the login was saved for. Nothing was put in. */
export class LoginOriginError extends Error {
  constructor() {
    super("laf:login_origin_mismatch");
    this.name = "LoginOriginError";
  }
}
