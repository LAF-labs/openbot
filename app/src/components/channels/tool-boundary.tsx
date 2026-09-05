import { Component, type ReactNode } from "react";
import { t } from "@/lib/i18n";
import { josa } from "@/lib/josa";

/**
 * A component that throws must not take the conversation with it.
 *
 * Browser-authored components render in the transcript from model-supplied arguments, sometimes
 * while a tool call is still streaming. A render failure is isolated to the component card and shown
 * as a user-readable failure line; stacks stay in the developer console.
 */
export class ToolRenderBoundary extends Component<
  { name: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // Keep stack details out of the conversation while preserving them for component authors.
    console.error(
      "[gallery] a component failed to render",
      this.props.name,
      error,
    );
  }

  render() {
    if (this.state.failed) {
      return (
        <p className="my-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {/*
           * ONE SENTENCE THROUGH `t()`, not three JSX fragments around a name.
           *
           * Written as `<span>{name}</span> could not be drawn.` it was the one shape the coverage
           * rule cannot reach: no string literal is ever passed to anything, so nothing was there
           * to translate and nothing complained. It was the last bare English line in the app, and
           * the bold on the name is what it cost — a substitution buys a sentence a Korean reader
           * can actually parse, and word order is not ours to decide from here.
           */}
          {t(
            "{name}{josa} could not be drawn. The rest of this conversation is unaffected.",
            {
              josa: josa(this.props.name, "을/를"),
              name: this.props.name,
            },
          )}
        </p>
      );
    }
    return this.props.children;
  }
}
