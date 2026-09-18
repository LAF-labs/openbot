import { useSyncExternalStore } from "react";
import { ConnectionCheckPanel } from "@/components/help/connection-check-panel";
import { SectionBoundary } from "@/components/layout/section-boundary";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t } from "@/lib/i18n";

/**
 * 연결 점검 in a dialog, over whatever screen the person was on.
 *
 * A DIALOG AND NOT A PAGE, because of when it is needed. The line that says the connection was lost
 * is the likeliest way in, and at that moment the network may be gone: a route is a chunk fetched on
 * the way there (`autoCodeSplitting`), and with nothing reaching the server that fetch fails and the
 * person gets the error screen instead of the check. A dialog is already in the bundle the signed-in
 * shell loaded. It also keeps them where they were stuck, and the app's own socket up beside the
 * check's — which is the socket the check exists to compare with.
 *
 * The run belongs to the panel, which Base UI mounts when the dialog opens and unmounts when it
 * closes: opening it is running it, and closing it stops whatever is still out.
 */
export const ConnectionCheckDialog = ({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) => (
  <Dialog onOpenChange={onOpenChange} open={open}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t("Connection check")}</DialogTitle>
        <DialogDescription>
          {t(
            "Whether this device reaches the app's server, step by step, and what to try where it does not.",
          )}
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        {/*
         * The check fails inside its dialog, under the title and the close button. The dialog sits
         * in the signed-in shell above every section, so a panel that threw used to take the whole
         * window to the router's error screen — for somebody who opened it because the app already
         * seemed stuck.
         */}
        <SectionBoundary section="connection_check">
          <ConnectionCheckPanel />
        </SectionBoundary>
      </DialogBody>
    </DialogContent>
  </Dialog>
);

/*
 * The shell's one check, openable from anywhere without a prop threaded to it: the reconnect line
 * sits in the signed-in shell and the help page three layouts below it. Module state for the same
 * reason the socket's lost flag is (`use-channel-events.ts`) — one window, one of it.
 */
let isShellCheckOpen = false;
const listeners = new Set<() => void>();

const setShellCheckOpen = (next: boolean) => {
  isShellCheckOpen = next;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Open the signed-in shell's 연결 점검. */
export function openConnectionCheck(): void {
  setShellCheckOpen(true);
}

/** Mounted once, by the signed-in shell (`routes/_authed.tsx`). */
export const ShellConnectionCheck = () => {
  const open = useSyncExternalStore(
    subscribe,
    () => isShellCheckOpen,
    () => false,
  );
  return <ConnectionCheckDialog onOpenChange={setShellCheckOpen} open={open} />;
};
