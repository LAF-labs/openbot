/**
 * Which question words can answer (`lib/turns/typed-answer.ts`).
 *
 * The mounted half is `choice-answer.test.tsx`; this is the rule by itself, with the cards a turn
 * can be stopped on side by side.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  claimAutoSend,
  forgetUnsentCache,
  handToPerson,
  isKeptForCard,
  isWaitingForBot,
  keepUnsent,
  readSendable,
  readUnsent,
  type UnsentMessage,
} from "@/components/channels/composer/outbox";
import {
  answeredInWords,
  askerOf,
  hasResult,
  holdsCall,
  isSavedByPress,
  isShownOnCard,
  openChoiceCall,
  restAfter,
  setFirstRest,
  typedAnswer,
  typedAnswerIn,
} from "@/lib/turns/typed-answer";

const call = (id: string, name: string, args: unknown = {}) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});
const asking = (id: string, ...calls: ReturnType<typeof call>[]) =>
  ({ id, role: "assistant", content: "", toolCalls: calls }) as Message;

const CHOICE = { title: "저녁 메뉴", options: [{ id: "a", label: "한식" }] };

describe("the question words can answer", () => {
  test("is the choice card the turn is stopped on", () => {
    const messages = [asking("m-1", call("c-1", "askChoice", CHOICE))];
    expect(openChoiceCall(messages, ["c-1"])).toBe("c-1");
  });

  test("is the newest of them, when the turn waits on more than one", () => {
    const messages = [
      asking("m-1", call("c-1", "askChoice", CHOICE)),
      asking("m-2", call("c-2", "askChoice", CHOICE)),
    ];
    expect(openChoiceCall(messages, ["c-1", "c-2"])).toBe("c-2");
  });

  test("is not one the turn is no longer waiting on", () => {
    const messages = [asking("m-1", call("c-1", "askChoice", CHOICE))];
    expect(openChoiceCall(messages, [])).toBeNull();
    expect(openChoiceCall(messages, ["c-other"])).toBeNull();
  });

  test("is not a yes-or-no card: words must never be taken for a yes", () => {
    const messages = [
      asking("m-1", call("c-1", "askApproval", { title: "메일 보내기" })),
    ];
    expect(openChoiceCall(messages, ["c-1"])).toBeNull();
  });

  test("is not a connect card", () => {
    const messages = [asking("m-1", call("c-1", "showConnection", {}))];
    expect(openChoiceCall(messages, ["c-1"])).toBeNull();
  });

  test("is not the choice that saves who the person is: that one is a press", () => {
    const messages = [
      asking(
        "m-1",
        call("c-1", "askChoice", { title: "누구세요?", saves: "persona" }),
      ),
    ];
    expect(openChoiceCall(messages, ["c-1"])).toBeNull();
  });

  /*
   * The server keeps what waits by the call's id alone, and a provider's ids are its own to mint.
   * Scanning on past a waiting yes-or-no card to an older choice that carries the same id would
   * hand the approval the person's words: "응", filed as its result, reads as a yes.
   */
  test("is decided by the newest call under a waiting id, never by an older one with the same id", () => {
    const messages = [
      asking("m-1", call("c-1", "askChoice", CHOICE)),
      asking("m-2", call("c-1", "askApproval", { title: "메일 보내기" })),
    ];
    expect(openChoiceCall(messages, ["c-1"])).toBeNull();
    // And the other way round: the newer choice is the one that waits.
    expect(openChoiceCall([...messages].reverse(), ["c-1"])).toBe("c-1");
  });

  test("is a choice whose `saves` says nothing: words are taken where the card says they are", () => {
    for (const saves of [undefined, null]) {
      const messages = [
        asking("m-1", call("c-1", "askChoice", { ...CHOICE, saves })),
      ];
      expect(openChoiceCall(messages, ["c-1"])).toBe("c-1");
      expect(isSavedByPress(saves)).toBe(false);
    }
    expect(isSavedByPress("persona")).toBe(true);
  });

  test("is not a choice whose arguments cannot be read", () => {
    const broken = {
      id: "m-1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "c-1",
          type: "function",
          function: { name: "askChoice", arguments: "{" },
        },
      ],
    } as Message;
    expect(openChoiceCall([broken], ["c-1"])).toBeNull();
  });
});

describe("what the Bot is answered with", () => {
  test("is the person's words, and they are read back as written", () => {
    const sent = typedAnswer("둘 다 말고 냉면");
    expect(sent).toEqual({ answer: "둘 다 말고 냉면" });
    expect(typedAnswerIn(sent)).toBe("둘 다 말고 냉면");
  });

  test("a pressed option, a code, or nothing is not a typed answer", () => {
    expect(typedAnswerIn({ choice: "korean", label: "한식" })).toBeUndefined();
    expect(typedAnswerIn({ answer: "   " })).toBeUndefined();
    expect(typedAnswerIn(undefined)).toBeUndefined();
  });
});

describe("the words a card was answered with, read off the conversation", () => {
  const result = (toolCallId: string, content: string) =>
    ({ id: `r-${toolCallId}`, role: "tool", toolCallId, content }) as Message;
  const question = asking("m-1", call("c-1", "askChoice", CHOICE));

  test("are the call's result, where it is a typed answer", () => {
    const messages = [question, result("c-1", '{"answer":"둘 다 말고 냉면"}')];
    expect(answeredInWords(messages, "c-1")).toBe("둘 다 말고 냉면");
  });

  test("are nothing while the call has no result, or for another call's", () => {
    expect(answeredInWords([question], "c-1")).toBeUndefined();
    const messages = [question, result("c-2", '{"answer":"냉면"}')];
    expect(answeredInWords(messages, "c-1")).toBeUndefined();
  });

  test("and whether its question is over at all is whether the call has a result", () => {
    expect(hasResult([question], "c-1")).toBe(false);
    expect(hasResult([question, result("c-2", "x")], "c-1")).toBe(false);
    expect(hasResult([question, result("c-1", "laf:stopped")], "c-1")).toBe(
      true,
    );
  });

  // An id is decided by its newest call here too: an older call's result is not this one's.
  test("are the newest call's under that id, never an older call's that carried the same one", () => {
    const older = [question, result("c-1", '{"answer":"예전 답"}')];
    const again = asking("m-2", call("c-1", "askChoice", CHOICE));
    expect(answeredInWords([...older, again], "c-1")).toBeUndefined();
    expect(hasResult([...older, again], "c-1")).toBe(false);
    const answered = [...older, again, result("c-1", '{"answer":"이번 답"}')];
    expect(answeredInWords(answered, "c-1")).toBe("이번 답");
    expect(hasResult(answered, "c-1")).toBe(true);
  });

  /*
   * Words are kept with the message that asked (`askedBy`), because an id may be another
   * question's later. Read by the id alone, a later namesake's result was theirs: its answer, or
   * its end (review, eighth round).
   */
  test("are the result of the call the asking message made, where the words were kept with it", () => {
    const again = asking("m-2", call("c-1", "askChoice", CHOICE));
    // The earlier question was never answered — its turn died — and the later one was.
    const messages = [question, again, result("c-1", '{"answer":"이번 답"}')];
    expect(answeredInWords(messages, "c-1", "m-1")).toBeUndefined();
    expect(hasResult(messages, "c-1", "m-1")).toBe(false);
    expect(answeredInWords(messages, "c-1", "m-2")).toBe("이번 답");
    // An earlier question's own result is its own, whatever the id went on to.
    const both = [question, result("c-1", '{"answer":"예전 답"}'), again];
    expect(answeredInWords(both, "c-1", "m-1")).toBe("예전 답");
    expect(hasResult(both, "c-1", "m-2")).toBe(false);
  });

  test("and of a call these messages do not hold, what stands before any call they do", () => {
    const again = asking("m-2", call("c-1", "askChoice", CHOICE));
    // The asking message is above this page, and its result is the first thing on it.
    const page = [
      result("c-1", '{"answer":"예전 답"}'),
      again,
      result("c-1", '{"answer":"이번 답"}'),
    ];
    expect(answeredInWords(page, "c-1", "m-1")).toBe("예전 답");
    // Nothing of it before the next call under the id: that call's result is not its.
    expect(hasResult([again, result("c-1", "x")], "c-1", "m-1")).toBe(false);
  });

  test("the message that asked is the newest that carries the call, and a page holds a question by it", () => {
    const again = asking("m-2", call("c-1", "askChoice", CHOICE));
    expect(askerOf([question, again], "c-1")).toBe("m-2");
    expect(askerOf([question], "c-2")).toBeUndefined();
    expect(holdsCall([again], "c-1")).toBe(true);
    expect(holdsCall([again], "c-1", "m-1")).toBe(false);
    expect(holdsCall([question, again], "c-1", "m-1")).toBe(true);
  });

  test("are nothing for any other result: an option pressed, a wait that ran out, a sentence", () => {
    for (const content of [
      '{"choice":"korean","label":"한식"}',
      '{"code":"laf:nobody_answered"}',
      "답이 없었어요",
      '"냉면"',
    ]) {
      const messages = [question, result("c-1", content)];
      expect(answeredInWords(messages, "c-1")).toBeUndefined();
    }
  });
});

describe("words kept for a card are shown on the card itself", () => {
  test("on their way to its door for the first time, and once the door has taken them", () => {
    expect(isShownOnCard({ at: "out", tries: 0 })).toBe(true);
    expect(isShownOnCard({ at: "taken", tries: 0 })).toBe(true);
    // Taken at last, after offers the door did not take.
    expect(isShownOnCard({ at: "taken", tries: 3 })).toBe(true);
  });

  /*
   * A page reloaded between the door taking an answer and the Bot being free to file it — minutes,
   * behind a routine — has made no offer of its own, and read "보낼 예정" under words the Bot had.
   */
  test("and where this screen has made no offer of them: kept from before a reload", () => {
    expect(isShownOnCard(undefined)).toBe(true);
  });

  // Review, thirteenth round: back under the card, they gave its options back beside the offer.
  test("and while the door has not taken them, through every offer made again", () => {
    expect(isShownOnCard({ at: "resting", tries: 1 })).toBe(true);
    expect(isShownOnCard({ at: "due", tries: 1 })).toBe(true);
    expect(isShownOnCard({ at: "out", tries: 1 })).toBe(true);
  });

  test("but not once another answer to the question reached the card first", () => {
    expect(isShownOnCard({ at: "answered", tries: 0 })).toBe(false);
  });
});

describe("how long words rest before they are offered to their card again", () => {
  afterEach(() => setFirstRest());

  test("is the stream's own waits: half a second, doubling to eight", () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(restAfter)).toEqual([
      500, 1000, 2000, 4000, 8000, 8000, 8000,
    ]);
  });

  test("and a test can hold the first of them", () => {
    setFirstRest(40);
    expect([1, 2].map(restAfter)).toEqual([40, 80]);
    setFirstRest();
    expect(restAfter(1)).toBe(500);
  });
});

/*
 * THE OUTBOX'S HALF: what words kept for a card are to everything that reads what the device kept
 * (`composer/outbox.ts`). No storage under `bun test`, which the outbox takes as a device that
 * refuses it: kept for this tab only.
 */
describe("words kept for a card, among what the device kept", () => {
  const CHANNEL = "channel_outbox";
  afterEach(() => forgetUnsentCache());

  const typed = (id: string, more: Partial<UnsentMessage> = {}) => ({
    id,
    text: id,
    instructions: [],
    at: `2026-10-03T00:00:0${id.length}.000Z`,
    ...more,
  });
  const forCard = (id: string) => typed(id, { waiting: true, answerTo: "c-1" });
  const held = (id: string) =>
    readUnsent(CHANNEL).find((message) => message.id === id);

  test("are waiting for the Bot, and are handed over to it by nothing", () => {
    keepUnsent(CHANNEL, forCard("a"));
    keepUnsent(CHANNEL, typed("bb", { waiting: true }));
    expect(isKeptForCard(held("a") as UnsentMessage)).toBe(true);
    expect(isWaitingForBot(held("a") as UnsentMessage)).toBe(true);
    expect(readSendable(CHANNEL).map((message) => message.id)).toEqual(["bb"]);
  });

  /*
   * Every entry used to be marked as tried by a claim, whoever it claimed. Beside a correction
   * that was claimed, words still kept for a card were drawn as not sent while their card waited,
   * and never went by themselves once its question was over.
   */
  test("are left as they are when what waits beside them is taken to be sent", () => {
    keepUnsent(CHANNEL, forCard("a"));
    keepUnsent(CHANNEL, typed("bb", { waiting: true }));
    expect(claimAutoSend(CHANNEL).map((message) => message.id)).toEqual(["bb"]);
    expect(held("bb")?.autoTried).toBe(true);
    expect(held("a")?.autoTried).toBe(false);
    expect(isWaitingForBot(held("a") as UnsentMessage)).toBe(true);
    // And nothing more is claimed for them alone.
    expect(claimAutoSend(CHANNEL)).toEqual([]);
    expect(held("a")?.autoTried).toBe(false);
  });

  test("handed to the person: no longer waiting, never by themselves, theirs to send — and still marked", () => {
    keepUnsent(CHANNEL, forCard("a"));
    handToPerson(CHANNEL, held("a") as UnsentMessage);
    expect(held("a")).toMatchObject({ answerTo: "c-1", autoTried: true });
    expect(held("a")?.waiting).toBeUndefined();
    expect(isKeptForCard(held("a") as UnsentMessage)).toBe(false);
    expect(claimAutoSend(CHANNEL)).toEqual([]);
    expect(readSendable(CHANNEL).map((message) => message.id)).toEqual(["a"]);
    // Handed over once: a second time changes nothing.
    const before = readUnsent(CHANNEL);
    handToPerson(CHANNEL, held("a") as UnsentMessage);
    expect(readUnsent(CHANNEL)).toBe(before);
  });
});
