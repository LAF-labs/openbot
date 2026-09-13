import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { t } from "@/lib/i18n";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/no-access")({
  component: NoAccessScreen,
});

/**
 * The server answered `/api/me` with 403: a session that is good, for a person this deployment no
 * longer admits — a member whose role was taken away after they signed in (`guards.ts`).
 *
 * MEASURED 2026-09-10 (audit A4, finding 2): this state drew the /unreachable screen — "서버에 닿지
 * 못했습니다. 대개 저절로 풀립니다." — to somebody whose access had been withdrawn: a wrong fact and a
 * wrong promise. Like that screen it lives outside every data route and asks the server for nothing.
 *
 * Two presses, because the installed app has no address bar and no reload: looking again once
 * whoever manages the place has given the access back — a full load, like /unreachable's retry,
 * since the cached answer is the thing in question — and signing out, so another account can come
 * in through the door.
 */
function NoAccessScreen() {
  const signOut = useMutation(signOutMutationOptions(queryClient));

  const handleCheckAgain = () => {
    window.location.replace("/");
  };

  const handleSignOut = () => {
    // The session is not worth keeping either way; the door is where both outcomes lead.
    void signOut
      .mutateAsync()
      .catch(() => undefined)
      .then(() => {
        window.location.replace("/sign");
      });
  };

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background p-8 text-center">
      <p className="font-semibold text-lg">
        {t("This account no longer has access here.")}
      </p>
      <p className="max-w-sm text-pretty text-muted-foreground text-sm">
        {t(
          "The server is working. This account's access was taken away, and whoever manages this place can give it back.",
        )}
      </p>
      <div className="mt-1 flex gap-2">
        <Button onClick={handleCheckAgain} variant="outline">
          {t("Check again")}
        </Button>
        <Button
          disabled={signOut.isPending}
          onClick={handleSignOut}
          variant="ghost"
        >
          {t("Log out")}
        </Button>
      </div>
    </div>
  );
}
