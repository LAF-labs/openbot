import { IconChevronRight } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { NotificationPermission } from "@/components/notifications/notification-permission";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { appConfig } from "@/lib/generated/application-config";
import { type Locale, localeSetting, setLocaleSetting, t } from "@/lib/i18n";
import type { ThemePreference } from "@/lib/theme";

export const Route = createFileRoute("/_authed/settings/")({
  component: RouteComponent,
});

function RouteComponent() {
  const { preference, setPreference } = useTheme();
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const signOut = useMutation(signOutMutationOptions(queryClient));

  const [signOutError, setSignOutError] = useState<string | null>(null);

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
       */}
      <PageSection title={t("Account")}>
        <PageRows>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>{currentUser?.name || currentUser?.email}</ItemTitle>
              {/* The email repeats nothing: it only renders when a name is on the line above. */}
              {currentUser?.name ? (
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
          </Item>
          {/*
           * The whole row is the link, the way every other row that goes exactly one place is
           * drawn. It sits under the account it belongs to: which services this deployment can
           * reach is an administrator's, but whether YOUR account is behind one of them is yours.
           */}
          <Item
            render={(props) => (
              <Link to="/settings/connected-accounts" {...props} />
            )}
            size="sm"
          >
            <ItemContent>
              <ItemTitle>{t("Connected accounts")}</ItemTitle>
              <ItemDescription>
                {t(
                  "Services you have connected with your own account, so a Bot can answer with what you can see.",
                )}
              </ItemDescription>
            </ItemContent>
            <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </Item>
          {signOutError ? (
            <p className="px-1 text-destructive text-sm" role="alert">
              {signOutError}
            </p>
          ) : null}
        </PageRows>
      </PageSection>
      <PageSection title={t("General")}>
        <PageRows>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>{t("Language")}</ItemTitle>
              <ItemDescription>
                {t("Which language the interface uses.")}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Select
                onValueChange={(value) => setLocaleSetting(value as Locale)}
                value={localeSetting}
              >
                <SelectTrigger aria-label={t("Language")} className="w-40">
                  <SelectValue>
                    {localeSetting === "ko"
                      ? t("Korean")
                      : localeSetting === "en"
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
           */}
          <Item size="sm">
            <ItemContent>
              <ItemTitle>{t("Notifications")}</ItemTitle>
              <ItemDescription>
                {t(
                  "Tell me when a Bot speaks in a room I am not reading. Only while a tab is open — nothing arrives once they are all closed.",
                )}
              </ItemDescription>
              <NotificationPermission grantedNote={t("On for this browser.")} />
            </ItemContent>
          </Item>
        </PageRows>
      </PageSection>
    </PageShell>
  );
}
