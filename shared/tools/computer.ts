/**
 * 봇의 컴퓨터 — 툴 카탈로그 하나.
 *
 * 여기 오기 전까지 같은 카탈로그가 세 벌이었다: 브라우저 등록(`computer-tools.tsx`), 무인
 * 실행(`runner/unattended.ts`), 평가(`evals/tools.ts`). 손으로 베낀 사본이므로 이미 어긋나
 * 있었다 — `computer_snapshot`의 설명이 평가와 실물이 달랐고, `computer_read_file`이 한쪽에서는
 * "between conversations", 다른 쪽에서는 "between runs"였다. 설명은 모델과 맺는 계약이므로,
 * 사본이 갈라지면 봇은 새벽 여섯 시와 정오에 다르게 행동한다.
 *
 * 세 소비자가 이 배열의 **같은 객체**를 참조한다. 거울이 아니라 동일성이다 —
 * `tests/tool-catalogue.test.ts`가 그것을 확인한다.
 *
 * 설명은 한국어다. 이 배포의 모델은 한국어로 생각하게 하는 쪽이 목표이고, 한국어 설명이
 * 툴 호출을 덜 정확하게 만드는지는 평가로 쟀다(docs/laf/eval-pack.md).
 *
 * 여기 없는 것:
 * - `computer_screenshot` — 계약 상수에만 있고 어디에도 등록된 적이 없다. 계약에서 뺐다.
 * - `report_refusal` — 스스로 "거절했다"고 감사 로그를 남기는 툴. 아무것도 막지 않으면서 턴마다
 *   150토큰을 쓰고, 거절하고 아무 말 없는 모델은 어차피 아무것도 남기지 않았다.
 */
import { SECRET_FIELDS_MAX } from "../secret-ask";
import type { JsonSchema } from "./standard-schema";

export type ComputerTool = {
  name: string;
  description: string;
  /** AG-UI와 평가가 그대로 와이어에 싣는 값. 표면은 `asStandardSchema`로 감싸서 넘긴다. */
  parameters: JsonSchema;
  /**
   * 화면 앞의 사람이 있어야만 뜻이 있는 툴인가.
   *
   * 루틴에는 사람이 없으므로 이 둘은 주어지지 않는다. 예전에는 그 사실이 `unattended.ts`의
   * 주석과 손으로 고른 목록에 있었고, 프롬프트는 그 사이에도 "막히면 computer_request_help를
   * 불러라"라고 말하고 있었다. 이제 배제도 프롬프트도 이 한 필드에서 갈린다.
   */
  needsPerson?: true;
};

const object = (
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): JsonSchema => ({ type: "object", properties, required });

const REF = {
  ref: {
    type: "string",
    description: "가장 최근 스냅샷이 준 그 요소의 ref",
  },
  snapshotId: {
    type: "number",
    description: "그 ref가 나온 snapshotId",
  },
} as const;

export const COMPUTER_TOOLS: readonly ComputerTool[] = [
  {
    name: "computer_navigate",
    description:
      "네 컴퓨터에서 웹 페이지를 연다. 보라·열어라·확인해라·들어가 봐라는 말을 들으면 이것을 부른다. 페이지 제목과 읽을 수 있는 본문이 돌아오니, 사람에게 가서 직접 보라고 하지 말고 돌아온 내용으로 답한다. 기사·블로그 글은 본문만 추려 온다(reader). 검색은 검색창에 치지 말고 검색 결과 주소를 바로 연다.",
    parameters: object(
      {
        url: { type: "string", description: "https:// 를 포함한 전체 주소" },
      },
      ["url"],
    ),
  },
  {
    name: "computer_read",
    description:
      "지금 열려 있는 페이지를 다시 읽는다. 아무것도 열지 않는다. 페이지가 바뀌었는데 결과에 page가 없었을 때, 또는 truncated로 잘린 뒷부분을 읽을 때 쓴다. 스크롤해도 읽히는 글은 같다.",
    parameters: object({
      from: {
        type: "string",
        description: "이 글자가 처음 나오는 곳부터 읽는다. 예: 네이버 가격비교",
      },
      whole: {
        type: "boolean",
        description: "본문만 추려 온(reader) 페이지를 빠짐없이 전부 읽는다",
      },
    }),
  },
  {
    name: "computer_snapshot",
    description:
      "지금 페이지에서 손댈 수 있는 것들을 나열한다: 입력칸, 버튼, 링크, 체크박스. 한 줄에 하나씩 'ref 역할 이름 = 현재 값' 모양이다. 클릭하거나 입력하기 **전에** 이것을 먼저 부르고, 돌아온 ref를 쓴다. 같이 온 snapshotId를 항상 그대로 돌려보낸다.",
    parameters: object({}),
  },
  {
    name: "computer_click",
    description:
      "페이지의 무언가를 누른다: 버튼, 링크, 체크박스, 라디오. 가장 최근 스냅샷의 ref와 그 snapshotId를 준다. 눌러서 다른 페이지로 가면 그 페이지의 제목과 본문이 page로 함께 오니 다시 읽지 않는다.",
    parameters: object(REF, ["ref", "snapshotId"]),
  },
  {
    name: "computer_type",
    description:
      "페이지의 칸에 글자를 넣는다. 가장 최근 스냅샷의 ref와 그 snapshotId를 준다. 칸에 이미 있던 값은 지워지고 새 값으로 바뀐다. submit을 true로 두면 입력 후 엔터를 누른다.",
    parameters: object(
      {
        ...REF,
        text: { type: "string", description: "넣을 글자" },
        submit: {
          type: "boolean",
          description: "칸 하나짜리 양식을 제출하려면 입력 후 엔터",
        },
      },
      ["ref", "snapshotId", "text"],
    ),
  },
  {
    name: "computer_key",
    description:
      "키를 누른다. Enter, Tab, Escape 같은 것. 특정 칸에 초점을 둔 채 누르려면 ref를 주고, 페이지 전체에 누르려면 ref를 뺀다.",
    parameters: object(
      {
        key: { type: "string", description: "키 이름. Enter, Tab, Escape 등" },
        ref: { type: "string", description: "키를 누를 대상 ref (선택)" },
        snapshotId: {
          type: "number",
          description: "그 ref가 나온 snapshotId. ref를 줬으면 필수",
        },
      },
      ["key"],
    ),
  },
  {
    name: "computer_scroll",
    description:
      "긴 페이지의 더 아래를 보려고 스크롤한다. 음수를 주면 위로 올라간다.",
    parameters: object({
      deltaY: {
        type: "number",
        description: "내릴 픽셀. 양수가 아래. 기본 600.",
      },
    }),
  },
  {
    name: "computer_switch_tab",
    description:
      "열려 있는 다른 탭으로 옮긴다. 링크를 눌렀는데 화면이 그대로면 대개 새 탭이 열린 것이다 — computer_snapshot이 함께 주는 tabs 목록에서 그 탭의 index를 보고 이것을 부른다. 옮기면 앞서 받은 ref는 모두 쓸 수 없으니 computer_snapshot을 다시 찍는다.",
    parameters: object(
      {
        index: {
          type: "number",
          description: "tabs 목록에 있는 그 탭의 index. 첫 탭이 0.",
        },
      },
      ["index"],
    ),
  },
  {
    name: "computer_upload_file",
    description:
      "네 작업 공간에 있는 파일을 페이지의 첨부 칸에 올린다. computer_snapshot으로 파일 선택 칸의 ref를 먼저 찾고, 작업 공간 기준 경로를 준다. 예: downloads/정산내역.xlsx. 네가 가진 파일을 남의 사이트로 넘기는 일이라 사람에게 확인을 받을 수 있다.",
    parameters: object(
      {
        ...REF,
        path: {
          type: "string",
          description: "작업 공간 기준 경로. 예: downloads/정산내역.xlsx",
        },
      },
      ["ref", "snapshotId", "path"],
    ),
  },
  {
    name: "computer_request_secret",
    needsPerson: true,
    /*
     * ONE CARD, SEVERAL BOXES (2026-10-10, record §6). It was one value a call: a sign-in was two
     * calls, each waiting on a person, with a look at the page in between — and "click the box
     * first" before each, which the computer has done itself since the value began to be held to
     * the judged field. The shape is read in one place (`shared/secret-ask.ts`), which still
     * reads the one `label` and `ref` this took before, for a conversation that remembers it.
     */
    description:
      "네가 알아서는 안 되는 값을 사람에게 부탁한다: 로그인 아이디, 비밀번호, 일회용 인증번호, 카드번호. 값이 들어갈 칸마다 그 칸의 ref와 무엇이 필요한지 짧은 라벨을 fields에 적는다. 아이디와 비밀번호처럼 한 화면에 함께 있는 칸은 **한 번에** 부탁한다 — 사람은 카드 하나에서 한 번에 답한다. 사람이 가려진 상자에 입력하면 값은 페이지의 그 칸으로 바로 들어가고, 이 도구도 대화도 그 값을 너에게 주지 않는다. 아이디처럼 페이지가 그 값을 다시 보여 주면 읽다가 보일 수 있다 — 그래도 대화에 옮겨 적지 않는다. 이 값을 다른 방법으로 물어서는 안 된다. 사람이 페이지에 무엇을 넣는 길은 이것 하나다. 이 사람이 그 사이트의 로그인을 저장해 두었으면 기다리지 않고 저장한 값으로 채워지고, 결과가 그렇게 말한다. 값은 칸에 **입력만** 되므로, 제출이 필요하면 computer_click으로 네가 한다.",
    parameters: object(
      {
        fields: {
          type: "array",
          minItems: 1,
          maxItems: SECRET_FIELDS_MAX,
          description:
            "값이 들어갈 칸들. 사람에게 보이는 순서대로, 칸 하나에 한 번씩만.",
          items: object(
            {
              ref: REF.ref,
              label: {
                type: "string",
                description:
                  "그 칸에 무엇이 필요한지 몇 단어로. 예: '문자로 온 인증번호'",
              },
            },
            ["ref", "label"],
          ),
        },
        snapshotId: REF.snapshotId,
        login: {
          type: "string",
          description:
            "저장된 로그인이 여럿이라는 결과를 받았을 때만: 그 결과의 logins에서 고른 것의 id. 그 밖에는 적지 않는다.",
        },
      },
      ["fields", "snapshotId"],
    ),
  },
  {
    name: "computer_request_help",
    needsPerson: true,
    description:
      "화면 밖에서 사람 손이 필요한 일을 부탁한다: 휴대폰 앱에서 로그인 승인하기, 다른 기기로 온 확인 누르기 같은 것. 사람은 네 화면을 볼 수만 있고 그 위를 누르거나 입력할 수는 없다 — 페이지 위의 일은 네가 하고, 칸에 들어갈 값은 computer_request_secret으로 받는다. 무엇을 해 달라는지 구체적으로 말한다. 사람이 '다 했어요'를 누르면 너는 같은 세션에서 이어서 한다.",
    parameters: object(
      {
        reason: {
          type: "string",
          description:
            "사람이 무엇을 해 주면 되는지 한 문장. 예: '네이버 앱에서 로그인 승인을 눌러 주세요.'",
        },
      },
      ["reason"],
    ),
  },
  {
    name: "computer_list_files",
    description:
      "네 작업 공간에 무엇이 있는지 나열한다: 저장해 둔 모든 파일과 폴더, 크기까지. 어떤 파일이 있냐는 질문을 받으면 **먼저** 이것을 부르고, 이름이 확실하지 않은 파일을 읽기 전에도 먼저 부른다.",
    parameters: object({
      path: {
        type: "string",
        description: "나열할 폴더 (선택). 비우면 작업 공간 전체.",
      },
    }),
  },
  {
    name: "computer_read_file",
    description:
      "네가 예전에 저장해 둔 파일을 읽는다. 경로는 작업 공간 기준이다. 예: notes.md, reports/august.csv. 작업 공간은 대화와 실행을 넘어 그대로 남으니, 전에 적어 둔 것을 여기서 다시 집는다.",
    parameters: object(
      {
        path: {
          type: "string",
          description: "작업 공간 기준 경로. 예: notes.md",
        },
        offset: {
          type: "number",
          description:
            "이 글자부터 읽는다 (선택, 0부터). 잘린 결과는 보인 글자 수부터 이어 읽는다.",
        },
        limit: {
          type: "number",
          description: "읽을 글자 수 (선택, 한 번에 최대 15,000)",
        },
      },
      ["path"],
    ),
  },
  {
    name: "computer_write_file",
    description:
      "나중에도 갖고 있으려고 작업 공간에 파일을 저장한다. 경로는 작업 공간 기준이고 폴더는 알아서 만들어진다. append를 true로 두면 기존 파일을 갈아치우는 대신 끝에 덧붙인다. 글자만 저장할 수 있다.",
    parameters: object(
      {
        path: {
          type: "string",
          description: "작업 공간 기준 경로. 예: reports/august.csv",
        },
        contents: { type: "string", description: "저장할 글" },
        append: {
          type: "boolean",
          description: "갈아치우지 않고 파일 끝에 덧붙인다",
        },
      },
      ["path", "contents"],
    ),
  },
];

/** 사람이 없는 실행(루틴, 방의 무인 구간)이 받는 목록. */
export const UNATTENDED_COMPUTER_TOOLS: readonly ComputerTool[] =
  COMPUTER_TOOLS.filter((tool) => tool.needsPerson !== true);

/**
 * 사람이 없는 실행이 받는 `computer_request_secret` — 이름과 인자는 같고, 답하는 것은 보관함뿐이다
 * (2026-10-10, docs/laf/redesign-2026-10.md §6의 2-6).
 *
 * 목록의 그 도구는 사람에게 부탁하는 말로 적혀 있다("사람이 가려진 상자에 입력하면…"). 루틴에는
 * 사람이 없으므로 그 설명을 그대로 주면 오지 않을 답을 기다리게 가르친다. 그래서 같은 이름에 설명만
 * 다른 하나를 둔다. 인자는 목록의 것을 그대로 쓴다 — 서버가 읽는 꼴은 하나다(`shared/secret-ask.ts`).
 *
 * `UNATTENDED_COMPUTER_TOOLS`에 넣지 않는다: 저장해 둔 로그인이 하나도 없는 사람의 루틴에는 이 도구가
 * 할 일이 없고, 도구 하나는 그 실행의 모든 턴에 실린다(CLAUDE.md "The footprint ladder"). 주는지는
 * 실행을 시작할 때 `server/src/runner/unattended.ts`가 정한다.
 */
export const UNATTENDED_SAVED_LOGIN: ComputerTool = {
  name: "computer_request_secret",
  description:
    "로그인 칸을 이 사람이 저장해 둔 로그인으로 채운다. 지금은 화면 앞에 아무도 없어서, 답하는 것은 저장해 둔 로그인뿐이다. 아이디 칸과 비밀번호 칸의 ref와 짧은 라벨을 fields에 **한 번에** 적는다. 그 사이트의 로그인이 저장돼 있으면 값은 페이지의 그 칸으로 바로 들어가고, 이 도구도 대화도 그 값을 너에게 주지 않는다. 채운 뒤 제출은 네가 누른다. 저장된 것이 없으면 채워지지 않았다는 답이 온다. 인증번호, 카드번호, 새 비밀번호의 칸은 여기서 채워지지 않는다. 이 값을 다른 방법으로 구하려 해서는 안 된다.",
  parameters:
    COMPUTER_TOOLS.find((tool) => tool.name === "computer_request_secret")
      ?.parameters ?? object({}),
};

/** 이름으로 하나. 없는 이름은 undefined — 카탈로그에 없는 툴은 실행되지도 않는다. */
export function computerTool(name: string): ComputerTool | undefined {
  return COMPUTER_TOOLS.find((tool) => tool.name === name);
}
