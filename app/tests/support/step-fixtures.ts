import type { Message } from "@ag-ui/core";
import { withheldMark } from "@shared/tools/withheld";

/**
 * A conversation with steps of work in it, message by message.
 *
 * Shared by `step-fold.test.tsx` and the process it has `steps-render.tsx` press an answer's menu
 * in: the two halves of one file's tests have to be talking about the same conversation.
 */

export const ASKED: Message = {
  id: "q-asked",
  role: "user",
  content: "내 메일에 온 것 있나 보고 알려줘",
};

/** A connected service's tool this app has no words for: its line reads "Used a connected service". */
export const SERVICE_TOOL = "mcp__orders__look_up";

export const called = (id: string, name = SERVICE_TOOL): Message =>
  ({
    id: `a-${id}`,
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: `call-${id}`,
        type: "function",
        function: { name, arguments: "{}" },
      },
    ],
  }) as Message;

export const answered = (id: string, content = "ok"): Message =>
  ({
    id: `t-${id}`,
    role: "tool",
    toolCallId: `call-${id}`,
    content,
  }) as Message;

/** A mail's text as the Bot was given it: the one-time code taken out, a mark where it was. */
export const MAIL_WITH_A_CODE = `제목: 인증번호 안내\n인증번호: ${withheldMark("code", "Ab12Cd34Ef56")}`;

export const said = (id: string, text: string): Message => ({
  id,
  role: "assistant",
  content: text,
});

export const asked = (id: string, text: string): Message => ({
  id,
  role: "user",
  content: text,
});

/** A step and its result, as the record holds a finished one. */
export const done = (id: string, name?: string): Message[] => [
  called(id, name),
  answered(id),
];

/** Rows of talk after a turn, enough to put that turn at the top of the drawn window. */
export const talk = (pairs: number): Message[] =>
  Array.from({ length: pairs }, (_, at) => [
    asked(`q-later-${at}`, `질문 ${at}`),
    said(`a-later-${at}`, `답 ${at}`),
  ]).flat();
