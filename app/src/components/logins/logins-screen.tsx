import { IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ConnectionMark } from "@/components/connections/connection-mark";
import { ConfirmDialog } from "@/components/layout/confirm-dialog";
import { LiveRegion } from "@/components/layout/live-region";
import { PageEmpty, PageRows, PageShell } from "@/components/layout/page-shell";
import { ReadNotice } from "@/components/layout/read-states";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { ensure } from "@/lib/ensure";
import {
  ANOTHER_SITE,
  addressesIn,
  addressesOf,
  hostOf,
  LOGIN_SITES,
} from "@/lib/logins/addresses";
import { t } from "@/lib/i18n";
import { josa } from "@/lib/josa";
import {
  LoginRefusal,
  type LoginWritten,
  LOGINS_UNREACHABLE,
  loginKeys,
  removeLogin,
  type SavedLogin,
  savedLoginsQueryOptions,
  writeLogin,
} from "@/lib/logins/queries";
import { loginRefusalText } from "@/lib/logins/refusals";
import { readLineOf } from "@/lib/read-line";
import { settledOf, useReading } from "@/lib/reading";
import { BUSINESS_SITES } from "@/lib/sites/catalogue";

/**
 * 계정 — the sign-in names and passwords a person saved for their Bot's browser
 * (`docs/laf/redesign-2026-10.md` §6).
 *
 * WHAT IS DRAWN IS WHAT THE SERVER LISTS: what each login is called and where it may go. A value
 * is typed here once, on the way in, and no screen shows it again — there is nothing to reveal,
 * because nothing hands one back. To change a password a person types the new one; to see the old
 * one they look where they keep it.
 *
 * A LOGIN IS USED ONLY WHERE ITS ADDRESSES SAY. The Bot's browser puts it into a sign-in whose own
 * document is at one of them (`server/src/computer/gateway/secrets.ts`), so the addresses are the
 * one thing on this form that decides anything. A site this product knows fills them in; they stay
 * the person's to change, because a site's sign-in is not always at the address its pages are.
 */

type Draft = {
  site: string;
  label: string;
  addresses: string;
  username: string;
  password: string;
};

const draftOf = (login: SavedLogin | null): Draft => ({
  // A site the form does not offer reads as another site, and stays what it is unless changed.
  site: LOGIN_SITES.some((site) => site.id === login?.site)
    ? (login?.site ?? ANOTHER_SITE)
    : ANOTHER_SITE,
  label: login?.label ?? "",
  addresses: (login?.origins ?? []).map(hostOf).join("\n"),
  username: "",
  password: "",
});

/**
 * What to send for a change: only what the person changed. The server keeps whatever a change
 * does not name, so a form opened a while ago does not put back the name and the addresses it
 * was opened with — another window may have narrowed where the login goes since, and resending
 * the old addresses would widen it again without anybody having asked (Codex's read).
 */
function changesOf(opened: Draft, draft: Draft): LoginWritten {
  return {
    ...(draft.label === opened.label ? {} : { label: draft.label }),
    ...(draft.site === opened.site
      ? {}
      : { site: draft.site === ANOTHER_SITE ? null : draft.site }),
    ...(draft.addresses === opened.addresses
      ? {}
      : { origins: addressesIn(draft.addresses) }),
    username: draft.username,
    password: draft.password,
  };
}

function LoginForm({
  login,
  onDone,
  onSavingChange,
}: {
  /** The login being changed, or null for a new one. */
  login: SavedLogin | null;
  onDone: () => void;
  /** Told while a save is on its way, so the dialog around this is not closed under it. */
  onSavingChange: (isSaving: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftOf(login));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<{
    text: string;
    field?: string;
  } | null>(null);
  const isNew = login === null;

  const handleSite = (chosen: string | null) => {
    const site = chosen ?? ANOTHER_SITE;
    const name = LOGIN_SITES.find((one) => one.id === site)?.name;
    setDraft((current) => {
      const offered = addressesOf(current.site).join("\n");
      const wasOffered =
        LOGIN_SITES.find((one) => one.id === current.site)?.name ?? "";
      return {
        ...current,
        site,
        // Filled in for the person only where they have not written their own.
        label:
          current.label === "" || current.label === t(wasOffered)
            ? name
              ? t(name)
              : ""
            : current.label,
        addresses:
          current.addresses === "" || current.addresses === offered
            ? addressesOf(site).join("\n")
            : current.addresses,
      };
    });
  };

  const handleSubmit = async () => {
    if (saving) return;
    const written: LoginWritten = login
      ? changesOf(draftOf(login), draft)
      : {
          label: draft.label,
          site: draft.site === ANOTHER_SITE ? null : draft.site,
          origins: addressesIn(draft.addresses),
          username: draft.username,
          password: draft.password,
        };
    // Nothing was changed: there is nothing to ask the server for.
    if (
      login &&
      written.label === undefined &&
      written.site === undefined &&
      written.origins === undefined &&
      !written.username &&
      !written.password
    ) {
      onDone();
      return;
    }
    setProblem(null);
    setSaving(true);
    onSavingChange(true);
    await ensure(
      () =>
        writeLogin(queryClient, written, login?.id)
          .then(onDone)
          .catch((caught: unknown) => {
            const refusal =
              caught instanceof LoginRefusal
                ? caught
                : new LoginRefusal(LOGINS_UNREACHABLE);
            // Gone under the form — another window deleted it. The list behind this is read
            // again, so the row is not there to be opened a second time (Codex's read).
            if (refusal.code === "laf:login_not_found") {
              void queryClient.invalidateQueries({ queryKey: loginKeys.all });
            }
            setProblem({
              text: loginRefusalText(refusal.code),
              ...(refusal.field ? { field: refusal.field } : {}),
            });
          }),
      () => {
        setSaving(false);
        onSavingChange(false);
      },
    );
  };

  const siteChoices = [
    { value: ANOTHER_SITE, label: t("Another site") },
    ...LOGIN_SITES.map((site) => ({ value: site.id, label: t(site.name) })),
  ];
  const errorFor = (field: string) =>
    problem?.field === field ? [{ message: problem.text }] : null;
  const set = (field: keyof Draft) => (value: string) =>
    setDraft((current) => ({ ...current, [field]: value }));

  return (
    <form
      className="flex min-h-0 flex-1 flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      <DialogHeader>
        <DialogTitle>{isNew ? t("Add login") : t("Change login")}</DialogTitle>
        <DialogDescription>
          {t("Kept for you alone, and never shown again once saved.")}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="mt-4">
        {/* Locked while it saves: what is on screen is what is being stored. */}
        <fieldset className="min-w-0" disabled={saving}>
          <FieldGroup>
            <Field data-invalid={errorFor("site") !== null}>
              <FieldLabel htmlFor="login-site">{t("Site")}</FieldLabel>
              {/* The choices are handed over with their names, or the box draws the value itself:
                  seen on the running screen, which read "another" (2026-10-10). */}
              <Select
                items={siteChoices}
                onValueChange={handleSite}
                value={draft.site}
              >
                <SelectTrigger id="login-site">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {siteChoices.map((choice) => (
                      <SelectItem key={choice.value} value={choice.value}>
                        {choice.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldError errors={errorFor("site") ?? undefined} />
            </Field>
            <Field data-invalid={errorFor("origins") !== null}>
              <FieldLabel htmlFor="login-addresses">
                {t("Addresses")}
              </FieldLabel>
              <Textarea
                aria-invalid={errorFor("origins") !== null}
                autoCapitalize="none"
                autoCorrect="off"
                id="login-addresses"
                onChange={(event) => set("addresses")(event.target.value)}
                placeholder="nid.naver.com"
                rows={2}
                spellCheck={false}
                value={draft.addresses}
              />
              <FieldDescription>
                {t("Where its sign-in is. One to a line.")}
              </FieldDescription>
              <FieldError errors={errorFor("origins") ?? undefined} />
            </Field>
            <Field data-invalid={errorFor("label") !== null}>
              <FieldLabel htmlFor="login-label">{t("Name")}</FieldLabel>
              <Input
                aria-invalid={errorFor("label") !== null}
                id="login-label"
                onChange={(event) => set("label")(event.target.value)}
                value={draft.label}
              />
              <FieldError errors={errorFor("label") ?? undefined} />
            </Field>
            <Field data-invalid={errorFor("username") !== null}>
              <FieldLabel htmlFor="login-username">
                {t("Sign-in name")}
              </FieldLabel>
              <Input
                aria-invalid={errorFor("username") !== null}
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect="off"
                id="login-username"
                onChange={(event) => set("username")(event.target.value)}
                spellCheck={false}
                value={draft.username}
              />
              <FieldError errors={errorFor("username") ?? undefined} />
            </Field>
            <Field data-invalid={errorFor("password") !== null}>
              <FieldLabel htmlFor="login-password">{t("Password")}</FieldLabel>
              <Input
                aria-invalid={errorFor("password") !== null}
                autoComplete="new-password"
                id="login-password"
                onChange={(event) => set("password")(event.target.value)}
                type="password"
                value={draft.password}
              />
              {isNew ? null : (
                <FieldDescription>
                  {t("Leave both empty to keep what is saved.")}
                </FieldDescription>
              )}
              <FieldError errors={errorFor("password") ?? undefined} />
            </Field>
          </FieldGroup>
        </fieldset>
        {/* What it came to, where it is not about one box. Mounted with the form, so it is heard. */}
        <LiveRegion
          as="p"
          className="mt-4 text-destructive text-sm"
          tone="alert"
        >
          {problem && !problem.field ? problem.text : null}
        </LiveRegion>
      </DialogBody>
      <DialogFooter>
        <Button disabled={saving} type="submit">
          {saving ? t("Saving…") : t("Save")}
        </Button>
      </DialogFooter>
    </form>
  );
}

function LoginRow({
  login,
  onChange,
  onRemove,
}: {
  login: SavedLogin;
  onChange: () => void;
  onRemove: () => void;
}) {
  const site = BUSINESS_SITES.find((one) => one.id === login.site);
  return (
    <Item>
      <ItemMedia>
        <ConnectionMark {...(site ? { mark: site.mark } : {})} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{login.label}</ItemTitle>
        <ItemDescription>
          {login.origins.map(hostOf).join(", ")}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button
          aria-label={t("Change {name}", { name: login.label })}
          onClick={onChange}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <IconPencil />
        </Button>
        <Button
          aria-label={t("Delete {name}", { name: login.label })}
          onClick={onRemove}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <IconTrash />
        </Button>
      </ItemActions>
    </Item>
  );
}

export function LoginsScreen() {
  const queryClient = useQueryClient();
  const saved = useQuery(savedLoginsQueryOptions());
  const reading = useReading(saved, {
    isEmpty: (answer) => answer.logins.length === 0,
  });
  const settled = settledOf(reading);
  /** `null` is closed; `"new"` a new login; otherwise the one being changed. */
  const [editing, setEditing] = useState<SavedLogin | "new" | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  /**
   * The login the question is about, and whether the question is open. Two things, because the
   * name has to outlast the answer: the dialog fades after it closes, and a title that lost its
   * name on the way out would read "Delete ?" for a moment.
   */
  const [removing, setRemoving] = useState<SavedLogin | null>(null);
  const [isAsking, setIsAsking] = useState(false);
  const logins = settled?.data.logins ?? [];
  const isFull = settled ? logins.length >= settled.data.max : false;

  return (
    <PageShell
      action={
        settled && !isFull ? (
          <Button onClick={() => setEditing("new")} size="sm" variant="ghost">
            <IconPlus />
            {t("Add login")}
          </Button>
        ) : null
      }
      description={t(
        "The sign-in names and passwords your Bot signs in with for you. Each is used only at the addresses it was saved for, and is never shown again once saved.",
      )}
      title={t("Accounts")}
    >
      <ReadNotice
        className="mt-4 py-0"
        line={readLineOf(reading, {
          failed: t("The saved logins could not be loaded."),
          notHere: t("The saved logins could not be loaded."),
        })}
        onRetry={() => void saved.refetch()}
      />
      {settled && logins.length === 0 ? (
        <PageEmpty>{t("No login is saved yet.")}</PageEmpty>
      ) : null}
      {logins.length > 0 ? (
        <PageRows>
          {logins.map((login, index) => (
            <div key={login.id}>
              {index > 0 ? <Separator /> : null}
              <LoginRow
                login={login}
                onChange={() => setEditing(login)}
                onRemove={() => {
                  setRemoving(login);
                  setIsAsking(true);
                }}
              />
            </div>
          ))}
        </PageRows>
      ) : null}
      {isFull ? (
        <PageEmpty>
          {t("No more logins can be saved. Delete one first.")}
        </PageEmpty>
      ) : null}

      {/* Locked while a save is on its way: closed under it, the request would still save the
          password with nothing left to say whether it had, and its late answer would close
          whichever form was open by then (Codex's read). */}
      <Dialog
        isBusy={isSaving}
        onOpenChange={(open) => (open ? null : setEditing(null))}
        open={editing !== null}
      >
        <DialogContent>
          {editing === null ? null : (
            // A form of its own for each opening: what was typed into the last one is gone with it.
            <LoginForm
              key={editing === "new" ? "new" : editing.id}
              login={editing === "new" ? null : editing}
              onDone={() => setEditing(null)}
              onSavingChange={setIsSaving}
            />
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        confirmLabel={t("Delete")}
        description={t(
          "Your Bot will ask you to type it yourself the next time that site asks.",
        )}
        onConfirm={() =>
          removing
            ? removeLogin(queryClient, removing.id).catch((caught: unknown) => {
                // Gone already — another window's doing — or it never arrived: the list is read
                // again either way, and what is thrown on is a sentence. The dialog draws an
                // error's own words, and a refusal's are its code (Codex's read).
                void saved.refetch();
                throw new Error(
                  loginRefusalText(
                    caught instanceof LoginRefusal
                      ? caught.code
                      : LOGINS_UNREACHABLE,
                  ),
                );
              })
            : Promise.resolve()
        }
        onOpenChange={(open) => (open ? null : setIsAsking(false))}
        open={isAsking}
        pendingLabel={t("Deleting…")}
        // By name: with several saved, "this login" does not say which the bin was pressed on.
        title={t("Delete {name}{josa}?", {
          josa: josa(removing?.label ?? "", "을/를"),
          name: removing?.label ?? "",
        })}
      />
    </PageShell>
  );
}
