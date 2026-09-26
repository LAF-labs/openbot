import { useEffect, useState } from "react";
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
import { appConfig } from "@/lib/generated/application-config";
import { t } from "@/lib/i18n";
import {
  type SummonSetting,
  setShellSummonShortcut,
  shellSummonShortcut,
  summonKeysOf,
} from "@/lib/notifications/shell";
import { platformOf } from "@/lib/version";

/**
 * 단축키로 열기 — the keys that bring the installed app forward from any other app.
 *
 * On unless somebody turns it off, because a shortcut nobody knows about reaches nobody; the
 * default and the list are the shell's (`SUMMON_CHOICES` in desktop/src-tauri/src/lib.rs, with the
 * reasoning for each). This row only chooses among them.
 *
 * DRAWN ONLY WHERE IT WORKS. A browser tab has no shell, and an app installed before the shell
 * grew the command answers nothing: in both the row is absent rather than a control that saves and
 * does nothing. And when the shell could not take the keys it was given, the row says so instead of
 * reading as on.
 */
export function SummonShortcutRow() {
  const [setting, setSetting] = useState<SummonSetting | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let isMounted = true;
    void shellSummonShortcut().then((answer) => {
      if (isMounted) setSetting(answer);
    });
    return () => {
      isMounted = false;
    };
  }, []);

  if (!setting) return null;

  const isMac = platformOf(navigator) === "macOS";
  const labelOf = (id: string) => summonKeysOf(id, isMac) ?? t("Off");

  const handleChosen = async (choice: string) => {
    setIsSaving(true);
    const saved = await setShellSummonShortcut(choice);
    setIsSaving(false);
    if (saved) setSetting(saved);
  };

  const isRefused = setting.choice !== "off" && !setting.active;

  return (
    <Item size="sm">
      <ItemContent>
        <ItemTitle>{t("Open with a shortcut")}</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {isRefused
            ? t(
                "This shortcut could not be turned on. Another app may be using it — choose another.",
              )
            : t("Press it in any app to bring {product} to the front.", {
                product: appConfig.brand.productName,
              })}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Select
          disabled={isSaving}
          onValueChange={(value) => {
            if (typeof value === "string") void handleChosen(value);
          }}
          value={setting.choice}
        >
          <SelectTrigger
            aria-label={t("Open with a shortcut")}
            className="w-40"
          >
            <SelectValue>{labelOf(setting.choice)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {setting.choices.map((id) => (
              <SelectItem key={id} value={id}>
                {labelOf(id)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ItemActions>
    </Item>
  );
}
