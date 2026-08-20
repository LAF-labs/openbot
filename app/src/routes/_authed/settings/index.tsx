import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
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
import { Switch } from "@/components/ui/switch";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { appConfig } from "@/lib/generated/application-config";
import { type Locale, localeSetting, setLocaleSetting, t } from "@/lib/i18n";

export const Route = createFileRoute("/_authed/settings/")({
  component: RouteComponent,
});

function RouteComponent() {
  const { dark, setDark } = useTheme();
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const signOut = useMutation(signOutMutationOptions(queryClient));

  const handleSignOut = async () => {
    await signOut.mutateAsync();
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
              <ItemTitle>
                {currentUser?.name || currentUser?.email}
              </ItemTitle>
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
                {t("Log out")}
              </Button>
            </ItemActions>
          </Item>
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
          <Item size="sm">
            <ItemContent>
              <ItemTitle>{t("Dark theme")}</ItemTitle>
              <ItemDescription>
                {t("Use the dark appearance across {product}.", {
                  product: appConfig.brand.productName,
                })}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label={t("Dark theme")}
                checked={dark}
                onCheckedChange={setDark}
              />
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>
    </PageShell>
  );
}
