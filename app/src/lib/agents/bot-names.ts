import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { t } from "../i18n";
import { type AgentProfile, agentListQueryOptions } from "./queries";

/**
 * Map visible Bot ids to names for admin read surfaces; deleted or hidden ids fall back to the
 * immutable id recorded in the event.
 */

/** Stable query selector so the id-to-name map only rebuilds when the roster changes. */
const toNames = (agents: AgentProfile[]): Map<string, string> =>
  new Map(agents.map((agent) => [agent.id, agent.name]));

export function useBotNames(): (botId: string) => string {
  const { data: names } = useQuery({
    ...agentListQueryOptions(),
    select: toNames,
  });

  return useCallback((botId: string) => names?.get(botId) ?? botId, [names]);
}

/**
 * WHAT A BOT IS CALLED BEFORE ANYBODY HAS DECIDED.
 *
 * A Bot exists the moment somebody presses 새 봇 — there is no form in front of it any more — so it
 * needs a name it did not ask for. An empty one was not an option: the roster, the recipient chips
 * and every notification are written around a name, and "" draws a hole in all three.
 *
 * Plain nouns, not job titles. The name is the one part of a Bot that is nobody's business but its
 * owner's, and a Bot that arrives called "지출 관리" has been told what it is for by the button that
 * made it. 초롱 has not, and is renamed in one tap when it turns out to be something.
 *
 * Read through `t(variable)`, which `i18n-coverage.test.ts` cannot see — so `bot-names.test.ts`
 * walks the table, the same pair `AGENT_PRESETS` and `agent-presets.test.ts` make.
 */
export const BOT_NAME_WORDS: readonly string[] = [
  "Lantern",
  "Pebble",
  "Breeze",
  "Maple",
  "Compass",
  "Otter",
  "Sprout",
  "Willow",
  "Comet",
  "Anchor",
  "Dawn",
  "Clover",
];

/**
 * A name nothing on the roster is using yet.
 *
 * Taken from the unused ones rather than from all twelve, because two Bots with the same name is a
 * roster somebody has to rename before they can tell their own work apart — and the second one is
 * usually made in the same minute as the first. Past twelve it counts: 초롱 2 is ugly and it is
 * still better than a duplicate.
 */
export function nextBotName(
  taken: readonly string[] = [],
  random: () => number = Math.random,
): string {
  const used = new Set(taken.map((name) => name.trim()));
  const words = BOT_NAME_WORDS.map((word) => t(word));
  const free = words.filter((word) => !used.has(word));
  const pool = free.length > 0 ? free : words;
  const word = pool[Math.floor(random() * pool.length) % pool.length] as string;
  if (!used.has(word)) return word;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${word} ${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * A face, chosen for somebody who has not been asked which one they want.
 *
 * A random SEED rather than a random tile id: `mascotIdFor` maps anything to a drawn character, so
 * this stays true whatever the art set is on the day, and a seed that names no tile cannot name the
 * wrong one after the set changes.
 */
export function randomFaceSeed(random: () => number = Math.random): string {
  return `seed-${Math.floor(random() * 0xffffff).toString(36)}${Math.floor(random() * 0xffffff).toString(36)}`;
}
