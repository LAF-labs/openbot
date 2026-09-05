import { IconDots } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type * as React from "react";
import { useCallback, useEffect, useState } from "react";
import { LoadFailed, RowsSkeleton } from "@/components/admin/admin-states";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { type AskSubject, describeSubject } from "@/lib/approvals";
import { activeLocale, t } from "@/lib/i18n";

/**
 * CEL computer-action boundary editor. Rules are shown as the gateway evaluates them, and denied
 * actions are recorded in Audit with the matching rule.
 */

type ActionPolicy = {
  deny: string[];
  ask: string[];
  allow: string[];
  /** Absent means allowed, matching the server. See the section below. */
  settleWithoutAsking?: "allowed" | "off";
};

/**
 * What a save carries beside the rules.
 *
 * `reason` is never stored on the policy and is not part of it: it goes in the audit row the server
 * writes for the change. It is required by this page rather than by the route, because the thing
 * worth being able to argue with afterwards is a person standing the boundary down — and a server
 * that refused a policy change over a missing sentence would be a server that can stop a deployment
 * from tightening its own rules.
 */
type PolicyChange = ActionPolicy & { reason?: string };

type Preset = { label: string; rule: string; cost?: string };

/**
 * A question somebody answered with "and stop asking me", as this page lists it.
 *
 * Mirrors `StandingApproval` on the server minus the withdrawn ones, which the route never sends:
 * this section is what is in force, and a list that mixed in revoked rows would need a reader to
 * work out which half of it still meant anything.
 */
type StandingAllowance = {
  id: string;
  botId: string;
  rule: string;
  scopeKind: "host" | "file" | "tool";
  scopeValue: string;
  /**
   * What the Bot was about to do when somebody answered "always", in facts.
   *
   * Absent on rows granted before the sentence became a subject (migration 0026). The line is left
   * out for those rather than filled with a guess — the scope above it is what the allowance
   * actually covers, and it is on the row either way.
   */
  subject?: AskSubject;
  grantedAt: string;
  /**
   * For good, or for one conversation. The list says which, because the two are not the same
   * decision: one stands until it is taken back, the other for a day and only in its thread.
   */
  tier: "always" | "thread";
  threadId?: string;
  /** When a conversation's allowance runs out on its own. Absent on the standing kind. */
  expiresAt?: string;
};

/**
 * Presets are concrete CEL rules, not a separate policy language.
 */
const PRESETS: Preset[] = [
  {
    label: "Never submit a form",
    // Three doors, not two. `key` exists only on keypress actions, so it is guarded by tool name to
    // keep the rule evaluable elsewhere; `submit` is on every action and needs no guard.
    rule: '(intent == "activate" && contains(element.name, "submit")) || (tool.name == "computer_key" && key == "Enter") || submit',
    cost: "Also stops the Bot pressing Enter for anything else, because a form submits from Enter in any of its fields.",
  },
  {
    label: "Never type into a password field",
    rule: 'intent == "type" && contains(element.name, "password")',
    cost: "A password box the page labels something else is not covered, the rule matches the label.",
  },
  {
    label: "Stop a Bot repeating itself",
    // The count includes the attempt being decided, so this refuses the tenth, not the eleventh.
    rule: "repeat.count >= 10",
    // The advice at the end used to be "try it in dry-run first", which is no longer a thing this
    // page can offer. Asking is what a deployment reaches for while it finds out whether a rule is
    // right, and asking is already the shipped answer to repetition — this preset is for the
    // deployment that has decided it wants the loop stopped outright.
    cost: "Two calls count as the same call when the thing acted on is the same, whatever was typed into it, so a Bot running ten searches from one box, or reading one file ten times, is refused on the tenth. It misses the other way too: a Bot slow enough to spread its attempts wider than a few minutes is never caught, one that changes a single argument each time is ten different calls, and calls to another server's tools are not counted at all. This one refuses; the boundary already asks on the fifth, which is the gentler place to start.",
  },
  {
    label: "Stay off social media",
    rule: 'intent == "navigate" && (contains(page.host, "facebook.com") || contains(page.host, "x.com"))',
    cost: "Only the two hosts named. A link that redirects there from somewhere else is allowed.",
  },
];

/**
 * The same rules a deployment might otherwise have had to forbid outright.
 *
 * Both of these are things a Bot is genuinely useful for and that nobody wants it doing unwatched
 * the first few times, which is the whole shape of this list: the boundary an operator actually
 * wants is rarely "never", it is "not without me".
 */
const ASK_PRESETS: Preset[] = [
  {
    label: "Ask before submitting a form",
    rule: '(intent == "activate" && contains(element.name, "submit")) || (tool.name == "computer_key" && key == "Enter") || submit',
    cost: "Asks about every Enter the Bot presses, because a form submits from Enter in any of its fields. Expect to be asked while it is filling one in, not only at the end.",
  },
  {
    label: "Ask before writing a file outside notes/",
    rule: 'intent == "write_file" && !matches(file.path, "^notes/")',
    cost: "Matches on the path the Bot asked for, so a folder it has not used before is a question rather than a refusal.",
  },
];

export const Route = createFileRoute("/_authed/admin/boundaries")({
  component: BoundariesPage,
});

function BoundariesPage() {
  const [policy, setPolicy] = useState<ActionPolicy | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  /** Said beside the box that produced it, not four sections below the fold. */
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [askDraft, setAskDraft] = useState("");
  /** Why the switch below is being moved. Required, and kept only in the audit row. */
  const [settleReason, setSettleReason] = useState("");
  /**
   * The places this boundary has been stood down, and by whose hand.
   *
   * Here rather than on a page of its own, because an allowance is a hole in what the section above
   * promises: somebody reading "Ask me first" and not finding this would believe they are asked
   * about things nobody has been asked about for weeks. Null while it has never loaded, so a
   * deployment that cannot answer shows nothing rather than an empty list that reads as "none".
   */
  const [standing, setStanding] = useState<StandingAllowance[] | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  // Names, so the list reads as "리스크 분석가" rather than as a uuid. A Bot this administrator
  // cannot see falls back to its id, which is still enough to withdraw the allowance.
  const { data: agents } = useQuery(agentListQueryOptions());
  const nameOf = (botId: string) =>
    agents?.find((agent) => agent.id === botId)?.name ?? botId;

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/computers/policy", {
        credentials: "include",
      });
      if (!response.ok) {
        setProblem(t("The boundary could not be read."));
        return;
      }
      const body = (await response.json()) as { policy: ActionPolicy };
      setPolicy(body.policy);
      setProblem(null);
    } catch {
      setProblem(t("The boundary could not be reached."));
    }
  }, []);

  const loadStanding = useCallback(async () => {
    try {
      const response = await fetch("/api/approvals/standing", {
        credentials: "include",
      });
      if (!response.ok) return;
      const body = (await response.json()) as {
        standing?: StandingAllowance[];
      };
      setStanding(body.standing ?? []);
    } catch {
      // Left as it was. This section is a reading of the boundary, not the boundary itself, and a
      // failed read must not blank a list somebody is about to act on.
    }
  }, []);

  const revoke = useCallback(
    async (id: string) => {
      setRevoking(id);
      try {
        const response = await fetch(`/api/approvals/standing/${id}`, {
          method: "DELETE",
          credentials: "include",
        });
        // 409 is "already withdrawn, most likely in another tab" — the list is simply out of date,
        // so reloading it is the whole fix and there is nothing to tell anybody.
        if (response.ok || response.status === 409) await loadStanding();
      } catch {
        // Nothing changed; the row stays and the button becomes pressable again.
      }
      setRevoking(null);
    },
    [loadStanding],
  );

  useEffect(() => {
    void load();
    void loadStanding();
  }, [load, loadStanding]);

  /**
   * Returns whether it saved.
   *
   * IT USED TO RETURN NOTHING, AND THE CALLERS CLEARED THE BOX REGARDLESS. A refused PUT therefore
   * deleted the CEL expression somebody had just written by hand and put the reason four sections
   * further down the page, well below the fold — so the rule was gone, and the explanation was
   * somewhere they were not looking.
   */
  const save = useCallback(async (next: PolicyChange): Promise<boolean> => {
    setSaving(true);
    setSaved(false);
    try {
      const response = await fetch("/api/computers/policy", {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      const body = (await response.json().catch(() => null)) as {
        policy?: ActionPolicy;
        error?: string;
      } | null;
      if (!response.ok) {
        setProblem(body?.error ?? t("The boundary could not be saved."));
        return false;
      }
      // Display the persisted policy in case the server normalized it.
      if (body?.policy) setPolicy(body.policy);
      setProblem(null);
      setSaved(true);
      return true;
    } catch {
      setProblem(t("The boundary could not be reached."));
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  if (problem && !policy) {
    return (
      <PageShell title={t("Boundaries")}>
        <LoadFailed message={problem} onRetry={() => void load()} />
      </PageShell>
    );
  }

  if (!policy) {
    return (
      <PageShell title={t("Boundaries")}>
        {/* Three lists are coming: what it may never do, what it asks about, and what is left. */}
        <RowsSkeleton height="h-24" rows={3} />
      </PageShell>
    );
  }

  const addRule = async (rule: string) => {
    const trimmed = rule.trim();
    if (!trimmed) return;
    // A rule already in the list was a dead click: nothing happened and nothing said why.
    if (policy.deny.includes(trimmed)) {
      setNotice(t("That rule is already in this list."));
      return;
    }
    setNotice(null);
    if (await save({ ...policy, deny: [...policy.deny, trimmed] })) {
      setDraft("");
    }
  };

  /**
   * The same rule can sit in both lists, and the deny wins.
   *
   * Not prevented, because an operator moving a rule from one list to the other will pass through
   * that state, and refusing to save it would look like a bug. What it means is stated under the
   * list instead, since the gateway decides deny first and an ask alongside it never fires.
   */
  const addAskRule = async (rule: string) => {
    const trimmed = rule.trim();
    if (!trimmed) return;
    if (policy.ask.includes(trimmed)) {
      setNotice(t("That rule is already in this list."));
      return;
    }
    setNotice(null);
    if (await save({ ...policy, ask: [...policy.ask, trimmed] })) {
      setAskDraft("");
    }
  };

  return (
    <PageShell
      description={
        <>
          {/*
           * One translatable sentence and one linked one, rather than a sentence with a link
           * sewn into the middle of it: t() returns a string, so an embedded element can only be
           * done by splitting the prose into fragments no translator can reorder — and Korean puts
           * that clause somewhere else entirely.
           */}
          {t(
            "What every Bot may and may not do with its computer. Rules are checked on every action before it happens, and every refusal is recorded with the rule that refused it.",
          )}{" "}
          <Link className="underline" to="/admin/audit">
            {t("Open the audit trail")}
          </Link>
        </>
      }
      title={t("Boundaries")}
    >
      {/*
       * The mode buttons are gone. "Record it and allow it" was a second switch that stood the whole
       * boundary down — every rule on this page matched, was written to the trail, and let the
       * action happen — sitting above the rules it silently suspended. What a rule does now is stop
       * the action, always, which is the only thing this page ever said it did.
       */}
      <PageSection title={t("It may never")}>
        {policy.deny.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {t("No rules. Every action is allowed and recorded.")}
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-border rounded-md border border-border">
            {policy.deny.map((rule) => (
              <RuleRow
                action={
                  <RemoveRule
                    isBusy={saving}
                    onRemove={() =>
                      void save({
                        ...policy,
                        deny: policy.deny.filter((one) => one !== rule),
                      })
                    }
                    rule={rule}
                  />
                }
                gloss={glossOf(rule)}
                key={rule}
                rule={rule}
              />
            ))}
          </ul>
        )}

        <div className="mt-3 flex gap-2">
          <Input
            aria-label={t("A rule, written in CEL")}
            className="min-w-0 flex-1 font-mono text-xs"
            onChange={(event) => {
              setDraft(event.target.value);
              setSaved(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void addRule(draft);
            }}
            placeholder='tool.name == "computer_click" && contains(element.name, "submit")'
            value={draft}
          />
          <Button
            disabled={saving || draft.trim().length === 0}
            onClick={() => void addRule(draft)}
            size="sm"
          >
            {t("Add rule")}
          </Button>
        </div>
        {/* Under the box that produced it. `problem` also renders far below, for a failed save. */}
        {notice || problem ? (
          <p className="mt-2 text-destructive text-xs" role="alert">
            {notice ?? problem}
          </p>
        ) : null}

        <p className="mt-4 font-medium text-sm">{t("Common rules")}</p>
        <ul className="mt-2 divide-y divide-border rounded-md border border-border">
          {PRESETS.map((preset) => (
            <RuleRow
              action={
                <Button
                  disabled={saving || policy.deny.includes(preset.rule)}
                  onClick={() => void addRule(preset.rule)}
                  size="sm"
                  variant="outline"
                >
                  {policy.deny.includes(preset.rule) ? t("Added") : t("Add")}
                </Button>
              }
              cost={preset.cost}
              gloss={preset.label}
              key={preset.rule}
              rule={preset.rule}
            />
          ))}
        </ul>
      </PageSection>

      <PageSection title={t("Ask me first")}>
        {policy.ask.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {t("No rules. Nothing stops to ask.")}
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-border rounded-md border border-border">
            {policy.ask.map((rule) => (
              <RuleRow
                action={
                  <RemoveRule
                    isBusy={saving}
                    onRemove={() =>
                      void save({
                        ...policy,
                        ask: policy.ask.filter((one) => one !== rule),
                      })
                    }
                    rule={rule}
                  />
                }
                gloss={glossOf(rule)}
                key={rule}
                rule={rule}
              />
            ))}
          </ul>
        )}

        <div className="mt-3 flex gap-2">
          <Input
            aria-label={t("A rule that asks a person first, written in CEL")}
            className="min-w-0 flex-1 font-mono text-xs"
            onChange={(event) => {
              setAskDraft(event.target.value);
              setSaved(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void addAskRule(askDraft);
            }}
            placeholder='intent == "write_file" && !matches(file.path, "^notes/")'
            value={askDraft}
          />
          <Button
            disabled={saving || askDraft.trim().length === 0}
            onClick={() => void addAskRule(askDraft)}
            size="sm"
          >
            {t("Add rule")}
          </Button>
        </div>
        {/* Under the box that produced it. `problem` also renders far below, for a failed save. */}
        {notice || problem ? (
          <p className="mt-2 text-destructive text-xs" role="alert">
            {notice ?? problem}
          </p>
        ) : null}

        <p className="mt-4 font-medium text-sm">{t("Common rules")}</p>
        <ul className="mt-2 divide-y divide-border rounded-md border border-border">
          {ASK_PRESETS.map((preset) => (
            <RuleRow
              action={
                <Button
                  disabled={saving || policy.ask.includes(preset.rule)}
                  onClick={() => void addAskRule(preset.rule)}
                  size="sm"
                  variant="outline"
                >
                  {policy.ask.includes(preset.rule) ? t("Added") : t("Add")}
                </Button>
              }
              cost={preset.cost}
              gloss={preset.label}
              key={preset.rule}
              rule={preset.rule}
            />
          ))}
        </ul>

        <p className="mt-3 text-xs text-muted-foreground">
          {t(
            "The Bot stops and waits where one of these matches, and carries on with the same action if somebody allows it. Checked after the rules above and before the ones below, so something you have forbidden stays forbidden and is never offered as a question.",
          )}{" "}
          {t(
            "Saying no is remembered: the same action is refused for the next half hour instead of being asked about again.",
          )}
        </p>
      </PageSection>

      {/*
       * WHETHER A QUESTION MAY BE ANSWERED FOR GOOD AT ALL.
       *
       * Beside the section it governs, because it is the same decision seen from the other side:
       * "Ask me first" says which actions stop, and this says whether stopping can be switched off
       * one answer at a time. A deployment that has decided every one of these gets a pair of eyes
       * had no way to say so, and any administrator could stand the whole thing down from a
       * transcript line at the end of a long task.
       */}
      <PageSection title={t("Getting past without asking")}>
        <div className="mt-2 flex gap-2">
          {(["allowed", "off"] as const).map((choice) => (
            <Button
              aria-pressed={
                (policy.settleWithoutAsking ?? "allowed") === choice
              }
              className={
                (policy.settleWithoutAsking ?? "allowed") === choice
                  ? "bg-foreground/5"
                  : undefined
              }
              // The reason is required, so the button that would change this is not pressable
              // without one — rather than pressable and then refused, which teaches people to type
              // a full stop into the box.
              disabled={
                saving ||
                ((policy.settleWithoutAsking ?? "allowed") !== choice &&
                  settleReason.trim().length === 0)
              }
              key={choice}
              onClick={() => {
                if ((policy.settleWithoutAsking ?? "allowed") === choice)
                  return;
                void save({
                  ...policy,
                  settleWithoutAsking: choice,
                  reason: settleReason.trim(),
                }).then((ok) => {
                  if (ok) setSettleReason("");
                });
              }}
              size="sm"
              variant="outline"
            >
              {choice === "allowed"
                ? t("A person may settle it in advance")
                : t("Ask every time")}
            </Button>
          ))}
        </div>
        {/*
         * WHY, AND IT IS NOT OPTIONAL.
         *
         * This is the one control on the page that decides whether anybody sees an action at all,
         * and the two directions are both worth a sentence: switching it off costs somebody their
         * afternoon to approvals, and switching it on means actions start going through unseen. A
         * change with nobody's reasoning attached is one nobody can argue with in three months.
         */}
        <div className="mt-2 flex gap-2">
          <Input
            aria-label={t("Why this is changing")}
            className="min-w-0 flex-1 text-sm"
            onChange={(event) => setSettleReason(event.target.value)}
            placeholder={t("Why this is changing")}
            value={settleReason}
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {t("Changing this needs a reason, which is kept in the audit trail.")}{" "}
          {(policy.settleWithoutAsking ?? "allowed") === "allowed"
            ? t(
                "Two things can settle a question without anybody seeing the action: “always” on a card, and a Bot's own “do not ask me about” instruction. Both are recorded, and every allowance is listed below and can be taken back.",
              )
            : t(
                "Every action a rule above matches is put in front of a person, every time. The wider button is not offered, no Bot's own instruction is consulted, and allowances already granted are not in force — they are still listed below, and come back if this is switched on again.",
              )}
        </p>
      </PageSection>

      {/*
       * AFTER "Ask me first", because that is what it is a hole in. A person reading that section
       * and stopping there believes they are asked about everything it names; this says which of
       * those questions somebody has already answered for good.
       *
       * Absent entirely while nothing has been granted, rather than shown as an empty list. An
       * empty section is a thing to reassure yourself about, and there is nothing here to reassure
       * anybody about until there is.
       */}
      {standing && standing.length > 0 ? (
        <PageSection
          title={
            (policy.settleWithoutAsking ?? "allowed") === "allowed"
              ? t("It no longer asks about")
              : // Said in the heading, not only in a note underneath: a list under "it no longer
                // asks about" that is in fact being asked about is worse than no list.
                t("Suspended — it asks about these again")
          }
        >
          <ul className="mt-2 divide-y divide-border rounded-md border border-border">
            {standing.map((allowance) => (
              <li
                className="flex items-start justify-between gap-4 px-3 py-2"
                key={allowance.id}
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm">
                    {allowance.scopeKind === "host"
                      ? t("{bot} — anything on {site}", {
                          bot: nameOf(allowance.botId),
                          site: allowance.scopeValue,
                        })
                      : allowance.scopeKind === "file"
                        ? t("{bot} — the file {path}", {
                            bot: nameOf(allowance.botId),
                            path: allowance.scopeValue,
                          })
                        : t("{bot} — the tool {tool}", {
                            bot: nameOf(allowance.botId),
                            tool: allowance.scopeValue,
                          })}
                  </span>
                  {/*
                   * What the Bot was doing when they granted it, said here rather than sent as a
                   * sentence — the same composition the card they pressed used. Absent on rows
                   * older than the subject; the scope above already says what is covered.
                   */}
                  {allowance.subject ? (
                    <span className="text-muted-foreground text-xs">
                      {describeSubject(allowance.subject)}
                    </span>
                  ) : null}
                  {/*
                   * A conversation's allowance says so, and says when it runs out. Without this
                   * the afternoon's yes reads in the list exactly like one given for good, which is
                   * the difference somebody pressed the narrower button for.
                   */}
                  {allowance.tier === "thread" ? (
                    <span className="text-muted-foreground text-xs">
                      {allowance.expiresAt
                        ? t("For one conversation only, until {when}", {
                            when: new Date(allowance.expiresAt).toLocaleString(
                              activeLocale,
                              { dateStyle: "short", timeStyle: "short" },
                            ),
                          })
                        : t("For one conversation only")}
                    </span>
                  ) : null}
                  {allowance.rule ? (
                    <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-muted-foreground text-xs">
                      {allowance.rule}
                    </code>
                  ) : null}
                </div>
                <Button
                  disabled={revoking === allowance.id}
                  onClick={() => void revoke(allowance.id)}
                  size="sm"
                  variant="ghost"
                >
                  {t("Ask me again")}
                </Button>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            {(policy.settleWithoutAsking ?? "allowed") === "allowed"
              ? t(
                  "Each of these was a question somebody answered with “always” or “for this conversation”. Until it is taken back or runs out, every action it covers is allowed without anybody being asked — the audit trail records them as allowed by the allowance rather than by a person.",
                )
              : // The heading says suspended; this has to as well. A note still promising that these
                // actions go through unasked is the same lie one line further down.
                t(
                  "These are not in force. Getting past without asking is switched off above, so every action they cover is being asked about again — they are kept so that switching it back on restores what somebody decided, rather than starting from nothing.",
                )}
          </p>
        </PageSection>
      ) : null}

      <PageSection title={t("Otherwise it may")}>
        <ul className="mt-2 divide-y divide-border rounded-md border border-border">
          {policy.allow.map((rule) => (
            <RuleRow gloss={glossOf(rule)} key={rule} rule={rule} />
          ))}
        </ul>
      </PageSection>

      <p className="mt-8 text-muted-foreground text-xs">
        {problem ? (
          <span className="text-destructive" role="alert">
            {problem}
          </span>
        ) : saved ? (
          t("Saved. It applies to the next action any Bot takes.")
        ) : (
          t(
            "Changes apply to the next action any Bot takes, and are kept: a restart comes back up enforcing what is here.",
          )
        )}
      </p>
    </PageShell>
  );
}

/**
 * ONE ROW, WHETHER THE RULE IS IN FORCE OR ON OFFER.
 *
 * This section used to hold two: a list of rules as bare monospace with a ghost button reading 제거
 * beside them, and under it a list of preset BUTTONS whose labels were the only readable thing on
 * the page and whose rules were invisible. So the same object — a CEL expression — appeared twice
 * in one section in two shapes, once as unreadable text with no name and once as a name with no
 * text.
 *
 * Now both are a name, the expression in a chip under it, and one action on the right. Which means
 * the presets finally show what they are about to add, and a hand-written rule that happens to
 * match a preset gets that preset's words — see `glossOf`.
 */
const RuleRow = ({
  rule,
  gloss,
  cost,
  action,
}: {
  rule: string;
  /** The English key for what this rule means, where anything on this page knows. */
  gloss?: string;
  /** What it also stops, from the preset that wrote it. */
  cost?: string;
  action?: React.ReactNode;
}) => (
  <li className="flex items-start justify-between gap-4 px-3 py-2">
    <div className="flex min-w-0 flex-col gap-1">
      {gloss ? <span className="text-sm">{t(gloss)}</span> : null}
      {/*
       * A chip, not a paragraph. CEL in the same weight as the sentence above it reads as prose
       * somebody wrote badly; in a chip it reads as machine detail, which is what it is and what a
       * person who does not write CEL needs to be told about it in one glance.
       */}
      <code className="min-w-0 break-all rounded bg-muted px-1.5 py-0.5 font-mono text-muted-foreground text-xs">
        {rule}
      </code>
      {cost ? (
        <span className="text-muted-foreground text-xs">{t(cost)}</span>
      ) : null}
    </div>
    {action ? <div className="shrink-0">{action}</div> : null}
  </li>
);

/**
 * Removing a rule, behind a menu.
 *
 * It was a ghost button labelled 제거 sitting in a row of monospace, which is the least emphatic
 * thing this design has in front of the one action on the page that takes a restriction away. In
 * the menu it is a destructive item, which is what it looks like everywhere else in the app.
 */
const RemoveRule = ({
  rule,
  isBusy,
  onRemove,
}: {
  rule: string;
  isBusy: boolean;
  onRemove: () => void;
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger
      render={
        <Button
          aria-label={t("Actions for this rule")}
          disabled={isBusy}
          size="icon"
          variant="ghost"
        >
          <IconDots />
        </Button>
      }
    />
    <DropdownMenuContent align="end" className="w-72">
      <DropdownMenuItem
        className="flex-col items-start gap-0"
        onClick={onRemove}
        variant="destructive"
      >
        <span>{t("Remove")}</span>
        <span className="text-xs opacity-80">
          {/* Named, because two rows of chips look alike and a menu hides which one it opened from. */}
          {t("Stops applying to the next action: {rule}", { rule })}
        </span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);

/**
 * What a rule means in words, when this page knows.
 *
 * Both preset tables plus the one rule the server ships that no preset wrote — `true`, the default
 * allow, which the list used to gloss with the English half-sentence "true, anything not refused
 * above" glued onto the expression and never passed through `t()`.
 */
function glossOf(rule: string): string | undefined {
  if (rule === "true") return "Anything not refused above";
  return [...PRESETS, ...ASK_PRESETS].find((preset) => preset.rule === rule)
    ?.label;
}
