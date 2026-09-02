import { createHash } from "node:crypto";

/**
 * What a departed person is called in the rows that outlive them.
 *
 * DERIVED, NOT RANDOM, so the trail keeps the one property that makes it a trail: the same actor
 * is the same string. Twelve rows that all say `deleted-4f2a…` are still recognisably one person's
 * afternoon; twelve rows that each got their own random token are twelve strangers, and "who
 * approved the withdrawal" stops being answerable about the very account somebody is investigating.
 *
 * Derived from the account id ALONE, not from the address. The id is a random string better-auth
 * minted and never showed anybody; an address is a guessable value, and hashing one produces a
 * token that anybody holding a list of addresses can test against. That is the difference between a
 * pseudonym and a thin coat of paint on the original data.
 *
 * Sixteen hex characters of SHA-256. Long enough that two accounts on one deployment colliding is
 * not a thing that happens, short enough to read in a log line.
 *
 * The prefix is deliberate: a reader who finds this in `granted_by` next to real addresses should
 * be able to tell at a glance that the person is gone rather than that somebody has a strange name.
 */
export function pseudonymFor(userId: string): string {
  const digest = createHash("sha256")
    .update(`laf-account:${userId}`)
    .digest("hex");
  return `deleted-${digest.slice(0, 16)}`;
}
