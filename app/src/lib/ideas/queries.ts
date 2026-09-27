import {
  type IdeaEntry,
  type IdeaNeed,
  ideaByKey,
} from "@shared/ideas/catalogue";
import { CATEGORIES, type Category, type Persona } from "@shared/persona";
import { siteById } from "@shared/sites/catalogue";
import { queryOptions } from "@tanstack/react-query";
import { t } from "@/lib/i18n";
import { josa } from "@/lib/josa";
import { PERSONA_LABELS } from "@/lib/persona/labels";
import { RequestRefusedError } from "@/lib/refusals";

/**
 * 아이디어 on the wire, and the words a card says (muse-shape plan §3.3, phase 5).
 *
 * The server answers keys and connection states in this person's order (`server/src/ideas/`); what
 * a card SAYS is this surface's — the catalogue's English keys (`shared/ideas/catalogue.ts`) through
 * `t()`, and the one line on why it is near the top, written here from facts: who the person said
 * they are, or which connection it works through. Nothing here is the model's, and nothing a card
 * shows cost a call to make.
 */

export type OfferedIdea = {
  key: string;
  state: "ready" | "connect";
  via: (IdeaNeed & { title?: string })[];
  needs: (IdeaNeed & { title?: string })[];
};

export type IdeasAnswer = { persona: Persona | null; ideas: OfferedIdea[] };

export const ideaKeys = { all: ["ideas"] as const };

/** The refusals a door answers with, as the codes it sends. */
export const IDEA_REFUSALS: Readonly<Record<string, string>> = {
  "laf:idea_unknown": "That idea is no longer on offer.",
};

async function ideaRequest(path: string, init?: RequestInit) {
  const response = await fetch(path, { credentials: "include", ...init });
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok) {
    const code = typeof body?.code === "string" ? body.code : "";
    const known = IDEA_REFUSALS[code];
    throw new RequestRefusedError(
      known ? t(known) : t("That did not go through. Try again."),
      response.status,
      code || null,
    );
  }
  return body;
}

export function ideasQueryOptions() {
  return queryOptions({
    queryKey: ideaKeys.all,
    // What is connected changes on 연결, and who the person is on 내 정보: both other screens.
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    queryFn: async () =>
      (await ideaRequest("/api/ideas")) as unknown as IdeasAnswer,
  });
}

/** 다음에: the card goes, and does not come back. */
export async function dismissIdea(key: string): Promise<void> {
  await ideaRequest(`/api/ideas/${encodeURIComponent(key)}/dismiss`, {
    method: "POST",
  });
}

/** The catalogue entry a card is, or undefined for a key this build does not know. */
export function ideaFor(card: Pick<OfferedIdea, "key">): IdeaEntry | undefined {
  return ideaByKey(card.key);
}

/** A category's name, through `t()`. */
export function categoryLabel(category: Category): string {
  const known = CATEGORIES.find((one) => one.id === category);
  return known ? t(known.name) : "";
}

/** A connection's name as the 연결 screen draws it: the site's own, or the vendor's title. */
export function needLabel(need: IdeaNeed & { title?: string }): string {
  if (need.kind === "site") {
    const site = siteById(need.id);
    return site ? t(site.name) : need.id;
  }
  return need.title ? t(need.title) : need.id;
}

/**
 * WHY THIS CARD IS HERE, FROM FACTS — the plan's "why it fits", never the model's opinion.
 *
 *  - It works through something connected: that connection, named ("네이버 스마트스토어가 연결돼 있어서").
 *  - It waits on a connection: which ones would do.
 *  - It leads for who they said they are: that answer ("학생에게 잘 맞아요").
 *  - Otherwise nothing: a line that says "추천" about everything says nothing.
 */
export function ideaReason(
  card: OfferedIdea,
  persona: Persona | null,
): { kind: "via" | "connect" | "persona"; text: string } | null {
  if (card.state === "connect") {
    // Three names and a count: seven places in one line was a paragraph on a card (measured, 정산).
    const names = card.needs.map(needLabel);
    const shown = names.slice(0, 3).join(" · ");
    return {
      kind: "connect",
      text: t("Can do this once one is connected: {connections}", {
        connections:
          names.length > 3
            ? t("{names} and {count} more", {
                names: shown,
                count: names.length - 3,
              })
            : shown,
      }),
    };
  }
  const [first] = card.via;
  if (first) {
    const name = needLabel(first);
    return {
      kind: "via",
      text: t("Because {connection} is connected", {
        connection: name,
        josa: josa(name, "이/가"),
      }),
    };
  }
  const idea = ideaFor(card);
  if (persona && idea?.lead.includes(persona)) {
    return {
      kind: "persona",
      text:
        persona === "other"
          ? t("Useful for anyone")
          : t("Suits a {persona}", { persona: t(PERSONA_LABELS[persona]) }),
    };
  }
  return null;
}

/** Where a pressed card goes when it can be asked now: the conversation, with the sentence in it. */
export function ideaDraft(idea: IdeaEntry): string {
  return t(idea.sentence);
}
