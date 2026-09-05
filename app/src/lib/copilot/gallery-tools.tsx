import { useFrontendTool, useHumanInTheLoop } from "@copilotkit/react-core/v2";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefusedCard } from "@/components/gallery/refused";
import {
  agentComponentsQueryOptions,
  announceGallery,
  componentKeys,
  decideComponent,
  type GrantedComponent,
} from "@/lib/components/queries";
import { useActiveBotId, useDeclaredBotId } from "@/lib/copilot/active-bot";
import {
  GALLERY_COMPONENTS,
  type GalleryComponent,
  galleryManifest,
} from "@/lib/copilot/gallery-registry";
import { t } from "@/lib/i18n";

/**
 * Register compiled gallery components once per name, scoped to the active Bot with `available`.
 * Handlers still recheck grants at call time because a run's offered tool list is only a snapshot.
 */
export function GalleryTools() {
  const queryClient = useQueryClient();
  useEffect(() => {
    void announceGallery(galleryManifest()).then((added) => {
      if (added.length > 0) {
        void queryClient.invalidateQueries({ queryKey: componentKeys.all });
      }
    });
  }, [queryClient]);

  // Active Bot comes from the route/channel surface currently driving the provider.
  const grantsFor = useActiveBotId();
  // Registered on every screen, asked about on none that has no Bot: a five-second poll for the
  // grants of `default` ran on Settings and the admin console for the life of the tab.
  const declared = useDeclaredBotId();
  const { data: granted } = useQuery(agentComponentsQueryOptions(declared));
  const held = useMemo(
    () =>
      new Map(
        (granted ?? []).map((component: GrantedComponent) => [
          component.name,
          component.description,
        ]),
      ),
    [granted],
  );

  return (
    <>
      {GALLERY_COMPONENTS.map((spec) =>
        spec.kind === "decision" ? (
          <GrantedDecision held={held} key={spec.name} spec={spec} />
        ) : (
          <GrantedTool
            grantsFor={grantsFor}
            held={held}
            key={spec.name}
            spec={spec}
          />
        ),
      )}
    </>
  );
}

function GrantedTool({
  grantsFor,
  spec,
  held,
}: {
  grantsFor: string;
  spec: GalleryComponent;
  held: Map<string, string>;
}) {
  const description = held.get(spec.name);
  const isHeld = description !== undefined;

  /**
   * Refusals decided by the server, keyed by the call they refused.
   *
   * Per-call keys preserve the original render for calls made before a grant was revoked.
   */
  const [refusals, setRefusals] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );

  const Component = spec.Component;

  const render = useCallback(
    (props: { toolCallId?: string; args?: Record<string, unknown> }) => {
      const refusal = props.toolCallId
        ? refusals.get(props.toolCallId)
        : undefined;
      if (refusal) {
        return <RefusedCard reason={refusal} title={t(spec.title)} />;
      }
      // Render from the polled grant snapshot so revocations show before a new call starts.
      if (!isHeld) {
        return (
          <RefusedCard
            reason={t(
              "{title} is not switched on for this Bot at the moment. It can be turned back on for this Bot from the admin screen.",
              { title: t(spec.title) },
            )}
            title={t(spec.title)}
          />
        );
      }
      return <Component {...(props.args ?? {})} />;
    },
    [Component, isHeld, refusals, spec.title],
  );

  useFrontendTool({
    name: spec.name,
    // Published descriptions are model-facing runtime behavior.
    description: description ?? spec.description,
    parameters: spec.parameters,
    // Keep the hook mounted and hide revoked grants from the model to preserve hook order.
    available: isHeld,
    handler: async (
      args: Record<string, unknown>,
      context: { toolCall?: { id?: string } },
    ) => {
      const decision = await decideComponent(
        spec.name,
        grantsFor,
        spec.reads?.(args ?? {}) ?? [],
      );
      if (!decision.allowed) {
        const reason = decision.reason ?? "That component is not allowed here.";
        const id = context?.toolCall?.id;
        if (id) {
          // The model is told in English below; the card beside it is the person's, so it is not
          // the same string twice — a refusal a Korean reader cannot read is a refusal that lies.
          const said = decision.reason ?? t("This cannot be shown here.");
          setRefusals((current) => new Map(current).set(id, said));
        }
        // Led with the same words the card shows, so the transcript and the card agree.
        return `Not shown: ${spec.title}. ${reason} Nothing was displayed, so tell the person that.`;
      }
      return spec.confirmation ?? "It is now on screen for the person.";
    },
    render,
  });

  return null;
}

function GrantedDecision({
  spec,
  held,
}: {
  spec: GalleryComponent;
  held: Map<string, string>;
}) {
  const description = held.get(spec.name);
  const isHeld = description !== undefined;
  const Component = spec.Component;

  /** Stable component type so in-progress decision cards do not remount. */
  const Render = useMemo(
    () =>
      function DecisionRender(props: Record<string, unknown>) {
        if (isHeld) return <Component {...props} />;
        return (
          <RefusedDecision
            respond={
              props.respond as ((result: unknown) => Promise<void>) | undefined
            }
            title={t(spec.title)}
          />
        );
      },
    [Component, isHeld, spec.title],
  );

  useHumanInTheLoop({
    name: spec.name,
    description: description ?? spec.description,
    parameters: spec.parameters,
    available: isHeld,
    render: Render,
  });

  return null;
}

/**
 * A decision the Bot was not allowed to ask for.
 *
 * Decision tools suspend the run, so a refusal must also answer the tool call.
 */
function RefusedDecision({
  title,
  respond,
}: {
  title: string;
  respond?: (result: unknown) => Promise<void>;
}) {
  // Two sentences, because they have two readers: the model has to know nobody was asked, and the
  // person has to be able to read why the card they were about to answer is not there.
  const told = `${title} is not available to this Bot at the moment, so the person was not asked. An administrator grants components per Bot, and can unpublish one for every Bot at once.`;
  const said = t(
    "{title} is not switched on for this Bot at the moment, so you were not asked. It can be turned back on for this Bot from the admin screen.",
    { title },
  );

  useEffect(() => {
    if (!respond) return;
    void respond(told).catch(() => {
      // The run being gone is not a failure worth reporting: there is nothing left to answer.
    });
  }, [respond, told]);

  return <RefusedCard reason={said} title={title} />;
}
