import {
  OpenGenerativeUIActivityRenderer,
  useFrontendTool,
} from "@copilotkit/react-core/v2";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import * as z from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { RefusedCard } from "@/components/gallery/refused";
import {
  agentComponentsQueryOptions,
  decideComponent,
  type GrantedComponent,
} from "@/lib/components/queries";
import { useActiveBotId, useDeclaredBotId } from "@/lib/copilot/active-bot";
import { t } from "@/lib/i18n";
import {
  type PublishedSandboxed,
  publishedSandboxedQueryOptions,
} from "@/lib/sandboxed/queries";

/**
 * Browser-authored components use the same component grants as compiled gallery components, but
 * render published runtime markup in the SDK sandbox.
 */
export function SandboxedTools() {
  const botId = useActiveBotId();
  /*
   * REGISTRATION IS GLOBAL, THE GRANT QUERIES ARE NOT. These tools are registered for the whole
   * app so a conversation can offer one the moment it opens; what a Bot may answer with is a
   * question about a Bot, and on a screen with none it was being asked about `default` every
   * thirty seconds forever.
   */
  const declared = useDeclaredBotId();
  const { data: published } = useQuery(
    publishedSandboxedQueryOptions(Boolean(declared)),
  );
  const { data: granted } = useQuery(agentComponentsQueryOptions(declared));

  const held = new Map(
    (granted ?? []).map((component: GrantedComponent) => [
      component.name,
      component.description,
    ]),
  );

  return (
    <>
      {(published ?? []).map((component) => (
        <SandboxedTool
          botId={botId}
          component={component}
          description={held.get(component.name)}
          key={component.name}
        />
      ))}
    </>
  );
}

/** Convert an author's JSON Schema to SDK parameters; unreadable schemas fall back to catchall. */
function parametersFor(schema: Record<string, unknown>) {
  try {
    const converted = z.fromJSONSchema(schema as never);
    if (converted instanceof z.ZodObject) return converted;
  } catch {
    // Unreadable author schemas fall back to permissive arguments and server-side checks.
  }
  return z.object({}).catchall(z.unknown());
}

function SandboxedTool({
  component,
  description,
  botId,
}: {
  component: PublishedSandboxed;
  description: string | undefined;
  botId: string;
}) {
  const [refusals, setRefusals] = useState<Map<string, string>>(new Map());
  const isHeld = description !== undefined;

  const render = useCallback(
    (props: {
      args?: Record<string, unknown>;
      status?: string;
      toolCall?: { id?: string };
    }) => {
      const refusal = props.toolCall?.id
        ? refusals.get(props.toolCall.id)
        : undefined;
      if (refusal) {
        return <RefusedCard reason={refusal} title={component.name} />;
      }
      if (!isHeld) {
        return (
          <RefusedCard
            reason={t(
              "{title} is not switched on for this Bot at the moment. It can be turned back on for this Bot from the admin screen.",
              { title: component.name },
            )}
            title={component.name}
          />
        );
      }

      // Wait for complete arguments because sandbox source is injected once per keyed instance.
      if (props.status !== "complete") {
        return (
          <ToolLine label={t("Drawing")} detail={component.name} running />
        );
      }

      return (
        <div className="my-2">
          <OpenGenerativeUIActivityRenderer
            activityType="open-generative-ui"
            agent={null}
            content={{
              css: component.css,
              cssComplete: true,
              html: [component.html],
              htmlComplete: true,
              jsFunctions: `window.__args = ${JSON.stringify(props.args ?? {})};\n${component.jsFunctions}`,
              jsFunctionsComplete: true,
              generating: false,
            }}
            key={JSON.stringify(props.args ?? {})}
            message={null}
          />
        </div>
      );
    },
    [component, isHeld, refusals],
  );

  useFrontendTool({
    name: component.name,
    description:
      description ??
      `A component authored in this deployment: ${component.name}.`,
    parameters: parametersFor(component.argumentSchema),
    // Keep the hook mounted and hide revoked grants from the model to preserve hook order.
    available: isHeld,
    handler: async (
      _args: unknown,
      context: { toolCall?: { id?: string } } = {},
    ) => {
      const decision = await decideComponent(component.name, botId);
      if (!decision.allowed) {
        const reason = decision.reason ?? "That component is not allowed here.";
        const id = context?.toolCall?.id;
        // The card is the person's and the return is the model's, so the fallback is written twice.
        const said = decision.reason ?? t("This cannot be shown here.");
        if (id) setRefusals((current) => new Map(current).set(id, said));
        return reason;
      }
      return "It is now on screen for the person.";
    },
    render,
  });

  return null;
}
