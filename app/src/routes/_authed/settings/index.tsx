import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { PersonAvatar } from "@/components/avatar/person-avatar";
import { FeedbackDialog } from "@/components/help/feedback-dialog";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { LegalLinks } from "@/components/legal/legal-links";
import { NotificationPermission } from "@/components/notifications/notification-permission";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { appConfig } from "@/lib/generated/application-config";
import { type Locale, localeSetting, setLocaleSetting, t } from "@/lib/i18n";
import type { ThemePreference } from "@/lib/theme";

export const Route = createFileRoute("/_authed/settings/")({
  component: RouteComponent,
});

/** Long enough for the Select popup's `duration-100` exit to have finished. */
const MENU_DISMISS_MS = 150;

function RouteComponent() {
  const { preference, setPreference } = useTheme();
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const signOut = useMutation(signOutMutationOptions(queryClient));

  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  /*
   * The language is applied once the menu has dismissed, not the instant a row inside it is
   * clicked. `setLocaleSetting` reloads the page, and nothing on the screen said so: fired straight
   * from `onValueChange` the reload starts with the popup still on screen, so the last frame before
   * the white flash is an open menu — which reads as the app falling over rather than as the thing
   * that was just asked for. Now the trigger shows the choice, the popup goes, and then the page
   * reloads. The row says so too.
   *
   * A TIMER, AND BOTH OF THE OTHER TWO WAYS WERE MEASURED FAILING.
   *
   * `onOpenChangeComplete` waits on the exit ANIMATION, and in a window that is not on screen that
   * animation never ends — `data-ending-style` stays on the popup and the callback never arrives.
   * The language would have been chosen, shown on the trigger, and never applied.
   *
   * `onOpenChange` arrives, but in the same React batch as `onValueChange`, so a handler reading
   * the pending value out of state reads the render's own copy: `null`, every time. Measured on
   * this screen — English on the trigger, nothing written down, no reload, and no way to try again
   * without picking a different language first.
   *
   * A timer has neither problem: it closes over the value directly, and a background tab clamps it
   * rather than dropping it. 150ms clears the popup's `duration-100` exit.
   */
  const [pendingLocale, setPendingLocale] = useState<Locale | null>(null);
  const localeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (localeTimer.current) clearTimeout(localeTimer.current);
    },
    [],
  );

  const handleLocaleChosen = (value: Locale | null) => {
    // The Select's value type admits null (nothing chosen). Every row here carries one.
    if (value === null) return;
    const chosen = value;
    setPendingLocale(chosen);
    if (chosen === localeSetting) return;
    if (localeTimer.current) clearTimeout(localeTimer.current);
    localeTimer.current = setTimeout(
      () => setLocaleSetting(chosen),
      MENU_DISMISS_MS,
    );
  };

  /* A sign-out that failed silently leaves somebody believing they signed out. It has to say so. */
  const handleSignOut = async () => {
    setSignOutError(null);
    try {
      await signOut.mutateAsync();
    } catch (caught) {
      setSignOutError(
        caught instanceof Error ? caught.message : t("Could not log out."),
      );
      return;
    }
    await navigate({ to: "/sign" });
  };

  /*
   * The measurements that used to be written out here now live in `PageShell`, which Skills, Admin
   * and this screen all render through. The reason they match is no longer that somebody remembered
   * to copy them.
   */
  return (
    <PageShell
      description={t(
        "How {product} looks and behaves for you. These apply to your account alone, on every deployment you sign in to.",
        { product: appConfig.brand.productName },
      )}
      title={t("Preferences")}
    >
      {/*
       * Who these preferences belong to. The description above promises "your account alone", and
       * this is the row that makes the promise concrete — plus the way out, which otherwise hides
       * behind the avatar menu.
       *
       * THE 연결 ROW THAT USED TO SIT UNDER IT IS GONE. It was the third copy of a link the rail
       * already carries and the narrow nav now carries too, on a screen whose whole argument is
       * that it is shallow: two ways to the same page from one viewport is a person wondering
       * which of them is the different one.
       */}
      <PageSection title={t("Account")}>
        <PageRows>
          <Item size="sm">
            {/*
             * Held open at the row's real height while `/api/me` is in flight. It rendered an
             * empty title and no email until the answer came back, so the first thing this screen
             * did on every load was jump — and on a slow connection it showed a blank row with a
             * 로그아웃 button beside it, which is a row that looks broken rather than pending.
             */}
            {currentUser ? (
              <>
                <ItemMedia>
                  <PersonAvatar
                    email={currentUser.email}
                    image={currentUser.image}
                    name={currentUser.name}
                    size="lg"
                  />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{currentUser.name || currentUser.email}</ItemTitle>
                  {/* The email repeats nothing: it only renders when a name is on the line above. */}
                  {currentUser.name ? (
                    <ItemDescription>{currentUser.email}</ItemDescription>
                  ) : null}
                </ItemContent>
                <ItemActions>
                  <Button
                    disabled={signOut.isPending}
                    onClick={handleSignOut}
                    variant="outline"
                  >
                    {signOut.isPending ? t("Logging out…") : t("Log out")}
                  </Button>
                </ItemActions>
              </>
            ) : (
              <>
                <ItemMedia>
                  <Skeleton className="size-11 rounded-full" />
                </ItemMedia>
                <ItemContent className="gap-1.5">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-44" />
                </ItemContent>
              </>
            )}
          </Item>
          {signOutError ? (
            <p className="px-1 text-destructive text-sm" role="alert">
              {signOutError}
            </p>
          ) : null}
        </PageRows>
      </PageSection>
      <PageSection title={t("General")}>
        {/*
         * A LINE BETWEEN THE ROWS. Three settings — language, appearance, notifications — ran
         * together inside one bordered card with nothing between them, so the card read as one
         * block of text with controls scattered down its right edge rather than as three things
         * you can change. `PageRows` is the card; the rule between its children belongs to whoever
         * knows they are rows.
         */}
        <PageRows className="divide-y divide-border">
          <Item size="sm">
            <ItemContent>
              <ItemTitle>{t("Language")}</ItemTitle>
              <ItemDescription>
                {/* The reload is said out loud. It used to happen with no warning at all, which
                    from the other side of the screen is the app restarting itself. */}
                {t(
                  "Which language the interface uses. Changing it reloads the screen.",
                )}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Select
                onValueChange={handleLocaleChosen}
                value={pendingLocale ?? localeSetting}
              >
                <SelectTrigger aria-label={t("Language")} className="w-40">
                  <SelectValue>
                    {(pendingLocale ?? localeSetting) === "ko"
                      ? t("Korean")
                      : (pendingLocale ?? localeSetting) === "en"
                        ? t("English")
                        : t("System")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">{t("System")}</SelectItem>
                  <SelectItem value="ko">{t("Korean")}</SelectItem>
                  <SelectItem value="en">{t("English")}</SelectItem>
                </SelectContent>
              </Select>
            </ItemActions>
          </Item>
          {/*
           * THREE STATES, NOT A SWITCH. A switch can only say light or dark, so it had to pick one
           * for somebody who has never touched it — and it picked light, which opened the app in
           * white on a machine set to dark. Matching the Language control above is the second
           * reason: both rows now offer the same "follow the system" default in the same shape.
           */}
          <Item size="sm">
            <ItemContent>
              <ItemTitle>{t("Appearance")}</ItemTitle>
              <ItemDescription>
                {t("How {product} looks. Following the system flips with it.", {
                  product: appConfig.brand.productName,
                })}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Select
                onValueChange={(value) =>
                  setPreference(value as ThemePreference)
                }
                value={preference}
              >
                <SelectTrigger aria-label={t("Appearance")} className="w-40">
                  <SelectValue>
                    {preference === "dark"
                      ? t("Dark")
                      : preference === "light"
                        ? t("Light")
                        : t("System")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">{t("System")}</SelectItem>
                  <SelectItem value="light">{t("Light")}</SelectItem>
                  <SelectItem value="dark">{t("Dark")}</SelectItem>
                </SelectContent>
              </Select>
            </ItemActions>
          </Item>
          {/*
           * The site's permission, beside Language and Appearance because that is what it is: one
           * answer for the whole account, not a per-Bot setting. Which Bots may use it stays on
           * the Bots — this row cannot turn any of them on or off.
           *
           * `unsupportedNote` is what stops this row being a heading with nothing under it. The
           * control returns null where the environment has no notifications at all, and the
           * heading and its paragraph were drawn regardless — so the row promised something and
           * then showed no way to get it, on exactly the surfaces where it is impossible.
           */}
          <Item size="sm">
            <ItemContent>
              <ItemTitle>{t("Notifications")}</ItemTitle>
              <ItemDescription>
                {t(
                  "Tell me when a Bot speaks in a room I am not reading. Only while a tab is open — nothing arrives once they are all closed.",
                )}
              </ItemDescription>
              <NotificationPermission
                grantedNote={t("On for this browser.")}
                unsupportedNote={t("Notifications cannot be turned on here.")}
              />
            </ItemContent>
          </Item>
        </PageRows>
      </PageSection>
      {/*
       * The way to say something back, and the guide. Here as well as on the help page because
       * Settings is where a person who has run out of other ideas ends up looking.
       */}
      <PageSection title={t("Help")}>
        <PageRows className="divide-y divide-border">
          <Item size="sm">
            <ItemContent>
              <ItemTitle>{t("Questions and feedback")}</ItemTitle>
              <ItemDescription>
                {t(
                  "Something did not work, or you would like something. A person reads it.",
                )}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button onClick={() => setAsking(true)} variant="outline">
                {t("Write a message")}
              </Button>
            </ItemActions>
          </Item>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>{t("Help")}</ItemTitle>
              <ItemDescription>
                {t("How the app works, in five short sections.")}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button
                nativeButton={false}
                render={(props) => <Link to="/help" {...props} />}
                variant="outline"
              >
                {t("Open the help page")}
              </Button>
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>
      <FeedbackDialog onOpenChange={setAsking} open={asking} />
      {/*
       * The two documents, where a person who already has an account would look for them. Under
       * the preferences rather than in the rail: the rail is not drawn below `lg`, and a link
       * that exists on a wide window only is a link that does not exist on a phone.
       */}
      <footer className="mt-12">
        <LegalLinks className="text-muted-foreground text-xs" />
      </footer>
    </PageShell>
  );
}
