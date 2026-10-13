import { useFrontendTool, useHumanInTheLoop } from "./tool-registry";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import { holdsSomethingToDraw } from "@/components/gallery/gallery-card";
import {
  CardNotShown,
  cardEndingOf,
  RefusedCard,
} from "@/components/gallery/refused";
import {
  agentComponentsQueryOptions,
  announceGallery,
  componentKeys,
  type GrantedComponent,
} from "@/lib/components/queries";
import { useDeclaredBotId } from "@/lib/copilot/active-bot";
import {
  GALLERY_COMPONENTS,
  type GalleryComponent,
  galleryManifest,
} from "@/lib/copilot/gallery-registry";
import { t } from "@/lib/i18n";
import { DecisionCard } from "@/lib/turns/answers";

/**
 * Register compiled gallery components once per name, scoped to the active Bot with `available`.
 * The turn rechecks the grant when the Bot calls one (`server/src/turns/chat-tools.ts`), because
 * the list a window offered is only a snapshot.
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
          <GrantedTool held={held} key={spec.name} spec={spec} />
        ),
      )}
    </>
  );
}

/**
 * What one call of a gallery card is drawn as.
 *
 * Out here, and exported, because the gallery itself is found through Vite and no card of it can be
 * mounted under `bun test`: what a call is drawn as is tested by drawing this
 * (`server-run-step-line.test.tsx`).
 */
export function CardCall({
  Component,
  parameters,
  args,
  isHeld,
  result,
  title,
}: {
  Component: GalleryComponent["Component"];
  /** The card's own schema: which fields a card shows, for the gate once the call is complete. */
  parameters: GalleryComponent["parameters"];
  args: Record<string, unknown> | undefined;
  /** Whether this Bot holds the card now, by the grants this window polls. */
  isHeld: boolean;
  /** What the conversation kept as the call's result, once it has one. */
  result?: string | undefined;
  /** The card's own title, already in the reader's language. */
  title: string;
}) {
  /*
   * THE CALL'S OWN ANSWER FIRST: a card the Bot was told was not shown is not drawn as the card,
   * whatever this Bot holds now (`cardEndingOf`).
   */
  const ending = cardEndingOf(result);
  if (ending) return <CardNotShown ending={ending} title={title} />;
  // Render from the polled grant snapshot so revocations show before a new call starts.
  if (!isHeld) {
    return (
      <RefusedCard
        reason={t(
          "{title} is not switched on for this Bot at the moment. It can be turned back on for this Bot from the admin screen.",
          { title },
        )}
        title={title}
      />
    );
  }
  /*
   * STILL OUT: drawn from what has arrived so far. The registry reads the arguments as they stream
   * (`partial-json.ts`), so a card grows as the Bot writes it — a title, then a figure, then the
   * next — and the renderers take any partial shape (#179). That is the card being written, and it
   * is left as it was.
   */
  if (result === undefined) return <Component {...(args ?? {})} />;
  /*
   * COMPLETE: DRAWN AS IT WAS WHILE IT STREAMED, UNLESS THERE IS NOTHING IN IT TO DRAW
   * (`holdsSomethingToDraw`). A call that arrived with `{}` and was answered "on screen"
   * (2026-10-11, a key-figures card and a progress card in one sitting) drew an empty frame here
   * for as long as the conversation was open, above the Bot's own words that it was trying again
   * and the real card under them. The Bot's words say what happened; an empty frame says nothing,
   * and a chart with no data says "nothing to chart" about a card that was never written.
   *
   * Not the schema: a card the person watched grow is not taken away because its seventh figure
   * is one more than the schema allows (why, at the gate itself).
   */
  if (!holdsSomethingToDraw({ parameters }, args)) return null;
  return <Component {...args} />;
}

function GrantedTool({
  spec,
  held,
}: {
  spec: GalleryComponent;
  held: Map<string, string>;
}) {
  const description = held.get(spec.name);
  const isHeld = description !== undefined;

  const Component = spec.Component;

  const render = useCallback(
    (props: { args?: Record<string, unknown>; result?: string }) => (
      <CardCall
        Component={Component}
        args={props.args}
        isHeld={isHeld}
        parameters={spec.parameters}
        result={props.result}
        title={t(spec.title)}
      />
    ),
    [Component, isHeld, spec.parameters, spec.title],
  );

  useFrontendTool({
    name: spec.name,
    // Published descriptions are model-facing runtime behavior.
    description: description ?? spec.description,
    parameters: spec.parameters,
    // Keep the hook mounted and hide revoked grants from the model to preserve hook order.
    available: isHeld,
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
        if (isHeld) return <DecisionCard Component={Component} props={props} />;
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
