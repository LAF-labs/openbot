# LAF MCP 계약 v0.1

LAF 봇 플랫폼에 자사 서비스를 연결하려는 **고객사 개발자**를 위한 계약서다.
구현·호스팅·코드 리뷰의 책임은 고객사에 있고, 플랫폼은 이 계약만 안다 —
플랫폼 코드에는 어떤 고객사의 개념도 들어가지 않으며, 그래서 여기 적힌 것이
계약의 전부다.

## 0. 한 장 요약

- 원격 **MCP 서버**(Streamable HTTP) 하나를 자사 인프라에 띄운다.
- 표준 툴 **`laf.watch` 하나는 필수**, 나머지 툴은 자유.
- 모든 툴은 **표준 어노테이션**으로 위험도를 선언한다. 선언하지 않은 툴은
  등록 시 **최고 위험(destructive)으로 취급**된다.
- 제출 전 검사기를 통과해야 한다 — 템플릿 저장소에 동봉:
  [LAF-labs/laf-mcp-template](https://github.com/LAF-labs/laf-mcp-template).

## 1. `laf.watch` — 표준 툴

입력 없음. 출력은 텍스트 콘텐츠 하나로, JSON:

```jsonc
{ "signals": [
  { "key": "queue.orders",      // 필수. 서비스가 정하는 이름 공간
    "status": "ok",             // 필수. "ok" | "warn" | "fail"
    "value": 12,                // 선택. 숫자 또는 문자열
    "since": "2026-08-20T02:00:00Z",  // 선택. 상태 시작 시각
    "detail": "..." }           // 선택. 사람이 읽을 한 줄
]}
```

한도: 신호 **64개**, 문자열 필드 **500자**. 넘치는 것은 플랫폼이 잘라서
읽는다. 키가 중복되면 첫 것만 남는다.

### 1.1 상태 의미론 — 판정은 서버의 몫이다

플랫폼은 신호의 **의미를 모른다.** 이전 폴과 비교해 세 가지만 뉴스로
취급한다: 신호의 **출현, 소멸, status 전이.** 같은 status 안에서 값이
흔들리는 것(47 → 52)은 뉴스가 아니다. 따라서 "몇 개부터 warn인가" 같은
문턱 판정은 반드시 **서버 쪽에서** 끝내서 status로 내보내야 한다.

### 1.2 실패 규약 — 백엔드가 죽어도 서버는 답한다

DB·업스트림이 죽었을 때 프로토콜 에러를 내지 말고 **신호로 답하라**:

```json
{ "signals": [ { "key": "db.reachable", "status": "fail", "detail": "connect timeout" } ] }
```

플랫폼은 "MCP 서버 자체의 침묵"과 "백엔드 장애"를 구별해야 하고, 그 구별은
이 규약이 있어야만 가능하다.

## 2. 자유 툴 — 어노테이션이 위험도다

툴마다 MCP 표준 어노테이션을 선언한다. 플랫폼의 승인 정책은 이 선언에서
컴파일된다:

| 선언 | 플랫폼 처리 |
|---|---|
| `readOnlyHint: true` | 상시 스코프에서 무승인 실행 가능 |
| 쓰기 + `destructiveHint: false` | 스코프 안이면 무승인, 밖이면 푸시 승인 |
| `destructiveHint: true` | 사람의 푸시 승인 필수 |
| `x-laf/effect: "external"` 또는 `"money"` | **사전 승인 불가.** 발신·결제·게시·삭제 — 매번 사람이 |
| `idempotentHint: true` | 실패 시 자동 재시도 허용 |
| (어노테이션 없음) | **destructive 취급** — 모든 호출에 승인 |

`laf.watch`는 반드시 `readOnlyHint: true`여야 한다.

등록 후 **툴 정의가 바뀌면**(이름·스키마·어노테이션) 플랫폼은 해당 툴을
자동 정지하고 재동의를 요구한다. 어노테이션을 조용히 낮추는 것은 권한 상승
공격으로 취급된다.

## 3. 운영 한도

| 항목 | 값 |
|---|---|
| 전송 | Streamable HTTP, 요청당 세션(무상태 권장) |
| 인증 | Bearer 토큰 (등록 시 입력) |
| 접속 한도 | 15초 |
| 호출 한도 | 60초 — `laf.watch`는 **5초 안에** 답하는 것을 권장 |
| 결과 크기 | **20,000자에서 잘린다.** 잘리면 JSON이 깨지므로 그 전에 작게 |
| 폴링 주기 | 등록 시 지정(최소 10초) — 읽기 쿼리는 인덱스를 탈 것 |

## 4. 제출 전 체크

```bash
bun laf-mcp-check.ts https://your-host/mcp [--token <bearer>]
```

등록 화면이 하는 검사와 같다: 핸드셰이크 → 툴 목록 → `laf.watch` 존재와
어노테이션 → 실호출 → 신호 스키마 → 크기·지연. exit 0이면 등록 가능.
(검사기 원본은 이 저장소의 `server/scripts/laf-mcp-check.ts`이고,
`server/tests/mcp-check-mirror.test.ts`가 이 문서 §1의 한도와 어긋나지 않게
붙들고 있다.)

시작점: [LAF-labs/laf-mcp-template](https://github.com/LAF-labs/laf-mcp-template) —
계약 전 요소를 시연하는 실행 가능한 최소 서버 + 검사기 + CI.
**Use this template**로 자사 레포를 만들고 `collectSignals()`만 채우면 된다.
