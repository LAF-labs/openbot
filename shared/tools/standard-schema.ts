/**
 * 하나의 JSON 스키마를, 표면의 등록 훅이 받아들이는 얼굴로 감싼다.
 *
 * 카탈로그는 JSON 스키마로 산다. 무인 실행(`runner/unattended.ts`)과 평가는 AG-UI의
 * `Tool.parameters`로 그대로 넘기고, 그 값은 와이어에 JSON으로 실린다 — 그래서 스키마 객체에
 * 여분의 필드가 붙어 있으면 모델이 그 쓰레기를 같이 읽는다.
 *
 * 브라우저 쪽 `useFrontendTool`은 Standard Schema를 받는다. CopilotKit이 그것으로 하는 일은
 * 딱 하나, JSON 스키마로 되돌리는 것뿐이다(`@copilotkit/shared`의 `schemaToJsonSchema`: 먼저
 * `~standard.jsonSchema`, 없으면 `toJSONSchema()`, 없으면 zod 변환기 — 확인함). 검증에는 쓰지
 * 않는다(`validate` 호출 지점 없음, 확인함). 그러니 여기서 필요한 것은 `toJSONSchema()`를 가진
 * 얇은 껍데기 하나이고, 원본 스키마는 손대지 않은 채로 남는다.
 *
 * 이 껍데기는 등록할 때만 씌운다. 카탈로그가 들고 있는 것은 언제나 순수한 JSON 스키마다.
 */

/** 툴 인자의 JSON 스키마. `{ type: "object", properties, required? }`. */
export type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: readonly string[];
};

/**
 * Standard Schema V1의 최소 구현.
 *
 * `validate`는 값을 그대로 통과시킨다. 인자의 진짜 검사는 핸들러와 서버가 하고 — 게이트웨이가
 * ref를, 라우트가 프로필과 루틴을 거절한다 — 여기서 한 번 더 거르면 거절이 두 곳에서 나서
 * 어느 쪽이 답했는지 알 수 없게 된다.
 */
export type StandardSchemaFace<T> = {
  "~standard": {
    version: 1;
    vendor: "laf";
    validate: (value: unknown) => { value: T };
    types?: { input: T; output: T };
  };
  toJSONSchema: () => JsonSchema;
};

export function asStandardSchema<T = Record<string, unknown>>(
  schema: JsonSchema,
): StandardSchemaFace<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "laf",
      validate: (value: unknown) => ({ value: value as T }),
    },
    toJSONSchema: () => schema,
  };
}
