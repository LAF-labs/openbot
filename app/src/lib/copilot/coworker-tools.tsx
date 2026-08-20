import { useFrontendTool } from "@copilotkit/react-core/v2";
import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { z } from "zod";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { useActiveBotHolder } from "./active-bot";

/**
 * A Bot asking a coworker, as a tool.
 *
 * The account's Bots share one computer and one roster, and the product promise is that they can
 * brief each other: the everyday Bot asks the knowledge Bot for the source, the risk Bot asks the
 * everyday Bot what was ordered. The coworker answers server-side from its standing role, with no
 * tools in the room — so a chain of Bots each phoning the next cannot form; see the server's
 * coworker-call.ts for why that is structural rather than a limit somebody tuned.
 *
 * The model addresses coworkers by name because names are what it can see in the conversation; the
 * handler resolves the name against the roster it already has cached and sends the id.
 */
export function CoworkerTools() {
  const bot = useActiveBotHolder();
  const agents = useQuery(agentListQueryOptions());

  // A handler outlives the render that registered it (see active-bot.tsx), so the roster it reads
  // must live in a ref: the closure from the first render saw an empty query and would answer
  // "the roster: empty" forever, however many coworkers the next render knew about.
  const rosterRef = useRef<AgentProfile[]>([]);
  rosterRef.current = agents.data ?? [];
  const names = rosterRef.current.map((agent) => agent.name).join(", ");

  useFrontendTool({
    name: "ask_coworker",
    description:
      "Ask one of your coworkers a question and get their answer. They reply from their own role " +
      "and knowledge; they cannot browse or act while answering. Available coworkers: " +
      (names || "none yet") +
      ". Use this when a question belongs to a coworker's specialty rather than yours.",
    parameters: z.object({
      coworker: z
        .string()
        .describe(
          "The coworker's name or id, exactly as it appears in the roster",
        ),
      request: z
        .string()
        .describe(
          "The question, with enough context to answer it in one reply",
        ),
    }),
    handler: async ({
      coworker,
      request,
    }: {
      coworker: string;
      request: string;
    }) => {
      const wanted = coworker.trim().toLowerCase();
      let roster = rosterRef.current;
      if (roster.length === 0) {
        // The cache can genuinely be empty on a fresh tab; the server always knows.
        const listed = await fetch("/api/agents", { credentials: "include" })
          .then((response) => (response.ok ? response.json() : null))
          .catch(() => null);
        roster = (listed as { agents?: AgentProfile[] } | null)?.agents ?? [];
      }
      const target = roster.find(
        (agent) =>
          agent.id.toLowerCase() === wanted ||
          agent.name.trim().toLowerCase() === wanted,
      );
      if (!target) {
        const known = roster.map((agent) => agent.name).join(", ");
        return `There is no coworker called "${coworker}". The roster: ${known || "empty"}.`;
      }

      const response = await fetch(
        `/api/agents/${encodeURIComponent(target.id)}/ask`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ message: request, from: bot.current }),
        },
      );
      const body = (await response.json().catch(() => null)) as {
        answer?: string;
        error?: string;
      } | null;
      if (!response.ok) {
        // The reason goes back to the model as text, so it can tell the person or try another way,
        // rather than as a thrown error the runtime would flatten into noise.
        return `The coworker could not answer: ${body?.error ?? response.statusText}`;
      }
      return body?.answer ?? "The coworker finished without saying anything.";
    },
    render: () => null,
  });

  return null;
}
