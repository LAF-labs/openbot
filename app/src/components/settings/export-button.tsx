import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

/**
 * Take a copy of the account, and say that the press was heard.
 *
 * AN ANCHOR, NOT A FETCH. The response is an attachment the browser streams straight to disk;
 * pulling a whole account through JavaScript first would hold it in memory for no reason and lose
 * the progress the browser shows for free. That is also why there is no success state to render:
 * nothing about the response comes back to this component, so the only honest thing it can report
 * is that the press happened.
 *
 * WHICH IS THE WHOLE POINT. It was a bare link. Pressed, nothing visibly changed while the server
 * walked the account and built the file, so the second and third press each started another export
 * of the same thing. It holds for a few seconds now and says what it is doing.
 *
 * `aria-disabled` and a class rather than `disabled`: this renders as an `<a>`, and `disabled` on
 * an anchor is an attribute the browser ignores — the link would still navigate.
 *
 * `download`, AND IT IS NOT DECORATION. A browser reads the server's `Content-Disposition:
 * attachment` and saves the file. The installed app's webview does not: without the attribute it
 * asks only whether it can DRAW the response, and it can draw JSON. Measured in the shell on macOS
 * 26.6, 2026-10-02: the press replaced the whole app with the export as raw text — in a window
 * with no back button — and saved nothing. The attribute is what tells a webview, before any
 * request is made, that this press is a save. The name is still the server's: an empty
 * `download` leaves it to the header.
 */

/** How long the button stays held after a press. Long enough for the browser to start the save. */
export const PREPARING_MS = 4000;

export const ExportButton = ({
  /** Only ever passed by the test that measures the hold. */
  holdMs = PREPARING_MS,
}: {
  holdMs?: number;
}) => {
  const [isPreparing, setIsPreparing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const handleExport = () => {
    setIsPreparing(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setIsPreparing(false), holdMs);
  };

  return (
    <Button
      aria-disabled={isPreparing}
      className={isPreparing ? "pointer-events-none opacity-60" : ""}
      // The primitive assumes a real <button> and warns that rendering anything else takes away
      // native button semantics. It is a link on purpose — see above — so it says so.
      nativeButton={false}
      render={(props) => (
        <a download href="/api/me/export" {...props} onClick={handleExport} />
      )}
      variant="outline"
    >
      {isPreparing ? t("Preparing…") : t("Download")}
    </Button>
  );
};
