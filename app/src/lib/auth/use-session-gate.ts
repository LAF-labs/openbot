import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { authKeys } from "./queries";
import { SESSION_LOST, sessionState } from "./session-watch";

/**
 * To the door, with where they were.
 *
 * Mounted once, in the authenticated shell, so it only ever acts on a person the app believed was
 * signed in. The cached answer to "who is signed in" is set to nobody first: the route guards read
 * that cache, and with it still saying "you" for another minute (`staleTime`), the door would have
 * sent them straight back in and around again.
 *
 * `replace` rather than `push`: a Back press from the sign-in screen must not land on a screen the
 * session can no longer draw.
 */
export function useSessionGate(): void {
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  /** Several requests fail together when a session ends; one of them is enough. */
  const leaving = useRef(false);

  useEffect(() => {
    const onLost = () => {
      if (leaving.current) return;
      leaving.current = true;
      queryClient.setQueryData(authKeys.currentUser(), null);
      void navigate({
        to: "/sign",
        search: { redirect: router.state.location.href },
        replace: true,
      });
    };
    sessionState.addEventListener(SESSION_LOST, onLost);
    return () => {
      sessionState.removeEventListener(SESSION_LOST, onLost);
    };
  }, [navigate, queryClient, router]);
}
