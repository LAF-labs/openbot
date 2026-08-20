import { createFileRoute } from "@tanstack/react-router";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { useTheme } from "@/components/theme-provider";
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
import { appConfig } from "@/lib/generated/application-config";
import { type Locale, localeSetting, setLocaleSetting, t } from "@/lib/i18n";

export const Route = createFileRoute("/_authed/settings/")({
  component: RouteComponent,
});

function RouteComponent() {
  const { dark, setDark } = useTheme();

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
