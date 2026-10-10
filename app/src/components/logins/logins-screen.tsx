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
} from "@/lib/logins/addresses";
import { t } from "@/lib/i18n";
import {
  LoginRefusal,
  LOGINS_UNREACHABLE,
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
  site: login?.site ?? ANOTHER_SITE,
  label: login?.label ?? "",
  addresses: (login?.origins ?? []).map(hostOf).join("\n"),
  username: "",
  password: "",
});

function LoginForm({
  login,
  onDone,
}: {
  /** The login being changed, or null for a new one. */
  login: SavedLogin | null;
  onDone: () => void;
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
    const name = BUSINESS_SITES.find((one) => one.id === site)?.name;
    setDraft((current) => {
      const offered = addressesOf(current.site).join("\n");
      const wasOffered =
        BUSINESS_SITES.find((one) => one.id === current.site)?.name ?? "";
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
    setProblem(null);
    setSaving(true);
    await ensure(
      () =>
        writeLogin(
          queryClient,
          {
            label: draft.label,
            site: draft.site === ANOTHER_SITE ? null : draft.site,
            origins: addressesIn(draft.addresses),
            username: draft.username,
            password: draft.password,
          },
          login?.id,
        )
          .then(onDone)
          .catch((caught: unknown) => {
            const refusal =
              caught instanceof LoginRefusal
                ? caught
                : new LoginRefusal(LOGINS_UNREACHABLE);
            setProblem({
              text: loginRefusalText(refusal.code),
              ...(refusal.field ? { field: refusal.field } : {}),
            });
          }),
      () => setSaving(false),
    );
  };

  const siteChoices = [
    { value: ANOTHER_SITE, label: t("Another site") },
    ...BUSINESS_SITES.map((site) => ({ value: site.id, label: t(site.name) })),
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
  const [removing, setRemoving] = useState<SavedLogin | null>(null);
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
                onRemove={() => setRemoving(login)}
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

      <Dialog
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
          removing ? removeLogin(queryClient, removing.id) : Promise.resolve()
        }
        onOpenChange={(open) => (open ? null : setRemoving(null))}
        open={removing !== null}
        pendingLabel={t("Deleting…")}
        title={t("Delete this login?")}
      />
    </PageShell>
  );
}
