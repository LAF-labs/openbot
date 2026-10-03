import { t } from "@/lib/i18n";

/**
 * WHAT IS DRAWN IN PLACE OF THE APP WHERE THE ENGINE CANNOT RUN IT (`lib/engine-floor.ts`).
 *
 * The whole screen, like the router's own (`router.tsx`), and nothing to press: what brings the app
 * back is an update the person makes outside this window, after which they open it again. It says
 * what to update and where, for a Mac and for a phone, because the person reading it did not choose
 * an engine and has no reason to know there is one.
 *
 * ONE SHORT SENTENCE TO A LINE, AND ONLY SOLID COLOURS. Nothing balances lines on the engines this
 * is drawn on (`text-wrap` is newer than they are), and one long sentence was seen to leave its
 * last words on a line of their own; and they draw a colour with an opacity on it as the full
 * colour.
 */
export function OldEngineScreen() {
  return (
    <div
      className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background p-8 text-center"
      role="alert"
    >
      <div className="flex flex-col gap-1.5">
        <p className="font-semibold text-lg">{t("An update is needed.")}</p>
        <p className="text-muted-foreground text-sm">
          {t("This device's system is too old to show the app.")}
        </p>
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <p>{t("On a Mac, update macOS and Safari in Software Update.")}</p>
        <p>{t("On an iPhone or iPad, update iOS in Settings.")}</p>
        <p>{t("Then open the app again.")}</p>
      </div>
      <p className="text-muted-foreground text-xs">
        {t("It needs Safari 16.4 or later (macOS 13.3, iOS 16.4).")}
      </p>
    </div>
  );
}
