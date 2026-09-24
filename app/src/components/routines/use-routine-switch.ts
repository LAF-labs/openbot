import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type Routine,
  routineKeys,
  routineRequest,
} from "@/lib/routines/queries";

/**
 * A routine's on/off, for the Routines screen's switch and the card in the conversation alike.
 *
 * THE SWITCH MOVES WHEN IT IS CLICKED. It was driven straight off server state, so nothing happened
 * until the round trip landed — a control that ignores you for half a second reads as broken, and
 * people click it twice. The optimistic write is rolled back on failure, which is the only honest
 * way to show a switch that did not take. One hook for both places, so 끄기 in the conversation and
 * the switch on the screen cannot disagree about what pressing them did.
 */
export function useRoutineSwitch(routine: Pick<Routine, "id">) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean) =>
      routineRequest(`/api/routines/${routine.id}/enabled`, {
        method: "POST",
        body: JSON.stringify({ enabled }),
      }),
    onMutate: async (enabled: boolean) => {
      await queryClient.cancelQueries({ queryKey: routineKeys.all });
      const previous = queryClient.getQueryData<Routine[]>(routineKeys.all);
      // The server clears the unread rule's reason on either press (`setRoutineEnabled`).
      queryClient.setQueryData<Routine[]>(routineKeys.all, (rows) =>
        rows?.map((row) =>
          row.id === routine.id ? { ...row, enabled, pausedReason: null } : row,
        ),
      );
      return { previous };
    },
    onError: (_error, _enabled, context) => {
      if (context?.previous) {
        queryClient.setQueryData(routineKeys.all, context.previous);
      }
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: routineKeys.all }),
  });
}
