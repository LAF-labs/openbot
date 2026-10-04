import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "@ag-ui/core";
import { mount, unmountAll } from "./support/mount";

/**
 * A TILDE IS A TILDE.
 *
 * Pressed on the running app, 2026-10-02. The Bot answered "안녕하세요~! 오늘도 화이팅~! 감사합니다~.
 * 또 오세요~." and the screen drew "안녕하세요! 오늘도 화이팅! 감사합니다. 또 오세요." with
 * "! 오늘도 화이팅" and ". 또 오세요" struck through: four tildes gone and a line through the middle
 * of a greeting. GFM reads one tilde each side as strikethrough, the same as two, and the plugin
 * that lets emphasis close against a Korean letter lets a tilde after one open it.
 *
 * In Korean a tilde is a mark of tone and of a range — 감사합니다~, 9시~18시 — and nobody strikes text
 * out with one. Two tildes each side still do.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3110/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});
afterEach(async () => {
  await unmountAll();
});

/** The Bot's reply as the transcript draws it: finished, or still arriving. */
async function drawn(markdown: string, arriving = false) {
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { ChatTranscript } = await import(
    "../src/components/channels/chat-transcript"
  );
  const messages: Message[] = [
    { id: "u-1", role: "user", content: "물어본 것" },
    { id: "a-1", role: "assistant", content: markdown },
  ];
  // Read once `mount` has rendered and settled, with no longer wait: see `drawn` in
  // `copied-reply.test.tsx`, measured over every answer in both files.
  const view = await mount(
    <QueryClientProvider client={new QueryClient()}>
      <ChatTranscript busy={arriving} messages={messages} />
    </QueryClientProvider>,
  );
  const body = [
    ...view.host.querySelectorAll('[data-slot="bubble-content"]'),
  ].at(-1);
  if (!body) throw new Error("no reply drawn");
  return {
    words: body.textContent ?? "",
    struck: [...body.querySelectorAll("del")].map((del) => del.textContent),
    bold: body.querySelectorAll('[data-streamdown="strong"]').length,
  };
}

/** What a Bot with a friendly tone writes, and what a schedule or a price range looks like. */
const ONE_EACH_SIDE = [
  "안녕하세요~! 오늘도 화이팅~! 감사합니다~. 또 오세요~.",
  "네~! 알겠습니다~",
  "좋아요~? 정말요~?",
  "(오전~) 그리고 (오후~)",
  "영업은 9시~18시, 월~금이에요.",
  "인원은 10~20명, 30~40명입니다.",
  "~하나~ 짜리",
];

/** One pair of tone was enough: the renderer closed it for the answer and struck out the rest. */
const A_PAIR_NEVER_CLOSED = [
  "감사합니다~~! 좋은 하루 되세요.",
  "오늘 날씨는 맑아요~~. 내일은 비가 와요.",
  "감사합니다~~ 좋은 하루 되세요.",
  "좋아요~~~! 최고예요.",
];

/** Two pairs of tone are, to the letter, an opening pair and a closing one. */
const TWO_PAIRS_OF_TONE = [
  "네~~! 알겠습니다~~!",
  "화이팅~~!! 감사합니다~~!!",
  "기다릴게요~~. 천천히 하세요~~.",
  "네~~! 알겠습니다~~! 바로 할게요~~!",
  "**네**~~! 알겠습니다~~!",
  "네~~!\n알겠습니다~~!",
];

/**
 * A friendly ending is as often a face as a full stop. Drawn 2026-10-02, before anybody met it:
 * "감사합니다~~^^ 좋은 하루 되세요~~^^" lost its tildes and had "^^ 좋은 하루 되세요" struck out, since
 * only the punctuation a sentence ends on was taken for what follows a tilde of tone.
 */
const TWO_PAIRS_OF_TONE_AND_A_FACE = [
  "감사합니다~~^^ 좋은 하루 되세요~~^^",
  "안녕하세요~~😊 오늘도 좋은 하루 보내세요~~💕",
  "네~~ㅎㅎ 알겠어요~~ㅎㅎ",
  "좋아요~~♡ 또 만나요~~♡",
  "고마워요~~ㅠㅠ 정말 감동이에요~~ㅠㅠ",
  "안녕~~^^\n반가워~~^^",
  "와~~👍 최고예요~~👍 감사합니다.",
  "네~~!ㅎㅎ 알겠습니다~~!ㅎㅎ",
];

function drawnAsWritten(sentences: readonly string[]) {
  for (const sentence of sentences) {
    test(sentence, async () => {
      const reply = await drawn(sentence);
      expect(reply.struck).toEqual([]);
      expect(reply.words).toBe(sentence.replaceAll("**", ""));
    });
  }
}

describe("one tilde each side is drawn as it was written", () => {
  drawnAsWritten(ONE_EACH_SIDE);

  test("and while the answer is still arriving", async () => {
    const reply = await drawn(ONE_EACH_SIDE[0] ?? "", true);
    expect(reply.struck).toEqual([]);
    expect(reply.words).toBe(ONE_EACH_SIDE[0]);
  });
});

describe("a pair of tone that nothing closes is not closed for the answer", () => {
  drawnAsWritten(A_PAIR_NEVER_CLOSED);

  test("and while the answer is still arriving", async () => {
    const reply = await drawn("감사합니다~~! 좋은 하루", true);
    expect(reply.struck).toEqual([]);
    expect(reply.words).toBe("감사합니다~~! 좋은 하루");
  });
});

describe("two pairs of tone strike out nothing", () => {
  drawnAsWritten(TWO_PAIRS_OF_TONE);
});

describe("nor when what follows the tone is a face, a heart or a laugh", () => {
  drawnAsWritten(TWO_PAIRS_OF_TONE_AND_A_FACE);
});

describe("what was already read right stays so", () => {
  test("two tildes each side strike the words between them", async () => {
    const reply = await drawn("~~10,000원~~ 8,000원이에요.");
    expect(reply.struck).toEqual(["10,000원"]);
    expect(reply.words).toBe("10,000원 8,000원이에요.");
  });

  test("and against a Korean letter, as emphasis closes against one", async () => {
    const reply = await drawn(
      "기온은 **23.5°**예요. 가격은~~만원~~팔천 원이에요. ~~1.5%~~에서 2%로 올랐어요.",
    );
    expect(reply.bold).toBe(1);
    expect(reply.struck).toEqual(["만원", "1.5%"]);
  });

  test("what is struck may begin with a full stop, where it does not hang on a word", async () => {
    const reply = await drawn("이제 ~~.env~~ 대신 설정 화면을 써요.");
    expect(reply.struck).toEqual([".env"]);
  });

  /*
   * Review, first round. What is struck may begin with punctuation and hang on a Korean word:
   * `버전~~.old~~`, a comma taken out, `값은~~.5~~`. Putting the tone back for every struck run that
   * began with punctuation after a word un-struck all of them. A tilde of tone ends a sentence: what
   * follows its punctuation is a space, and what follows the punctuation of a struck name is the name.
   */
  for (const [sentence, struck] of [
    ["버전~~.old~~ 는 없어요.", ".old"],
    ["쉼표~~,~~ 를 지워요.", ","],
    ["값은~~.5~~ 0.7이에요.", ".5"],
    ["좋아요~~!~~ 그래요.", "!"],
    // And with a face: no space after it, so it is what was struck.
    ["기분은~~😊좋음~~ 나쁨이에요.", "😊좋음"],
    ["점수는~~★★~~ 별 셋이에요.", "★★"],
  ] as const) {
    test(`what is struck may begin with punctuation right after a word: ${sentence}`, async () => {
      const reply = await drawn(sentence);
      expect(reply.struck).toEqual([struck]);
    });
  }

  test("what is struck may begin with a mark and a space, where it does not hang on a word", async () => {
    const reply = await drawn("상태: ~~✅ 완료~~ ❌ 미완료");
    expect(reply.struck).toEqual(["✅ 완료"]);
  });

  // GFM itself does not open a pair after a letter and before punctuation; only the Korean-friendly
  // rule does, next to a Korean letter. Drawn here so that nobody takes it for something this broke.
  test("after a Latin word such a pair was never strikethrough, and is not now", async () => {
    const reply = await drawn("version~~.old~~ is gone");
    expect(reply.struck).toEqual([]);
    expect(reply.words).toBe("version~~.old~~ is gone");
  });

  test("tone and a struck price in one sentence are each read as what they are", async () => {
    const reply = await drawn("네~~! 가격은 ~~만원~~ 팔천 원이에요.");
    expect(reply.struck).toEqual(["만원"]);
    expect(reply.words).toBe("네~~! 가격은 만원 팔천 원이에요.");
  });

  // What this costs: until its closing pair arrives, a real strikethrough shows its tildes.
  test("an unfinished strikethrough shows its tildes while the answer arrives", async () => {
    const reply = await drawn("가격은 ~~10,000원", true);
    expect(reply.struck).toEqual([]);
    expect(reply.words).toBe("가격은 ~~10,000원");
  });
});

const SRC = join(import.meta.dir, "../src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("every place that draws the renderer", () => {
  test("reads a tilde the same way: the transcript, tool results, the help page, the legal pages", async () => {
    const drawing: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const source = await Bun.file(path).text();
      const drawn = source.match(/<Streamdown\b/g)?.length ?? 0;
      if (drawn === 0) continue;
      drawing.push(path.slice(SRC.length + 1));
      expect({
        path,
        plugins: source.match(/plugins=\{markdownPlugins\}/g)?.length ?? 0,
        remarkPlugins:
          source.match(/remarkPlugins=\{markdownRemarkPlugins\}/g)?.length ?? 0,
        remend: source.match(/remend=\{markdownRemend\}/g)?.length ?? 0,
      }).toEqual({
        path,
        plugins: drawn,
        remarkPlugins: drawn,
        remend: drawn,
      });
    }
    expect(drawing.length).toBeGreaterThanOrEqual(4);
  });
});
