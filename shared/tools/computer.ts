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
      "네 컴퓨터에서 웹 페이지를 연다. 보라·열어라·확인해라·들어가 봐라는 말을 들으면 이것을 부른다. 페이지 제목과 읽을 수 있는 본문이 돌아오니, 사람에게 가서 직접 보라고 하지 말고 돌아온 내용으로 답한다.",
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
      "지금 열려 있는 페이지를 다시 읽는다. 아무것도 열지 않는다. 무언가를 누르거나 양식을 제출해서 페이지가 바뀐 뒤, 지금 무엇이 쓰여 있는지 확인할 때 쓴다.",
    parameters: object({}),
  },
  {
    name: "computer_snapshot",
    description:
      "지금 페이지에서 손댈 수 있는 것들을 나열한다: 입력칸, 버튼, 링크, 체크박스. 각각 ref(e1 같은 것)와 라벨과 현재 값이 함께 온다. 클릭하거나 입력하기 **전에** 이것을 먼저 부르고, 돌아온 ref를 쓴다. 같이 온 snapshotId를 항상 그대로 돌려보낸다.",
    parameters: object({}),
  },
  {
    name: "computer_click",
    description:
      "페이지의 무언가를 누른다: 버튼, 링크, 체크박스, 라디오. 가장 최근 스냅샷의 ref와 그 snapshotId를 준다.",
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
    description:
      "네가 알아서는 안 되는 값 **하나**를 사람에게 부탁한다: 비밀번호, 일회용 인증번호, 카드번호. 먼저 computer_click으로 그 칸에 초점을 두고, 그 칸의 ref와 무엇이 필요한지 짧은 라벨을 붙여 부른다. 사람이 가려진 상자에 입력하면 값은 페이지로 바로 들어가고 너는 끝내 보지 못한다. 이 값을 다른 방법으로 물어서는 안 된다. 칸 하나면 되는 일에는 전체 인계보다 이쪽을 쓴다. 값은 칸에 **입력만** 되므로, 제출이 필요하면 computer_click으로 네가 한다.",
    parameters: object(
      {
        label: {
          type: "string",
          description: "무엇이 필요한지 몇 단어로. 예: '문자로 온 인증번호'",
        },
        ...REF,
      },
      ["label", "ref", "snapshotId"],
    ),
  },
  {
    name: "computer_request_help",
    needsPerson: true,
    description:
      "네가 할 수 없는 일을 사람에게 부탁해서 컴퓨터를 직접 잡게 한다: 로그인, 비밀번호나 인증번호 입력, 캡차 통과. 무엇을 해 달라는지 구체적으로 말한다. 사람이 브라우저를 직접 몰고 다시 돌려주면 너는 같은 세션에서 이어서 한다. 포기하는 대신, 그리고 비밀번호를 불러 달라고 하는 대신 이것을 쓴다.",
    parameters: object(
      {
        reason: {
          type: "string",
          description:
            "사람이 무엇을 해 주면 되는지 한 문장. 예: '이 페이지가 휴대폰으로 온 인증번호를 묻고 있습니다.'",
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

/** 이름으로 하나. 없는 이름은 undefined — 카탈로그에 없는 툴은 실행되지도 않는다. */
export function computerTool(name: string): ComputerTool | undefined {
  return COMPUTER_TOOLS.find((tool) => tool.name === name);
}
