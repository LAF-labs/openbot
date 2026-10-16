/**
 * The saved-login envelope lives in `shared/login-seal.ts`, moved there unchanged so the company
 * hub's login vault seals with the same functions rather than a second copy of them. Everything
 * here imports it by this path, as before.
 */
export * from "../../../shared/login-seal";
