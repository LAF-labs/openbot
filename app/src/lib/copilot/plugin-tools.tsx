import { useFrontendTool } from "@copilotkit/react-core/v2";
import { stepFailureOf } from "@shared/tools/step-result";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import * as z from "zod";
import { ApprovalRequest } from "@/components/channels/approval-request";
import { ToolLine } from "@/components/channels/tool-line";
import {
  WithheldSecrets,
  withheldForDisplay,
} from "@/components/channels/withheld-secrets";
import { OUTCOME_LABELS } from "@/lib/computer/outcome-labels";
import { useActiveBotId, useDeclaredBotId } from "@/lib/copilot/active-bot";
import { stepLineOf } from "@/lib/copilot/step-labels";
import { t } from "@/lib/i18n";
import { LazyMarkdown } from "@/lib/markdown";
import {
  agentPluginsQueryOptions,
  type GrantedPlugins,
} from "@/lib/plugins/queries";

type GrantedTool = GrantedPlugins["tools"][number];

/**
 * `seen` with every tool in `tools` added, or replaced by its newer copy — or `seen` itself when
 * nothing changed, so a render with the same grants remembers nothing new. A tool keeps its place
 * once it has one, the order a `Map` gives a key set again.
 */
function withTools(
  seen: ReadonlyMap<string, GrantedTool>,
  tools: readonly GrantedTool[],
): ReadonlyMap<string, GrantedTool> {
  if (tools.every((tool) => seen.get(tool.ref) === tool)) return seen;
  const next = new Map(seen);
  for (const tool of tools) next.set(tool.ref, tool);
  return next;
}

/**
 * Runtime-discovered MCP tools granted to the active Bot. Registration is what the turn is told
 * this window offers; the server carries each call out and rechecks the grant as it does
 * (`server/src/turns/chat-tools.ts`).
 */
export function PluginTools() {
  const botId = useActiveBotId();
  // The registration stays; the fifteen-second grant poll only runs once a surface names a Bot.
  const declared = useDeclaredBotId();
  const { data } = useQuery(agentPluginsQueryOptions(declared));
  const granted: GrantedPlugins = data ?? { tools: [], skills: [] };

  /**
   * Keep previously offered tools mounted, so a step of a tool the Bot no longer holds still has
   * its line: revoked mid-conversation, its calls stay in the transcript.
   *
   * State adjusted while rendering — React's pattern for remembering what earlier renders saw —
   * rather than a ref filled in during render, which the React Compiler refuses to compile. React
   * renders again at once with what was just remembered, before anything is committed.
   */
  const [seen, setSeen] = useState<ReadonlyMap<string, GrantedTool>>(
    () => new Map(),
  );
  const remembered = withTools(seen, granted.tools);
  if (remembered !== seen) setSeen(remembered);
  const offered = [...remembered.values()];

  return (
    <>
      {offered.map((tool) => (
        <PluginTool
          botId={botId}
          description={tool.description}
          inputSchema={tool.inputSchema}
          key={tool.ref}
          name={tool.toolName}
          toolRef={tool.ref}
        />
      ))}
    </>
  );
}

/** Convert vendor JSON Schema to SDK parameters; unreadable schemas fall back to catchall. */
function parametersFor(inputSchema: Record<string, unknown>) {
  try {
    const converted = z.fromJSONSchema(inputSchema);
    // Only object schemas describe tool arguments; other vendor schemas fall back to catchall.
    if (converted instanceof z.ZodObject) return converted;
  } catch {}
  return z.object({}).catchall(z.unknown());
}

/**
 * A tool result, as something worth looking at.
 *
 * MCP says a text part, and vendors fill it with anything from plain markdown to a JSON envelope
 * with the markdown inside one field. Markdown is drawn as markdown, a JSON wrapper is unwrapped to
 * the markdown it was hiding, and anything else is fenced as JSON. Nothing is discarded.
 */
function forDisplay(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON after all. Draw what the server sent.
    return text;
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const entries = Object.entries(parsed as Record<string, unknown>);
    // The field carrying the answer, told apart from the ones carrying bookkeeping: Slack sends
    // `{ results, pagination_info }`. The rest is kept below rather than dropped.
    const markdown = entries
      .filter(
        ([, value]) =>
          typeof value === "string" &&
          (value.includes("\n#") || value.startsWith("#")),
      )
      .sort((a, b) => String(b[1]).length - String(a[1]).length)[0];

    if (markdown) {
      const rest = entries.filter(([key]) => key !== markdown[0]);
      const body = String(markdown[1]);
      if (rest.length === 0) return body;
      return `${body}\n\n\`\`\`json\n${JSON.stringify(
        Object.fromEntries(rest),
        null,
        2,
      )}\n\`\`\``;
    }
  }

  return `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
}

function PluginTool({
  name,
  toolRef,
  description,
  inputSchema,
  botId,
}: {
  name: string;
  toolRef: string;
  description: string;
  inputSchema: Record<string, unknown>;
  botId: string;
}) {
  const [serverId, ...rest] = toolRef.split("/");
  const bareName = rest.join("/");
  /*
   * The line names the tool in the owner's words, and the service by its title. It used to be the
   * tool's own name and the service's id — "search_support_programs · public-data", measured on a
   * shop owner's first task (2026-09-27). See `step-labels.ts`.
   */
  const line = stepLineOf(name);

  useFrontendTool({
    name,
    // The vendor's own description, with the server named. A model choosing between two servers that
    // both offer "search" needs to know which is which, and vendors do not write their descriptions
    // expecting to sit beside another vendor's.
    description: description
      ? `${description} (${serverId})`
      : `${bareName} on ${serverId}.`,
    parameters: parametersFor(inputSchema),
    render: ({ status, toolCallId, result: stored }) => {
      /*
       * HOW A CALL ENDED IS READ FROM ITS RESULT — THE ONE THE CONVERSATION KEEPS.
       *
       * This read what this window's own handler had learned, and nothing else. A turn the server
       * owns never called that handler, nor did a conversation read back after a reload. Measured
       * 2026-10-03, mounted with a granted tool and a stored conversation: a step whose result was
       * the service's error read "메일 읽기 · 지메일" with no warning, and a step whose result held
       * a withheld code had no 보기 — the one thing the person who asked for the code was waiting
       * on. Every chat turn was the server's by then, so that was every step; the handler itself
       * went with the window-driven path (2026-10-05), and the kept result is the only reader.
       *
       * A refusal's own sentence is the model's and is not shown — the line says what a person is
       * told for that fact, where there are such words, and otherwise only that it was blocked or
       * did not work.
       */
      const kept =
        typeof stored === "string" && stored !== "" ? stored : undefined;
      const failure = kept === undefined ? null : stepFailureOf(kept);
      if (failure && failure.kind !== "error") {
        const words = failure.code ? OUTCOME_LABELS[failure.code] : undefined;
        return (
          <ToolLine
            detail={words ? t(words) : line.detail}
            failed={failure.kind === "failed"}
            label={line.label}
            refused={failure.kind === "refused"}
          />
        );
      }

      return (
        <>
          {/*
           * A boundary can stop a tool call the same way it stops a click, so the question belongs
           * on this line rather than only on the lines about a browser.
           */}
          <ApprovalRequest toolCallId={toolCallId} />
          <ToolLine
            detail={line.detail}
            failed={failure?.kind === "error"}
            label={line.label}
            running={status !== "complete"}
          >
            {failure?.kind === "error" ? (
              // The service's own error, in its own words: what went wrong is the detail — behind
              // the lazy boundary, because this renderer is registered on every conversation
              // screen — with a stand-in for what was withheld from it. See below.
              <LazyMarkdown>
                {withheldForDisplay(forDisplay(failure.text))}
              </LazyMarkdown>
            ) : null}
          </ToolLine>
          {/* What a mail held that the Bot was not given — outside the folded detail, because the
              owner who asked for a code is waiting on it, not on the mail around it. Read from the
              kept result; the answer itself stays folded away.

              AN ERROR CAN HOLD ONE TOO. A mail tool that fails part-way has still read what it
              read, and the server takes a code out and keeps it before it looks at whether the
              call failed (`server/src/plugins/call.ts`). The row was left out for every failure,
              and the error's words were drawn as they came: the person saw the mark that stands
              for the code and nothing to press (Codex on pull request 52). */}
          {kept !== undefined ? (
            <WithheldSecrets botId={botId} text={kept} />
          ) : null}
        </>
      );
    },
  });

  return null;
}
