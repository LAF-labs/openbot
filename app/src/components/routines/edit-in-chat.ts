import { useQuery } from "@tanstack/react-query";
import { conversationOf } from "@/lib/agents/my-bots";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { t } from "@/lib/i18n";
import { josa } from "@/lib/josa";

/**
 * 고치기, AS A SENTENCE STARTED IN THE CONVERSATION RATHER THAN A FORM.
 *
 * A routine a Bot made from "매주 월요일 9시에 매출 요약 알려줘" is one the person shapes the same way
 * — by saying what they want different — and the edit button used to open a four-field form with
 * the Bot's own instruction text in it (UI/UX audit 0.5.3, item 8). It now opens the Bot's
 * conversation with the composer holding "‘주간 매출 요약’을 이렇게 바꿔 줘: " and the cursor at
 * its end. The form is still there, as 직접 고치기.
 *
 * THE ADDRESS IS THE CONTRACT with the conversation screen: `/channel/{id}?draft=<sentence>`. That
 * screen fills its composer from `draft`, focuses it and drops the parameter (audit §3, "묶음 사이의
 * 약속"). Built as a string rather than a typed search because the parameter is the other screen's
 * to declare.
 */
export function editDraft(routineName: string): string {
  return t("Change “{name}” like this: ", {
    name: routineName,
    josa: josa(routineName, "을/를"),
  });
}

export function editInChatHref(channelId: string, routineName: string): string {
  return `/channel/${encodeURIComponent(channelId)}?draft=${encodeURIComponent(editDraft(routineName))}`;
}

/**
 * The conversation a routine's answers land in — its Bot's — or undefined while the list loads or
 * when the Bot has never been spoken to. Without one there is nowhere to start the sentence, and
 * the caller offers the form instead.
 */
export function useConversationWith(agentId: string): string | undefined {
  const { data: channels } = useQuery(channelListQueryOptions());
  return conversationOf(agentId, channels)?.id;
}
