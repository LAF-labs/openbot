# 비판적 검토와 개선 설계 — 2026-09

작성: 2026-09-02. 대상: `main` `4ef8c4c` (v0.3.2). 코드 수정 없음 — 이 문서는 설계다.

지난 3주(2026-08-14 ~ 09-01, 187 커밋)에 만들어진 모든 것을 목표 하나에 비춰 다시
본다. **목표: xAI Grok Bot과 같은 서비스를, 한국의 자영업자와 중소기업에 맞춰.**
문서와 코드가 전부 AI의 손으로 빠르게 쌓였으므로, 이 검토는 "잘 됐다"를 찾지 않고
**어디가 약속과 다른가, 무엇이 남아서 짐이 되는가, 무엇을 어떤 순서로 고치는가**만
찾는다.

근거 표기: **[확인]** = 코드를 직접 읽어 증명한 것. **[추정]** = 코드에서 추론했으나
실행으로 재지 않은 것. 파일 경로는 저장소 루트 기준이다.

> **결정 2026-09-02 (김기범).** §7의 권고를 그대로 채택한다. 외부 연결이 필요한 것
> (알림톡 신청, 코드 서명 인증서 구매, 국내 추론 전환)은 **뒤로 미룬다.** 모바일은 이
> 프로젝트의 범위에서 **제외**한다 — 전용 앱을 나중에 따로 만든다. 따라서 §5.6(c)의
> 폰 레이아웃, §5.7의 웹 푸시·`/approve/:id` 모바일 착지, 44px 터치 목표는 이 계획에서
> 빠지고, PC 셸(트레이·알림·딥링크)과 웹은 남는다. 실제 작업은 단계 순서대로 진행하며,
> 통합 브랜치 `laf/redesign` 위에서 한다.
>
> **후기 2026-09-03 (김기범).** 이 문서 곳곳에 실배포로 등장하는 `sajuhook.com`은
> 폐기했다(VM 회수). 이제 모든 배포는 `<name>.agent.laf-co.com` 하나의 와일드카드
> 아래에 있고, 사람은 진입점 `https://agent.laf-co.com`에서 로그인해 자기 배포로 간다 —
> 셸 하나가 함대 전체를 연다. 아래 본문은 그날의 검토 기록이므로 그대로 둔다.
>
> **후기 2026-09-04 (김기범).** 외부 연결의 모양을 정했다. 사업장마다 키를 받게 하지
> 않는다 — 우리는 서비스를 제공할 뿐이다. 한 번의 OAuth로 되는 것(구글 시트·지메일·
> 캘린더·비즈니스 프로필, 카페24)은 함대의 앱 하나가 릴레이(`auth.agent.laf-co.com`)를
> 거쳐 모든 VM에 닿는 **원클릭 연결**로, 사업장이 저마다의 것을 등록해야 하는 것(카카오
> 알림톡, 세금계산서)은 LAF가 벤더의 고객이 되고 사업장은 우리 화면에서 그 아래 등록하는
> **파트너 연결**로, 그 밖에 사업장마다 키를 발급받아야만 되는 곳(네이버 스마트스토어·
> 플레이스, 배달앱, 쿠팡 등)은 봇 브라우저에 한 번 로그인해 두는 **사이트 연결**로 한다.
> 플랫폼 키는 `~/laf/secrets/`의 양식 하나에만 적고 `laf env push`로 함대에 심는다.
> 세금계산서(팝빌)는 2026-09-05 삭제 — 파트너 연결은 알림톡 하나로 시작한다.

---

## 0. 한 장 요약

**판정.** 뼈대는 맞다 — 1인 1VM, 빈 봇, 게이트웨이가 모든 행동을 판정·기록, 한국어
게이트, 모델 교체 의식. Grok Bot이 욕먹는 세 지점(가격, 모델 봉인, 봇 간 경계 없음)의
반대편에 서 있다는 사업 문서의 판단도 코드가 뒷받침한다.

그러나 **제품이 하는 약속 셋이 오늘 코드에서 성립하지 않는다.**

1. **"위험한 행동 앞에서 멈춘다"** — 기본 정책이 `allow: ["true"]`, `ask: []`다. 관리자가
   규칙을 쓰기 전까지 브라우저 행동은 아무것도 묻지 않는다. 그리고 "묻지 마" 자동
   리뷰는 기본 모델(추론 모델)에서 토큰 상한 200 때문에 **한 번도 판정을 내지 못한다.**
2. **"한국어 우선"** — 표면 문자열은 한국어지만, 봇이 읽는 시스템 프롬프트는 업스트림
   영어 원문 그대로(한글 0자, 8/16 이후 무변경)이고, 오늘 날짜도 시간대도 모른다.
   승인 질문과 거절 사유는 서버가 영어 문장으로 만들어 화면에 그대로 나간다.
3. **"PC 앱 → 모바일"** — 앱에 폰 레이아웃이 없다(전체 셸에 브레이크포인트 1개).
   승인·거절 버튼이 28px이고, 딥링크가 없어 알림을 눌러도 그 방으로 가지 못하며,
   대화 ID가 기기별 localStorage에 있어 PC와 폰이 다른 대화를 본다.

그 아래에 **업스트림의 유령**이 있다. 아무도 읽지 않는 지식 플레인 6개 테이블과
pgvector, 돌지 않는 Intelligence 모드의 설정·분기·주석, 빈 목록을 동기화하는
테넌트 패키지, 저장만 하고 아무도 읽지 않는 Drive 서비스 계정 키, 그리고 결정
기록("단일 프로세스, in-process가 옳다")과 정반대로 "여러 서버 뒤의 로드밸런서"를
이유로 대는 DB 기반 승인·반복·LISTEN/NOTIFY 배선.

**개선의 축은 여섯이다.** §4에 원칙, §5에 설계, §6에 순서.

| 축 | 한 줄 |
|---|---|
| 경계 v2 | 기본 `ask` 목록을 출하하고, 질문을 사실(구조)로 보내 표면이 한국어로 말하게 하며, 브라우저와 MCP가 같은 정산 절차를 쓴다 |
| 봇 두뇌 v2 | LAF의 프롬프트(한국어·날짜·시간대·모드별 조립), 툴 카탈로그 하나, 컨텍스트 예산 |
| 브라우저 현실화 | ko-KR·Asia/Seoul, 새 탭·다이얼로그·다운로드·업로드, 렌더된 본문, 자원 상한 |
| 서버 감량 | 죽은 플레인 삭제, 결정 기록대로 배선, 2,581줄 클로저 분할, 라우틴 소유권, 좌석 잠금 |
| 표면 분리 | 사장님 표면과 운영자 표면을 가르고, 폰에서 성립하는 레이아웃과 알림 경로 |
| 게이트 정직화 | 워크스페이스별 플로어, 죽은 스위트 삭제, 테스트 DB 격리, 컴퓨터 라우트 테스트 |

---

## 1. 목표 재확인 — Grok Bot 대조

Grok Bot(2026-08-11 베타, Anysphere 제작·xAI 브랜드)의 공식 문서(docs.x.ai/grok-bot,
2026-09-02 열람)와 우리 코드를 나란히 놓는다. "같은 서비스"의 기준선이다.

| 항목 | Grok Bot | LAF Agent (오늘) | 판정 |
|---|---|---|---|
| 컴퓨터 | 계정당 클라우드 VM 1대, 봇 전부 공유, 봇당 화면 1개 | 1인 1VM, 봇 5개가 컴퓨터 1대 공유, 봇당 Chromium 프로필 | 동형 |
| 봇 수 | 명시 제한 없음(커뮤니티 50) | 5 (`BOT_SEATS_PER_ACCOUNT`) | 우리가 좁음. 자영업자에겐 충분하나 "직원 봇 여럿" 시나리오에서 벽 |
| 봇 생성 | 템플릿 8종("Meet a future teammate") 또는 빈 봇(이름·직무·설명) | 빈 봇 + 32개 직무 제안 카드 | 동형. 우리 제안이 SMB 어휘(영수증·미수금·재고)라 더 맞음 |
| 스킬 | 재사용 지시문, `/`로 호출, "Teach a task" 10분 녹화 → 초안 | 시연 녹화 → 절차 write-up → `/` 호출. 입력값 미기록 | 동형. 우리 녹화 규율(값 미기록·테스트)이 더 엄격 |
| 루틴 | 봇당 50, 기록 20건, 스케줄 + 이벤트 트리거, 타임존 | 계정당 20, 스케줄 + 웹훅 토큰 트리거, Asia/Seoul 클럭 | 동형. 재시작 후 놓친 창 처리 없음(§3.4) |
| 그룹 | 봇 여럿의 그룹 채팅, 봇 간 작업 인계 | 룸 + `ask_coworker` + 핸드오프 기록 | 동형. 루틴·룸에서는 `ask_coworker` 불가 |
| 승인 | Allow once / Deny / Always allow, Auto-review 규칙 2종(Require 승), 비밀번호·2FA·CAPTCHA·결제는 핸드오프 | 동일 3버튼 + 범위 지정 상시 허용 + "묻지 마" 문장 + `settleWithoutAsking` | 설계는 우리가 더 정교. **그러나 기본값이 아무것도 묻지 않고, 자동 리뷰가 죽어 있음**(§3.1) |
| 커넥터 | Gmail·Calendar·Drive·OneDrive·Outlook·Teams·SharePoint·Salesforce + MCP | Notion·Drive(읽기) + 커스텀 MCP 계약 | Grok은 미국 오피스 스택. **우리 시장의 스택(네이버·카카오·배민·홈택스·은행)은 어느 쪽에도 API가 없다** → 브라우저 신뢰성이 전부(§3.3) |
| 알림 | OS 알림 + iPhone 푸시, "끝났거나 입력이 필요할 때" | Tauri OS 알림(권한 버튼이 셸에서 안 그려짐), 웹훅. 알림톡 자리만 | **격차.** 사장님이 폰에서 승인할 길이 없음(§5.7) |
| 플랫폼 | macOS·Windows + iOS. 웹·Android 없음 | Tauri(macOS·Windows) + 웹. 모바일 셸 코드 0 | 웹이 있는 게 우리 이점이나 폰 레이아웃이 없어 이점이 안 됨 |
| 컴퓨터 관리 | Update(내구 상태 보존 재구축) / Reset(최후) | `/computers/reset`이 일반 사용자에게 열려 있음 | 우리 쪽 위험 |
| 모델 | xAI 봉인, 기본 모델 설정 항목 존재 | 배포가 서빙, effort 3단, 교체 의식 | 우리 강점 |
| 감사 | "coming soon" | 모든 행동 감사 행, 관리 화면 | 우리 강점. 단 페이지네이션 없음 |
| 가격 | $200/월 단독, 번들 다수 | 미정. VM 원가에 하한이 묶임 | §2-7 |
| 언어 | 한국어 없음 | 한국어 게이트 | 우리 강점 — 표면에 한해서(§3.2) |

**결론.** 기능 목록으로는 이미 동형이고 세 지점(경계 설계, 모델 교체, 한국어 표면)은
앞선다. 뒤처진 곳은 기능이 아니라 **기본값·언어·단말**이다. 기능을 더 얹는 것보다
있는 것을 약속대로 만드는 것이 이번 설계의 전부다.

---

## 2. 사업 문서와 코드의 괴리

`~/laf/docs`의 결정과 오늘 코드가 어긋난 자리. 결정을 바꾸자는 것이 아니라, 어긋남을
문서 한 줄로 못 박아 두자는 것이다.

| # | 문서의 약속 | 코드·운영의 현실 | 처리 |
|---|---|---|---|
| 1 | plan-saas §1.2: 프로덕션 추론은 **국내 처리 경로 필수**, 공식 API는 개발·테스트·데모 전용, 실고객 데이터 투입 금지 | 함대는 서울로 이전 완료(저장은 국내). 추론은 OpenRouter(미국) 경유 glm-5.3-flash. sajuhook.com이 실배포 | "국내 리전" 판매 문장은 저장에만 참. 전환 트리거(유료 첫 고객 이전)를 §7에 결정 항목으로 |
| 2 | plan-saas §1.4: 사장님은 폰에 있다 → 알림톡 + 모바일 승인 | PC 우선으로 뒤집힘(2026-08-25). 알림톡 어댑터는 자리만(`watch/notify.ts` 웹훅). 승인 단말 없음 | PC 우선은 존중. 그러나 **승인 알림 경로**는 순서와 무관하게 필요 — §5.7 |
| 3 | plan-saas §4: 출하 단위는 **업무 패턴 8종**(당직·감시 / 승인 보조 / 정산·대조 / 문의 응대 / 예약·일정 / 재고·발주 / 리뷰·평판 / 증빙·서류) | 32개 직무 제안이 8개 범주(money, customers, …)로 있음 — 비슷하나 문서의 패턴과 1:1이 아님. 패턴 × 연결 매트릭스는 표면에 없음 | 제안 표를 문서의 8패턴으로 재편(§5.6) |
| 4 | M0의 증거: `laf.watch` 워처 + 다이제스트(kreview) | 코드에 남아 있고(`server/src/watch`) 앱에서 도달 불가, 깨우기는 인증된 배포에서 실패(§3.4) | Tier A 로드맵이 살아 있는가에 따라 유지/격리/삭제 — §7 결정 |
| 5 | CLAUDE.md: PC 앱 → 모바일 → 웹 | 모바일 셸 코드 0, 앱에 폰 레이아웃 0 | §5.6 |
| 6 | Tier A(커스텀 MCP 업체)와 Tier B(무코드 자영업자)가 같은 제품 | 관리 화면(MCP 등록·워치 소스·컴포넌트 플레이그라운드·자격증명)이 Tier A용이고 자영업자에겐 소음 | 표면 분리 — §5.6 |
| 7 | 원가: 1인 1VM. 하이버네이션은 R&D | 서울 A1 1/6GB ≈ ₩2.1만/월이 봇 5개 + Chromium 5개의 바닥. 자원 상한 없음 | 결정 존중. 재검토 트리거를 §7에 |

---

## 3. 발견

### 3.1 제품의 약속과 경계

**기본 정책이 아무것도 묻지 않는다 [확인].** `server/src/computer/policy-store.ts:36-41`
`DEFAULT_ACTION_POLICY = { mode: "enforce", deny: [], ask: [], allow: ["true"] }`. 주석은
"볼 수만 있고 만지지 못하는 봇은 제품이 아니다"라고 이유를 댄다 — 맞는 말이다. 그러나
그 반대편, "묻지 않고 결제 버튼을 누르는 봇"도 제품이 아니다. README의 "take the
wheel when it reaches something it should not do alone"은 오늘 관리자가
`/admin/boundaries`에서 규칙을 쓴 뒤에만 참이다. Grok Bot은 발신·결제·삭제·권한
변경을 문서상 기본 정지 대상으로 둔다.

MCP 툴 경로는 다르다: 가드 플로어(money / external / destructive / 무선언)는 정책이
allow여도 매 호출 묻는다(`plugins/store.ts:3024-3044`). 즉 **Notion에 쓰는 것은 묻고,
브라우저로 송금 버튼을 누르는 것은 안 묻는다.** 자영업자의 위험은 후자에 있다.

**자동 리뷰가 기본 모델에서 판정을 못 낸다 [확인].** `auto-review.ts:130` `maxTokens: 200`.
`model-call.ts:46-58`이 스스로 기록한 함정("추론 모델은 예산을 생각에 쓰고 빈 답을
낸다") 그대로다. `review_model` 미설정 시 기본 모델(glm-5.3-flash, `supports_effort:
true`)로 떨어지고, 빈 답 → `unreadable` → `allowed:false` → 조용히 사람에게 묻는다.
"Do not ask me about…" 문장은 저장되고 그려지지만 작동하지 않는다. CLAUDE.md가 금지한
"저장하고 아무것도 안 하는 컨트롤" 그 자체다. `REVIEW_MODEL`은 `.env.example`에도
docs에도 없다.

**게이트웨이가 둘이다 [확인].** `gateway.ts:404-519`의 정산 절차(지문 → 제시된 승인
소비 → 상시 허용 → 자동 리뷰 → 질문 열기)를 `plugins/store.ts:1512-1585`가 손으로
다시 쓴다. 자동 리뷰 없이, `repeat: {count: 1}`을 박은 채(`store.ts:2999`). 같은
`settleWithoutAsking`을 두 곳이 각자 읽는다(`gateway.ts:441`, `store.ts:1547`). 한쪽을
고치면 다른 쪽이 어긋난다.

**질문과 거절이 영어 문장이다 [확인].** `policy.ts:412-433` `describeAsk`가 영어로
질문을 조립하고, `PresentedApproval`(`approvals.ts:125-136`)은 구조(의도·요소·호스트)를
싣지 않는다. 표면은 `approval-request.tsx:92`, `admin/boundaries.tsx:588`에서 그 문장을
그대로 그린다. MCP 가드 질문은 한국어(`laf-contract.ts:36-46`)라 **같은 필드가
이중 언어**다. 거절 사유 `outcome.reason`도 모델에 영어로 돌아간다. 서버 산문이
표면에 닿는 자리를 세어 보면 computer 26곳, agents·routines·rooms 11곳, plugins 10곳,
auth·channels·components 10곳이다(하위 보고 원문).

**사람의 No가 붙지 않는다 [추정].** `consume`은 `declined`를 돌려주고 행을 남기며
(`approvals.ts:337, 473`), 게이트웨이는 새 질문을 연다(`gateway.ts:484-517`). 봇은
같은 행동을 다시 물을 수 있고, 상한은 `repeat.count` 규칙뿐이다 — 그 규칙은 기본
정책에 없다.

**그 밖에 [확인].**
- `POST /:botId/computers/reset` — "가장 파괴적인 버튼"(`gateway.ts:710`)이
  `requireUser`만 걸려 있다(`computer/routes.ts:253`).
- `settleWithoutAsking`과 `dry-run`은 어디에도 그려지지 않는다. `PUT /api/computer/policy`
  JSON으로만 켠다. `dry-run`은 matched `deny`를 기록하고도 행동을 실행한다
  (`policy.ts:354,375,399`, `gateway.ts:1139`) — 의도된 것이나 두 번째 스위치다.
- `POST /:botId/human/:kind`가 검증된 `kind` 뒤에 본문을 스프레드해(`routes.ts:417-420`)
  본문의 `kind:"secret"`이 감사 없는 `humanInput` 경로로 재라우팅될 수 있다 [추정].
- `demonstration.ts:242-257` `opened()`는 호출자가 없어 시연 중 페이지 이동이 기록되지
  않는데, `write-up.ts`와 그 테스트는 기록된다고 가정한다.
- `/describe-point`가 클릭된 요소의 `innerText` 80자를 기록에 넣는다
  (`agent-computer/src/index.ts:882-889`) — 화면에 표시된 OTP·계좌·잔액이 들어갈 수
  있고, 비밀번호 테스트 같은 직렬화 테스트가 이 경로엔 없다 [추정].

지켜진 것도 적어 둔다: `update_state`는 `autoReview`에 닿지 못한다(`agents/routes.ts:
463-486`, 테스트 `agent-routes.test.ts:747-765`). 시연 녹화는 값을 읽지 않고
(`demonstration.ts:165-171`), 전체 직렬화 후 비밀번호 부재를 단언하는 테스트가 있다
(`demonstration.test.ts:36-49`). `deny`는 상시 허용·자동 리뷰 어느 쪽으로도 완화되지
않는다(`computer-gateway.test.ts:731, 1104, 1300`).

### 3.2 봇의 두뇌 — 프롬프트, 툴, 모델 호출

**시스템 프롬프트는 업스트림 영어 원문이다 [확인].** `shared/bot-prompt.ts`는 커밋
`f238ce9`(2026-08-16, 업스트림 임포트) 이후 무변경. 한글 0자. "사람의 언어로 답하라"는
지시가 없고, 오늘 날짜·시간대(Asia/Seoul)도 어디에도 없다(`grep` 확인). 평가의
한국어 산수 시나리오는 사용자 메시지에 "오늘이 2026년 8월 25일"을 넣어 이 구멍을
가린다. 새벽 6시 루틴 "오늘 주문 확인"은 오늘이 언제인지 모른다. `.join(" ")`(`:56`)이
빈 문자열 구분자를 접어 **3,089자 한 문단**으로 보낸다.

**모순과 사건 패치 [확인].**
- `bot-prompt.ts:55` "plain language로 말하라" ↔ 룸 프롬프트 "plain text는 보이지
  않는다"(`rooms/prompt.ts:218-225`가 스스로 시인).
- `bot-prompt.ts:40-42` "`computer_request_help`를 불러라" ↔ 루틴은 그 툴을 뺀다
  (`unattended.ts:17-19`).
- "파일명을 절대 추측하지 마라" 4문장 블록이 세 벌(`bot-prompt.ts:34-38`,
  `computer-tools.tsx:693-695`, `unattended.ts:586-588`).
- remember/update_state 경계 ~1,500자는 2026-09-01 오후 평가 세 번(05:37 FAIL → 05:43
  FAIL → 05:48 PASS) 사이에 다듬어져 같은 커밋(`4ef8c4c`)에 들어갔다. n=3으로 90%와
  99%를 가를 수 없다.
- 코드가 이미 강제하는 규칙이 산문으로도 있다: ref/snapshotId 위조(`StaleSnapshotError`),
  일정 없는 루틴 생성(`self-tools.tsx:87-93`이 거절).

**툴 카탈로그가 세 벌이다 [확인].** 브라우저(`app/src/lib/copilot/computer-tools.tsx`),
서버 무인 실행(`runner/unattended.ts:479-641`), 평가(`evals/tools.ts`). 이미 어긋났다:
`computer_snapshot` 설명이 평가와 실물이 다르고, `computer_read_file`이 "between
conversations"/"between runs"로 갈린다. `schema.ts:19-66`의 `COMPUTER_TOOLS` 상수는
아무도 import하지 않으며 게이트웨이는 이름을 메서드마다 하드코딩한다.
`computer_screenshot`은 계약에만 있고 어디에도 등록되지 않는다.

**한 사실이 살 수 있는 곳이 넷이다.** `remember`(memories), `update_state.description`
(profile), 워크스페이스 파일("나중에 쓸 메모를 저장하라", `bot-prompt.ts:30-32`),
스킬. 어디에 둘지를 모델이 산문으로 고른다. `update_state`는 옵션 9개 + 모드 enum
하나이고 유효성 규칙은 핸들러에서 영어 문자열로 돌아온다(`self-tools.tsx:88-92`).

**agent-bot [확인].** `finish_reason: "length"`를 보지 않아 잘린 답이 완료로 전달된다.
빈 완료(추론이 예산을 다 씀)는 빈 턴으로 끝나 룸에서는 "정당한 침묵"으로 읽힌다.
요청 타임아웃·`max_tokens`·컨텍스트 정리가 없다: 모든 메시지를 그대로 전달하고
`computer_navigate`/`computer_read` 결과가 각 6,000자(`agent-computer/src/index.ts:96`)
라 열 걸음 탐색이면 4~6만 토큰의 한국어 페이지 본문이 정리 없이 앞에 선다. 기본 모델명이
세 곳에서 `gpt-5.5`(`agent-bot/src/index.ts:28`, `evals/run.ts:23`,
`docker-compose.yml:196`)이고 `tenant/laf/model.yaml:4`는 `gpt-4.1`이다. 봇 ID는
agent-bot에 닿지 않는다 — 봇의 정체성은 미들웨어가 주입하는 역할 메시지뿐이다.

**고정 오버헤드.** 시스템 메시지 2개(~1,000~1,500 토큰) + 툴 스키마 17개 이상
(~3,500+, 플러그인·갤러리 별도) ≈ **첫 사용자 단어 전에 4.5~5k 토큰**. 평가 보고서의
1.6~3.4k는 툴 3~6개에 역할 메시지 없이 잰 숫자다.

**모델 호출은 두 구현 + 죽은 하나.** agent-bot(SDK 스트리밍, 타임아웃 없음),
`askModel`(자동 리뷰·write-up, 20/60초), CopilotKit `BuiltInAgent`(`copilot.ts:277-316`,
`agents: []`라 도달 불가). 429는 `laf:model_rate_limited` 사실 코드로 표면에 닿아
한국어가 된다 — 이 패턴이 옳고, 나머지도 이렇게 가야 한다.

### 3.3 봇의 브라우저 — 한국 사이트에서 무엇이 깨지는가

`agent-computer`는 Playwright `launchPersistentContext`를 봇당 하나 띄운다
(`profiles.ts:161-171`). 아래는 네이버·카카오·홈택스·스마트스토어·배민 같은 실제
대상에 대한 판단이다. 실행으로 잰 것이 아니라 코드에서 읽은 것이다.

| 무엇 | 코드 | 결과 |
|---|---|---|
| 페이지 본문 | `readablePageText`가 `<body>`를 **복제한 뒤** `innerText`를 읽음(`index.ts:190-197`) [확인] | 분리된 노드의 `innerText`는 `textContent`와 같다 — 숨은 메가메뉴·모달·`display:none`이 6,000자 예산을 먹고 줄바꿈이 사라진다. 네이버 포털에서 예산은 내비게이션에 쓰인다 |
| 로드 대기 | `goto` 후 `domcontentloaded`에서 즉시 읽음(`:655-663`) [확인] | SPA 셸(스마트스토어·홈택스)은 골격만 돌아온다 |
| iframe | `evaluate`는 메인 프레임만 [확인]; ariaSnapshot의 iframe 하강은 주석의 주장(`:211`) [추정] | 결제창·인증창·홈택스 본문이 안 보인다 |
| 새 탭 | `context.on("page"/"popup")` 없음 [확인] | 네이버의 `target=_blank`가 봇도 스크린캐스트도 못 보는 탭을 연다 |
| 다이얼로그 | `page.on("dialog")` 없음 [확인] | `alert("로그인이 필요합니다")`를 Playwright가 자동 닫고 봇은 이유를 모른다 |
| 파일 | `acceptDownloads`·`setInputFiles` 없음 [확인] | 세금계산서 PDF 다운로드도 상품 이미지 업로드도 못 한다 |
| 로케일·시간대·UA | 없음 [확인] | 영어/UTC로 렌더. `--no-sandbox` 헤드리스 지문 → 새 기기 2FA·CAPTCHA 루프 [추정] |
| 한글 입력 | 봇은 `fill()`(`:1100`) — 조합 이벤트 없음. 사람 인계 시 CDP `dispatchKeyEvent`(`screencast.ts:186-206`)이고 표면에 조합 처리 없음 [확인] | 보안키패드 계열 실패 [추정]; 인계 중 한글이 자모로 쪼개질 위험 |
| 공동인증서 | — | 구조적으로 불가. 문서에 "안 되는 것"으로 적어야 한다 |
| 재시작 | 만료 쿠키는 볼륨·SIGTERM flush로 생존, 세션 쿠키·**제어 상태·대기 중 비밀 요청**은 소실(`profiles.ts:15-17`, `control.ts`) [확인] | 인계 중 재시작이면 사람이 조용히 핸들을 잃고 봇이 움직일 수 있다 |
| 자원 상한 | compose에 `mem_limit`/`cpus`/`shm_size` 없음 [확인] | Chromium 5개, 1/6GB VM → OOM |
| 봇 헤더 | 컴퓨터는 `"shared"`로, 서버 라우트는 `"default"`로 각자 조용히 폴백(`agent-computer/src/index.ts:137-174`, `computer/routes.ts:89-90`) [확인] | CLAUDE.md가 경고한 "아무의 것도 아닌 빈 페이지"가 두 이름으로 존재 |
| 스테일 검사 | `computer_key`에 `ref`만 있고 `snapshotId`가 없으면 검사를 건너뜀(`index.ts:1081-1083`) [확인] | 작은 구멍 |
| 쿠키 저장 | `--password-store=basic`(`profiles.ts:55-62`) | 볼륨을 읽을 수 있으면 누구나 로그인 쿠키를 읽는다. 1인 1VM에서 허용 범위이나 문서화 필요 |

"API 없는 툴 80%"가 Grok Bot의 소구점이고 한국 SMB에서는 100%에 가깝다. 이 표가
**제품의 실제 병목**이다. 경계·프롬프트를 고쳐도 봇이 스마트스토어 주문 목록을 못
읽으면 자영업자에게는 아무것도 아니다.

### 3.4 서버 — 구조와 유령

**코드가 결정 기록과 다툰다 [확인].** `docs/laf/deployment-model.md`는 "단일 프로세스,
in-process Map이 옳다"고 못 박았다. 그런데 `index.ts:248-252, 522`는 승인·반복·상시
허용의 **DB 변형**을 배선하고, 그 docstring은 "여러 서버 뒤의 로드밸런서"를 이유로 댄다
(`approvals.ts:353-361`, `repeat.ts:354-360`). `approvals.ts:5-11`은 여전히 "일부러
DB에 없다"고 쓴다. `channels/events.ts:11-13`의 LISTEN/NOTIFY도 "두 번째 서버
인스턴스"가 이유이며 그것만을 위해 전용 커넥션과 SIGINT 처리가 있다. 같은 모순이
약 8곳. 비용: 판정되는 클릭마다 DELETE 2 + INSERT + COUNT(+INSERT ≤3)
(`repeat.ts:393-443`), 승인 폴링마다 DELETE + SELECT를 두 폴러가 1초 간격으로
(`rooms/wait-for-approval.ts:31`, `app/src/lib/approvals.ts:26`). 룸은 자기 레지스트리를
120초까지 1초마다 폴링한다 — 한 프로세스 안에서 프로미스 하나면 될 일이다.

**돌지 않는 모드가 배선돼 있다 [확인].** Intelligence 모드: 환경변수 4개
(`config.ts:342-377`), 항상 `true`인 `durableHistory`(`:14-24`, `/api/capabilities`에
노출), `copilot.ts:536-553` 분기, `DEPLOYMENT_ID`·`thread-identity.ts`,
`intelligence_channel_mappings` 테이블명, 그리고 "이 제품은 Intelligence 모드뿐"이라는
주석(`turn-watchdog.ts:22`, `stall-guard.ts:10-14`) — `config.ts:1-9`는 정반대를 말한다.

**업스트림 지식 플레인이 죽은 채 남아 있다 [확인].** `server/src/knowledge/`는 테스트
둘만 import한다. `agents/registry.ts`·`invocation.ts`·`knowledge-agent.ts`는
테스트 전용이며 옛 "Model credential is not configured." 산문과 `built_in` → 지식 검색
디스패치를 품고 있다. `connectors/`는 어댑터 구현이 없고 `sync-persistence.ts`는
아무도 import하지 않는데, **관리 화면의 Google Drive 서비스 계정 키는 저장된다**
(`app/.../connectors/google-drive.tsx:29` → `app.ts:410`) — 아무도 읽지 않는 키. 그리고
`tenant/laf/knowledge.yaml`은 업스트림 샘플 루트(Drive "Policies, Compliance",
OneDrive "Risk, Operations")를 여전히 커넥터 관리 서비스에 먹인다.

**워처는 표면이 없고 깨우기는 인증을 못 한다 [확인].** `app/src`에 `/api/watch` 참조
0. `poller.ts:158-183`은 자기 API를 루프백으로 POST하며 쿠키·헤더 없이 보낸다;
`identifyUser`(`index.ts:96-99`)는 세션 없이 던진다(`LAF_DEV_NO_AUTH` 제외). 실배포
에서 깨우기는 로그에 실패로 남을 것이다 [추정: 실행 미측정]. 깨우기 메시지도 영어다
("Write a short operational note for the owner"). `LAF_DIGEST_*`·`LAF_NOTIFY_WEBHOOK_URL`
세 변수는 `.env.example`·docs·compose 어디에도 없다.

**플러그인 스토어 [확인].** `plugins/store.ts` `createPluginStore`는 **2,581줄 클로저**
(3,196줄 중 주석 1,136줄). `callTool` 299줄이 DB·정책·승인·금고·네트워크·감사·산문을
섞는다. 커스텀 MCP 호출 경로는 **리다이렉트를 따라간다**(`mcp.ts:220-224`가
`redirect` 미지정; 토큰 엔드포인트는 전부 `manual`) — 302로 `http://localhost:4100`
(봇 컴퓨터)에 닿을 수 있다. 호스트 검사는 정적(DNS 미해석, `catalogue.ts:422-511`)이고
브라우저 쪽 `checkNavigationTarget`의 IPv4 대역 검사를 쓰지 않는다. OAuth `state`는
봉인·PKCE S256·사용자 바인딩은 되지만 **1회용이 아니고 세션에 묶이지 않는다**
(`oauth.ts:184-195`) — 계정 보유자가 발급한 URL로 동료의 동의를 자기 행에 붙일 수 있다
[추정]. `secretFor`는 에러 문장 `includes("revoked")`로 흐름을 가른다(`store.ts:693`) —
같은 파일이 `238-244`에서 없앴다고 적은 패턴이다. Drive 통합이 둘(카탈로그 OAuth vs
`connectors.ts` 서비스 계정), 호스트 거부 목록이 둘, 자격증명 단어 목록이 둘.

**라우틴은 소유자를 모른다 [확인].** `routines/routes.ts:80-118` — `runs`·`setEnabled`·
`runNow`·`remove`가 `service`에 actor를 넘기지 않고, 서비스 메서드는 id만 받는다
(`service.ts:551-621`). 같은 VM의 다른 사용자(사장님 + 직원 계정)가 남의 라우틴을
실행·정지·삭제할 수 있고, `list()`는 `triggerTokenHash`를 돌려준다. `MAX_ROUTINES`
20은 계정이 아니라 테이블 전체를 센다(`:510-512`). 재시작 후 `nextRunAt`이 과거면 첫
틱에 바로 실행 — 07:30 루틴이 장애 뒤 09:00에 돈다(놓친 창 규칙 없음). `dailyUtc`
컬럼은 시간대 지역 시각을 담는다.

**좌석 잠금이 주석과 다르다 [확인].** `profile-store.ts:288-317` 트랜잭션 안의 `count()`
— `FOR UPDATE`도 advisory lock도 제약도 없다. read-committed에서 두 동시 요청은 둘 다
4를 보고 둘 다 넣는다. 같은 블록이 `duplicate()`에 주석까지 복사돼 있다(`:438-470`).

**대화 스냅샷은 시스템 오브 레코드인데 쓰는 곳이 셋이다 [확인].** `laf-runner.ts:
637-666` 전체 교체, `rooms/transcript.ts:137-151`·`routines/deliver.ts:124-138` `||`
덧붙임. 메시지 타입 정의도 셋. 교체와 덧붙임이 겹치는 창에서 덧붙인 메시지가 사라질
수 있다 [추정]. 부팅 시 **모든 스레드 전문을 메모리에 올린다**(`:353`, 투영·상한 없음).
런 원장도 두 곳이 쓴다(`laf-runner.ts:548-557`, `run-ledger.ts:45`). 한 턴을 서버에서
돌리는 길이 넷(런타임+러너, `runAgentOnce`, `runUnattended`, 폴러의 자기 HTTP 호출).

**그 밖에 [확인].** `recordAuditEvent`를 우회해 `auditStore.insert`를 직접 부르는 곳
둘(`coworker-call.ts:153`, `routines/service.ts:451`). 감사 이벤트 타입 4개는 쓰는 곳
없음. `requireAdmin`은 미들웨어가 아니라 핸들러 안의 호출이라 빠뜨리면 조용히 열린다 —
라우트를 걷는 테스트가 없다. `NODE_ENV=production`은 compose에만 있고 이미지에는
없어(`server/Dockerfile`), `docker run`이나 `bun src/index.ts`로 띄우면 `LAF_DEV_NO_AUTH`
잠금이 없다. `INITIAL_ADMIN_EMAILS`는 계정 생성 시 한 번만 읽힌다. `agent_memories`
라우트는 `store.get` 결과를 버린다(`agents/routes.ts:515`, 주석은 검사한다고 씀).
`AgentActor`는 봇이 아니라 사람이다. `components/` 카탈로그 PUT은 일반 사용자가 즉시
공개 행을 넣을 수 있고 `/call`은 누구나 감사 전체를 질의한다(`functions.ts:63-101`).

### 3.5 데이터 모델

44개 테이블(`server/src/db`, 마이그레이션 24개, 체인 무결).

- **고아 6개 [확인]**: `connector_cursors`, `webhook_subscriptions`, `sync_runs`,
  `documents`, `chunks`(`vector(1536)`, 벡터 인덱스 없음, 질의 0), `document_acls`.
  `0000_schema.sql`이 만들고 `tests/schema.test.ts:74-90`이 지킨다. pgvector 이미지를
  요구하는 이유가 이 죽은 컬럼 하나다.
- **외래키 없는 절반 [확인]**: `laf_*`·`computer_*` 전부가 agents/users/threads를 맨
  텍스트로 가리킨다. 봇을 지워도 라우틴은 `enabled`인 채 매 틱 claim된다; 사용자를
  지워도 스냅샷은 소유자 컬럼이 없어 **주소 없는 전문**으로 남는다(PIPA 삭제권 관점).
  `gateway.ts:1090-1092`는 "감사 테이블에 FK가 있다"고 쓰는데 없다.
- **jsonb 타입이 둘 [확인]**: `json.ts` 커스텀 타입은 객체만, 배열은 drizzle `jsonb`
  + 손 캐스트 `::text::jsonb` 네 곳. 읽기는 문자열 행을 `[]`로 삼킨다 — 옛 이중 인코딩
  스레드가 빈 대화로 보인다 [추정].
- **어휘 [확인]**: `agent_id` vs `bot_id`, TS `grantedAt` → SQL `created_at`,
  enum 8개 옆에 free text 상태 8개, `daily_utc`가 UTC 아님, `intelligence_channel_mappings`
  는 사라진 서비스 이름, `laf_digest_log.channel`은 `stdout|webhook`.
- **인덱스 [추정]**: `audit_events`는 `created_at`만(필터는 type/actor/target),
  `laf_thread_runs.started_at` 범위 질의는 seq scan(부분 인덱스가 완료 런 제외, 삭제
  없음), `laf_watch_events.observed_at` 없음. 1인 규모에서는 괜찮고 나이를 먹으면 나빠진다.
- **민감 컬럼 [추정]**: 봇이 `computer_type`으로 친 텍스트는 AG-UI 메시지의 툴 인자로
  `laf_thread_snapshots`에 그대로 남는다. 녹화기와 감사는 값을 안 남기지만 전문은
  남긴다. `request_secret` 경로는 모델을 거치지 않으니 정상 흐름에서는 비밀이 안
  들어가야 하나, **직렬화 후 부재를 단언하는 테스트가 이 경로엔 없다.**

### 3.6 앱 — 정보구조, 어휘, 성능, 모바일

(정보구조·어휘는 최종 보고 도착 후 보강. 아래는 확인된 것.)

**폴링 [확인].** 전역 `CopilotProvider`에 실린 세 폴(컴포넌트 5초, 플러그인 15초,
샌드박스 30초 — `lib/components/queries.ts:56`, `lib/plugins/queries.ts:280`,
`lib/sandboxed/queries.ts:65`)이 `refetchIntervalInBackground: false` 없이 모든 인증
화면에서, 봇이 없는 화면에서는 `"default"` 봇 ID로 영원히 돈다. `useNeedsYou`는
`when=true` 하드코딩으로 채널마다 3초 폴(`channel/$channelId.tsx:76`). `ComputerView`의
제어 폴(`computer-view.tsx:234`)은 안정화 가드가 없고 트랜스크립트의 컴퓨터 툴콜마다
하나씩 마운트된다. 잘 된 것: `working.ts:41-43`(4초, 백그라운드 꺼짐) — 이 하나만
옳다. 라우트 로더는 27개 파일 중 0 — 채널 화면이 4단 워터폴이다. 감사 로그 표는
페이지네이션·가상화 없이 전량 렌더(`admin/audit.tsx:141`, `lib/audit/queries.ts:16`).
라우틴 화면은 `routineKeys`를 두고 문자열 키를 여섯 번 손으로 쓴다.

**죽은 코드 [확인].** `components/agents/orb/`(832줄, 업스트림 임포트 커밋에서 온 뒤
미사용), `abstract-avatar.tsx`, `lib/package/queries.ts`, `boring-avatars` 의존성
(교체됐다는 주석만 남음), 도달 불가한 `/bot` 라우트(존재하지 않는 `risk-analyst`를
기본값으로), `ui/sidebar.tsx` 24개 export 중 14개 미사용(모바일 시트·단축키 기계 전체).

**모바일·셸 [확인].** 셸 전체에 반응형 브레이크포인트 1개(`detail-panel.tsx:90`
`lg:static`); 로스터 280 + 패널 320 + 대화 최소 424 = **1024px 전제**. 로스터의 접힘·
시트 기계는 일부러 삭제됐다(`_app.tsx:15-18`). 데스크톱 셸 `minWidth: 800`
(`tauri.conf.json:18`)은 그 전제보다 224px 작다. `--sand-titlebar-block: 44px`는
`titleBarStyle` 미설정이라 신호등 아래 빈 44px이다. 버튼 변형 전부 44px 미만
(`button.tsx:28-41`), **승인·거절이 28px**(`approval-request.tsx:106,132`), 수신자 칩
삭제가 20px. `LiveScreen`에 터치·포인터 핸들러 0 — 폰에서 봇의 브라우저에 타이핑할
길이 없다. 알림 권한 버튼은 `"Notification" in window`가 WKWebView에서 거짓이라 셸에서
안 그려진다(`notification-permission.tsx:29-33`). 딥링크·단일 인스턴스 플러그인 없음 —
알림 클릭이 방을 잃고(`bot-notifications.ts:167-168`), OAuth 동의가 창으로 못 돌아온다.
스레드 ID·로케일·테마가 localStorage — 같은 계정의 PC와 폰이 다른 대화다.
`h-screen` 2곳, `body { min-height: 100vh }`, `viewport-fit=cover`·safe-area 없음.

### 3.7 테스트와 게이트

- **플로어가 얇다 [확인].** `MINIMUM_TESTS = 1290`이 저장소 전체 `bun test`(약 1,289~
  1,294)를 상대로 서 있다 — 여유 ≤ 2%. 중간 크기 서버 파일 하나를 잃어도 못 잡고,
  정당한 통합 하나에도 걸린다. 그리고 죽은 코드 여섯 스위트(registry·invocation·
  knowledge-agent·knowledge-repository·knowledge-acl·sync-persistence)가 초록으로 그
  숫자를 채운다.
- **테스트가 앱의 살아 있는 행을 지운다 [확인].** `policy-durability.integration.test.ts:
  32-34`가 `action_policy` `id="current"`(앱의 단일 정책 행)를 삭제한다 — 테스트를 돌릴
  때마다 사람의 deny/ask/allow와 `settleWithoutAsking`이 사라진다.
  `connector-admin.integration.test.ts:61-86`은 `google_drive` 타입 전체를 지우고
  복구하지 않는다. CLAUDE.md의 "공유 DB" 규칙은 이 때문에 있는데 여전히 위반이다.
- **없는 것 [확인].** `/api/computer` 29개 엔드포인트(타이핑·파일 쓰기·비밀 입력·정책
  PUT)를 치는 테스트 0. rooms·routines·watch HTTP 라우트 테스트 0. `x-openbot-bot-id`를
  이름으로 부르는 테스트 0. `devAuthEnabled`의 프로덕션 거부 테스트 0. MCP 경로의
  `settleWithoutAsking: "off"` 테스트 0. 렌더된 컴포넌트 테스트 0(승인 흐름·봇 생성).
- **잘못된 대상 [확인].** 감사 append-only 트리거 테스트가 마이그레이션 파일의 문자열을
  `toContain`한다(`audit.test.ts:101-110`) — DB에서 한 번도 실행 안 됨. `toBeDefined()`
  한 줄짜리들(`database.test.ts`, `computer-client.test.ts:238-255`). 영어 산문을 고정
  하는 단언 ~20곳(`config.test.ts` 13개 포함) — 서버 문장을 표면이 소유해야 한다는
  규칙과 반대 방향으로 고정.
- **불안정 [확인].** 벽시계 단언(`channel-preview.test.ts:13-15` < 100ms), 실제 타이머
  8곳, `mock.module`이 프로세스 전역이라 뒤의 플러그인 스위트 셋이 우회 코드를 품음.

### 3.8 인프라·배포·문서

아래 수치는 `gh`(CI 실행·릴리스·시크릿 목록), 로컬 `bun run test:ci`, 업데이터
엔드포인트 `curl`로 잰 것이다.

**`:stable`이 검사 없이 움직인다 [확인].** `ci.yml`은 `main`/`laf/**` 푸시와 PR에만 돌고
태그에는 안 돈다(`:4-10`). `images.yml`은 `v*` 태그에 돌며 `:vX.Y.Z`를 만들고 **`:stable`
을 옮긴다**(`:121-124`) — CI에 `needs`가 없다. v0.3.2 실측: CI 05:48:53→05:49:40,
이미지 05:49:04→05:50:53, 병렬. 태그 하나가 2분 만에 시험 없는 코드를 함대 전체에
보낸다. `main`은 브랜치 보호가 없다(API 404). compose에 `pull_policy`가 없어 재부팅
복구나 손 수정의 `up -d`는 캐시된 `:stable`을 조용히 유지한다. `:edge`는 수동 디스패치
뿐이라 `deploying.md:112`("edge = main")는 낡았다.

**릴리스 드래프트가 발행되지 않아 셸 업데이터가 0.2.0에 얼어 있다 [확인].** v0.3.0·
0.3.1·0.3.2 전부 Draft. `releases/latest/download/latest.json`은 `0.2.0`을 준다(HTTP
200). 서버 이미지는 v0.3.2인데 설치된 셸은 새것을 못 받는다. 저장소의 버전 문자열
셋(`tauri.conf.json:4`, `Cargo.toml:3`, `desktop/package.json:4`)은 0.2.0 고정이고
러너에서 도장을 찍는다.

**설치 파일이 서명되지 않았다 [확인].** 시크릿은 `TAURI_SIGNING_PRIVATE_KEY`(업데이터
서명)뿐. Apple Developer ID·공증·Windows 인증서 없음. 지금 나가는 dmg는 다른 Mac에서
Gatekeeper가 거부하고 exe는 SmartScreen이 막는다. **"PC 앱이 제품"은 여기서 막혀
있다.** 비개발자 사장님에게는 넘을 수 없는 벽이다.

**셸에 백그라운드 존재가 없다 [확인].** 트레이·`CloseRequested`·자동 시작·딥링크 0
(`lib.rs`; `tray-icon` 기능은 켜져 있고 미사용). 창을 닫으면 프로세스가 끝나고 "봇이
기다린다" 알림은 살아 있는 페이지에서만 난다. 웹뷰 안에서 Google·Kakao·Naver 1차
로그인이 되는지 **잰 적이 없다**[추정] — Google이 벤더 동의에 `disallowed_useragent`를
낸 기록(`connections.md:70-75`)이 있으니 첫 번째로 재야 할 것.

**봇 컴퓨터가 뚫리면 VM이 넘어간다 [확인].** `agent-computer`는 root(`Dockerfile:10-11`),
Chromium `--no-sandbox`(`profiles.ts:64`), 여섯 서비스가 한 브리지에 `networks:` 없이.
렌더러 익스플로잇 하나면 컨테이너 root → `postgres:5432`(`openbot/openbot` 리터럴,
`docker-compose.yml:5-7,33,55`) → 세션·전문 전부, `agent-bot:4200`(모델 키로 답하고
아무에게도 안 물음), 사람의 모든 로그인 세션, 무제한 egress. `deploy.resources`·
`logging:`·`user:`·`cap_drop`·`read_only` 전부 없음.

**`/health`가 상수다 [확인].** `server/src/app.ts:217`. DB·agent-bot·컴퓨터가 죽어도
"healthy". `web`은 헬스체크 자체가 없다. 구조화 로그·요청 ID·메트릭 0, `console.*`
24곳, 로그 회전 없음. 디스크: `audit_events`는 append-only 트리거라 지우려면 트리거를
내려야 하고, 스냅샷은 전문, Chromium 캐시 무제한, 이미지는 풀 때마다 쌓임.

**CI가 안 보는 것 [확인].** `agent-computer`는 워크스페이스가 아니라(`package.json:6-11`)
루트 `typecheck`가 못 본다 — 브라우저를 모는 서비스가 타입 검사 없이 이미지가 된다.
`desktop` typecheck는 `echo`. Rust 테스트는 태그에서만. PR/main에서 이미지 빌드 0,
스모크 0, 감사 0, Dependabot 0. 스모크 테스트는 **세 겹으로 죽어 있다**: `package.json:23`
은 `OPENBOT_SMOKE=1`을 주고 `tests/smoke/journey.test.ts:21`은 `LAF_SMOKE`를 읽어
항상 skip; 고쳐도 `mode === "intelligence"`와 존재하지 않는 `risk-analyst`를 기대한다.
서버 + agent-bot + agent-computer를 함께 모는 테스트는 **하나도 없다**. 평가는
agent-bot을 직접 import해 모델만 인증한다.

**재현 불가 이미지 [확인].** `agent-bot/Dockerfile:7`·`agent-computer/Dockerfile:15`가
lockfile 없이 `bun install`; `agent-computer/Dockerfile:10`이 빌드 시 `curl bun.sh/install
| bash`(미고정); agent-bot만 `oven/bun:1.3-alpine` 유동 태그. 미사용 의존성:
`boring-avatars`, `@testing-library/*`(import 0), `spiffe`(제거된 SPIRE 플레인, 이미지에
설치됨).

**배포에 닿지 않는 손잡이 [확인].** `REVIEW_MODEL`·`BOT_MODEL_EFFORT`·
`COMPUTER_REPEAT_WINDOW_MS`는 서버가 읽지만 compose `server` env에 없다 — VM에서는
영원히 기본값. 자동 리뷰 수리(§3.1)는 compose까지 손대야 실배포에 닿는다.

**문서의 거짓 [확인].** README 히어로 영상은 업스트림 페르소나 데모; `README.md:194`의
`LAF_DEV_NO_AUTH`는 프로덕션에서 거부됨; `ANTHROPIC_*`·`GOOGLE_*`·`BOT_PROVIDER`·
`BOT_RESPONSES_API`는 어디서도 안 읽힘(`.env.example:145-161`); `.env.example:196-198`
"봇마다 자기 컨테이너"·`:264-266` "두 번째 봇 :4201"은 제거된 플레인;
`admin/computers.tsx:143`은 사용자에게 `COMPUTER_SUPERVISOR_URL`을 권한다(제거됨);
`.github/pull_request_template.md:7-12`는 **모든 PR에게 "로드밸런서 뒤 여러 프로세스"
로 설계하라고 지시한다**; `architecture.md:149`는 지운 벤더 5개를 나열; `brand.yaml:3`은
저장소에 없는 `docs/m1-execution.md`를 가리킴. 정확한 문서: `deployment-model.md`,
`deploying.md`, `connections.md`, `eval-pack.md`. **한국어 사용 설명서는 없다** —
`docs/laf`의 한국어는 결정 기록과 고객사 개발자용 계약이다.

**PIPA(개인정보보호법) 관점 [기계는 확인, 법적 해석은 추정 — 자문 필요].** 데이터
내보내기·계정 삭제 엔드포인트 없음. 보존 일정 없음. 백업(로컬 14벌 + 원격 버킷)이 VM
보다 오래 산다 — 파기 절차에 포함돼야 한다. 프로필 볼륨은 사람의 제3자 세션 쿠키를
root가 읽을 수 있는 형태로 담는다. 감사 행은 URL·요소 이름을 담아 **고객의 고객**
개인정보가 들어갈 수 있다 → LAF는 수탁자이고 위탁 계약·처리방침·접속기록이 필요하다.
관리자는 로그인된 브라우저를 실시간으로 볼 수 있고(`live-screen.tsx:55-57`) SSH
운영자는 전부를 보며 그것을 기록하는 것이 없다.

**테스트 수 실측.** CI 마지막 실행 "Ran 1333 tests across 132 files", 플로어 1290 —
여유 43(3%). 앞의 §3.7 정적 추정(≤2%)보다 조금 넓지만 결론은 같다.

---

## 4. 설계 원칙 — 리팩토링이 따를 기준

발견을 하나씩 고치면 3주 뒤 같은 모양이 된다. 아래 여덟 줄이 앞으로의 모든 변경이
답해야 하는 질문이다.

1. **결정 기록이 코드를 이긴다.** 프로세스는 하나다. 상태의 자리는 이 규칙으로 정한다:
   *재시작을 넘어 살아야 하는 것만 DB*(정책, 상시 허용, 라우틴, 대화, 자격증명),
   *살아 있는 대화의 상태는 메모리*(대기 중 질문, 반복 카운트, 룸의 승인 대기). "여러
   서버"를 이유로 대는 코드와 주석은 전부 지운다. 반대로 결정이 바뀌면 이 문서부터
   고친다.
2. **서버는 사실을 보내고 표면이 말한다.** 모든 오류 본문은 `{code, ...facts}`. 승인
   질문은 `{intent, host, element, file, tool}` 같은 구조. 툴 결과 속 지시문("A person
   has control")도 코드다. 영어 문장이 JSON을 타면 회귀다 — 테스트가 잡는다.
3. **기본값이 제품이다.** 관리자가 규칙을 쓰기 전의 배포가 곧 대부분의 배포다. 기본
   `ask` 목록을 출하한다. 작동하지 않는 컨트롤은 그리지 않는다(자동 리뷰가 그 예).
4. **한 가지 일에 한 곳.** 게이트웨이의 정산 절차 하나, 툴 카탈로그 하나, 대화 쓰기
   하나, 런 원장 쓰기 하나, 감사 입구 하나, 호스트 판정 하나. 두 번째 사본이 생기면
   그것이 버그다.
5. **봇은 한국에서 산다.** 프롬프트는 한국어로 생각하게 하고, 지금이 언제인지(KST)
   알며, 브라우저는 ko-KR·Asia/Seoul로 뜨고, 새 탭·경고창·다운로드·업로드·iframe이
   있는 사이트를 전제로 한다. 안 되는 것(공동인증서·보안키패드)은 문서에 적는다.
6. **죽은 것은 지운다.** 업스트림의 플레인, 돌지 않는 모드, 아무도 안 읽는 키. git이
   기억한다. 남길 거면 남기는 이유를 CLAUDE.md에 한 줄로.
7. **폰에서 성립하지 않으면 끝난 것이 아니다.** 44px, 1024 아래의 레이아웃, 딥링크,
   기기 아닌 계정에 붙은 상태. PC 우선 순서는 그대로되, 승인 하나만은 폰에서 되게.
8. **잰 것만 말한다.** `/health`는 진짜를 답하고, 네 컨테이너를 함께 모는 테스트가
   매일 돌고, 평가는 프로덕션의 프롬프트·툴을 그대로 쓴다. "정상 응답했다"는 증거가
   아니다(CLAUDE.md).

---

## 5. 개선 설계

각 항목: 무엇 / 왜 / 어디 / 크기(S 하루 이내, M 며칠, L 일주 이상) / 무엇이 증명하는가.

### 5.1 경계 v2 — 약속을 참으로

**(a) 기본 `ask` 목록 출하.** `DEFAULT_ACTION_POLICY`에 다음을 넣는다. 규칙 언어는
현재 `policy.ts`의 컨텍스트 필드(`intent`, `element.role/name`, `host`, `repeat.count`,
`mcp`)로 표현 가능한 범위에서:

| 규칙 | 뜻 |
|---|---|
| `intent == activate && element.name ~ 결제·송금·이체·출금·구매·주문·삭제·탈퇴·전송·보내기·발송·발행·승인·확정` | 돈·발신·삭제·확정 버튼(단어 목록은 패키지 데이터) |
| `intent == activate && host ∈ money-hosts` | 은행·PG·정산 도메인 목록(패키지 데이터, 배포가 편집) |
| `intent == navigate && host 첫 방문` | 새 호스트 첫 진입은 묻고, "이 사이트는 허용"으로 상시 허용 |
| `intent == type && element.type == password` | 거부 + `request_secret`로 안내(사실 코드) |
| `repeat.count >= 5` | 같은 행동 반복 |
| `mcp.guard ∈ {money, external, destructive, unannotated}` | 이미 플로어로 있음 — 정책 문법으로 옮겨 한 곳에 |

첫 방문 판정에는 봇별 방문 호스트 집합이 필요하다(메모리 + 상시 허용 행). `dry-run`
모드는 관리자 화면에 그리지 않을 거면 스키마에서도 뺀다. 크기 M. 증명: 게이트웨이
테스트에 "규칙 없는 배포에서 '송금' 버튼은 묻는다"가 생기고, 실배포 sajuhook에서
출금 승인 버튼이 멈추는 것을 화면으로 본다.

**(b) 질문을 구조로.** `PresentedApproval`에 `subject: {intent, host, path?, element?:
{role, name}, file?, tool?: {server, name, guard}}`를 싣고 `describeAsk`·`ASK_VERBS`를
지운다. 표면(`approval-request.tsx`, `room-approvals.tsx`, `admin/boundaries.tsx`)이
한국어로 조립한다: "사주훅 관리자에서 '출금 승인' 버튼을 누르려 합니다". MCP 가드
질문(`laf-contract.ts:36-46`)도 같은 구조로. 거절 사유는 `laf:policy_denied`,
`laf:blind_action`, `laf:target_refused` 같은 코드 + 사실. 크기 M. 증명: `app/tests`에
질문 렌더 테스트(구조 → 한국어), 서버 테스트에서 `question` 문자열 필드가 사라짐.

**(c) 정산 절차 하나.** `computer/settle.ts`로 추출: `settle(subject, {policy,
approvals, standing, autoReview, repeat}) → {outcome, approvedBy?, allowance?,
autoReviewed?}`. 게이트웨이(`gateway.ts:404-519`)와 플러그인 스토어(`store.ts:1512-1585`)
가 이것만 부른다. MCP 호출도 자동 리뷰와 반복 카운터를 받는다. 크기 M. 증명: 두 경로에
같은 계약 테스트(`settle-contract.test.ts`)가 돌고, `settleWithoutAsking: "off"`가 MCP
경로에서도 상시 허용을 무시하는 테스트가 생긴다(지금 없음).

**(d) No가 붙는다.** `declined`는 (봇, 지문)에 대해 그 대화가 끝날 때까지(또는 N분)
`deny`로 남는다. Deny 버튼 옆에 "이번 대화에서는 묻지 마"가 아니라, 기본이 붙는
No이고 "다시 물어봐도 됨"이 예외다. 기록: `approval.declined` 행에 `stickyUntil`.
크기 S. 증명: 게이트웨이 테스트 "거절 뒤 같은 행동은 질문 없이 거부".

**(e) 자동 리뷰를 살리거나 지운다.** `auto-review.ts:130`의 `maxTokens: 200` 삭제.
추론 모델이면 `reasoning_effort: "low"`, 상한 없음, 20초 타임아웃. compose가
`REVIEW_MODEL`을 넘긴다. 배포 부팅 시 자기 모델로 한 번 프로빙(yes/no 하나)해 10초를
넘기면 `capabilities.autoReview=false`로 답하고 표면은 컨트롤을 그리지 않는다. 크기 S.
증명: 실배포에서 "읽기만 하는 건 묻지 마" 문장을 쓰고 `computer_read`가 묻지 않는
것을 화면과 감사 행(`autoReviewed`)으로 본다.

**(f) 잔손.** `computers/reset`·`policy` PUT·`standing` DELETE는 `requireAdmin`
미들웨어로. `human/:kind`는 `kind`를 본문 스프레드 뒤에 둔다. `describe-point`의
`innerText` 80자는 없앤다(요소 역할·라벨은 이미 있음) 또는 녹화 직렬화 테스트에
넣는다. `opened()`를 배선하거나 write-up 가정을 지운다. `settleWithoutAsking`은
`/admin/boundaries`에 배포 스위치로 그린다(관리자 전용, 사유 입력 필수) — 그리지 않을
거면 스키마에서 뺀다. 크기 S.

### 5.2 봇 두뇌 v2

**(a) LAF의 프롬프트.** `shared/prompt/` 디렉터리: `base.ko.ts`(정체·언어·정직·비밀
규칙, 한국어), `mode/{chat,room,routine,coworker}.ko.ts`, `tools/*.ko.ts`(툴이 있는 실행
에서만 조립). 합성은 `copilot.ts` 미들웨어(이미 유일한 이음새)가 하고 **매 런에
`지금: 2026-09-02(화) 10:30 KST`와 봇 ID를 시스템 줄로 넣는다.** 코드가 강제하는 규칙은
산문에서 뺀다. 문단은 `\n\n`으로. 크기 M. 위험: 평가 재통과 필요 — 그래서 (e)와 같이
간다. 증명: 평가에 "날짜를 주지 않은 '오늘 주문'" 시나리오, "영어로 물어도 한국어로
답한다(배포 언어)" 시나리오.

**(b) 툴 카탈로그 하나.** `shared/tools/computer.ts`가 JSON 스키마 + 한국어 설명의
원본. `computer-tools.tsx`는 여기서 읽어 `useFrontendTool`에 넘기고, `unattended.ts:
479-641`과 `evals/tools.ts`는 import한다. `schema.ts`의 `COMPUTER_TOOLS`는 이것으로
대체. `computer_screenshot`은 등록하거나 계약에서 뺀다. `report_refusal`은 지운다
(턴당 150토큰짜리 감사 연극). 크기 M. 증명: 세 소비자가 같은 객체를 참조한다는 테스트
(`mcp-check-mirror`처럼 미러 테스트가 아니라 동일성).

**(c) `update_state` 분할.** `update_profile{name?, title?, description?, effort?}`와
`manage_routine{action: create|update|delete, ...}`(discriminated union). 유효성은
서버가 코드로 검사하고 `laf:routine_needs_schedule` 같은 코드로 답한다. 산문 1,500자는
300자로. `remember`는 서버가 비밀 패턴(비밀번호·카드·계좌 형태, 그리고 그 런에
`request_secret`가 열렸던 사실)을 거른다. 크기 S~M.

**(d) 컨텍스트 예산.** agent-bot: 최근 K개(예: 4)의 툴 결과만 전문, 그 앞의 페이지
본문 결과는 앞 500자 + `[…]`. `finish_reason: "length"` → `CUSTOM laf.answer_truncated`
+ 표면에 "답이 잘렸습니다, 이어서 요청". 빈 완료 → `laf.empty_answer` → effort 한 단계
낮춰 1회 재시도. 요청 타임아웃 120초. 크기 M. 증명: 평가에 12걸음 탐색 시나리오와
토큰 상한 단언.

**(e) 평가는 프로덕션의 거울.** `evals/run.ts`가 실제 역할 메시지·실제 툴셋·실제
프롬프트 합성 함수를 import한다. 보고서에 프롬프트 해시를 기록하고, **같은 판정 안에서
프롬프트를 고치면 새 판정**으로 센다(의식의 규칙에 한 줄 추가). 시나리오 추가: 승인
정지 → `approvalId`로 재개, 스테일 ref 복구, 인계 → 반납 → 계속, 자동 리뷰 진리표,
지연 상한(툴콜 1회 중앙값 < 8초), 비용 상한(시나리오당 원가 ₩). 로컬 픽스처 사이트
(정적 HTML: 로그인 폼·목록·`_blank` 링크·alert·iframe·다운로드)로 다단계 브라우저
과업을 재현 가능하게. 크기 M~L.

**(f) 정리.** `BOT_MODEL` 기본값 하나(`config.ts`), `BuiltInAgent` 분기 삭제,
`gpt-5.5`/`gpt-4.1` 소멸.

### 5.3 브라우저 현실화

| 무엇 | 어디 | 크기 |
|---|---|---|
| 런치 옵션: `locale: "ko-KR"`, `timezoneId: "Asia/Seoul"`, Headless 문자열 없는 UA, `acceptDownloads: true`, 뷰포트 1280×800 | `profiles.ts:161-171` | S |
| 새 탭: `context.on("page")`로 최신 페이지를 활성으로 채택, 스냅샷에 탭 목록·`computer_switch_tab` | `index.ts`, 툴 카탈로그 | M |
| 경고창: `page.on("dialog")`가 메시지를 다음 툴 결과에 실어 주고(사실 코드 `laf:dialog`), 기본 dismiss; confirm은 정책의 `activate`로 취급 | `index.ts` | S |
| 다운로드 → `workspace/downloads/`, 감사 행; `computer_upload_file`(워크스페이스 파일 → `setInputFiles`) | `index.ts`, `workspace.ts`, 카탈로그 | M |
| 본문: 살아 있는 `body.innerText`(복제 아님), `networkidle` 3초 상한 + 안정화 대기, `frames()` 순회로 iframe 본문 병합, aria 스냅샷도 프레임 포함 | `index.ts:187-204, 655-663` | M |
| 한글 인계: 표면 `compositionend`에서 `insertText`로 전송 | `live-screen.tsx`, `screencast.ts` | S |
| 재시작 fail-safe: 제어 상태를 프로필 디렉터리에 JSON으로; 사람이 쥐고 있었으면 재시작 후에도 사람 | `control.ts` | S |
| 헤더 필수: `/health`·`/computers` 외 `x-openbot-bot-id` 없으면 400. `"shared"`/`"default"` 폴백 삭제 | `agent-computer/src/index.ts:137-174`, `computer/routes.ts:89` | S |
| 자원: `mem_limit`(6GB 박스에 3g), `shm_size: 1g`, `--disk-cache-size=100MB`, 10분 유휴 시 컨텍스트 닫기(다음 호출에 재오픈) | compose, `profiles.ts` | S |
| 격리: 비root 사용자, `cap_drop: [ALL]`, `no-new-privileges`, 전용 네트워크(postgres·agent-bot로 경로 없음) | `agent-computer/Dockerfile`, compose | M (샌드박스는 userns 필요) |
| `computer_key`의 `ref`만 있는 호출도 스테일 검사 | `index.ts:1081-1083` | S |

문서: `docs/laf/`에 "봇의 브라우저가 못 하는 것" 한 장 — 공동인증서, 보안키패드,
CAPTCHA, 결제 인증창은 사람 인계. 그리고 각 주요 한국 사이트에서 실측한 결과표를
평가 픽스처와 함께 유지한다.

### 5.4 서버 감량

**(a) 삭제 목록.** 전부 git에 남는다.

| 대상 | 대략 | 근거 |
|---|---|---|
| `server/src/knowledge/`, `agents/{registry,invocation,knowledge-agent}.ts` + 테스트 6개 | ~1,200줄 | 호출자 0 |
| `connectors/`(contract·sync-persistence), `connectors.ts`, `/api/admin/connectors`, 앱 `admin/connectors/*`, `lib/connectors/queries.ts` | ~900줄 | 어댑터 없음, 키만 저장 |
| Intelligence: `config.ts:342-377`, `runtime` union, `copilot.ts:536-553`, `thread-identity.ts`, `DEPLOYMENT_ID`, `/api/capabilities.durableHistory`, 관련 주석 8곳 | ~400줄 | 돌지 않음 |
| `tenant-package.ts`의 agents/channels/knowledge 파싱·동기화·테마 검증 → `config.ts`에 `model`·`brand`만; 패키지 봇 해제는 마이그레이션 한 벌로 | ~450줄 | 빈 목록 동기화 |
| `tenant/laf/{agents,channels,knowledge}.yaml` | — | 샘플 데이터 |
| `channels/events.ts`의 LISTEN/NOTIFY + 전용 커넥션 + SIGINT 처리 → 커밋 후 `hub.deliver` | ~150줄 | 단일 프로세스 |
| 승인·반복의 DB 변형 **또는** 메모리 변형(§7-1 결정) | ~600줄 | 둘 중 하나 |
| `signed-value.ts` `sign/verify`, 감사 이벤트 타입 4개, `schema.ts` `COMPUTER_TOOLS`, `report_refusal`, `dev-actor-email.test.ts`의 민담 | ~200줄 | 사용 0 |
| 앱: `components/agents/orb/`, `abstract-avatar.tsx`, `lib/package/queries.ts`, `/bot` 라우트, `ui/sidebar.tsx` 미사용 절반 + `ui/sheet.tsx`, `boring-avatars`·`@testing-library/*`·`spiffe` 의존성 | ~1,400줄 | 참조 0 |
| `watch/`(§7-2 결정) | ~1,100줄 | 표면 없음, 깨우기 무인증 |

**(b) 플러그인 스토어 분할.** `plugins/store.ts` → `oauth-client.ts`(~380), `connections.ts`
(~620), `servers.ts`(~800), `skills-and-grants.ts`(~250), `call.ts`(~400). 동작 보존,
기존 통합 테스트가 그대로 지킨다. `secretFor`의 `includes("revoked")`는 에러 클래스로.
MCP 호출 fetch에 `redirect: "manual"`. 호스트 판정은 `computer/target.ts`의 것을 DNS
해석 포함으로 확장해 둘이 같이 쓴다. OAuth `state`는 1회용(메모리 Set + TTL — 단일
프로세스라 충분). 크기 L(분할) + S(보안).

**(c) 라우틴.** 모든 서비스 메서드가 actor를 받고 `created_by_id`(또는 봇 소유자)로
범위를 자른다. 상한은 계정별. 놓친 창 규칙: `nextRunAt`이 1시간 넘게 지났으면 건너뛰고
다음 창으로(감사 행 `routine.skipped`), 1시간 이내면 한 번 실행. 틱 겹침 가드(실행
중이면 다음 틱 건너뜀). `list()`에서 토큰 해시 제거. 크기 S~M. 증명: 라우틴 HTTP
테스트(지금 0) — 남의 라우틴 403.

**(d) 좌석.** `create`·`duplicate` 공용 헬퍼 안에서 `pg_advisory_xact_lock(hashtext(
ownerId))` 후 카운트. 주석은 그제야 참이 된다. 크기 S. 증명: 동시 생성 테스트.

**(e) 대화 저장.** `laf_thread_messages(thread_id, seq, message jsonb, at, run_id?)`
append-only. 쓰기는 `appendMessages(threadId, messages)` 하나 — 러너·룸·라우틴 전달
전부 이것. `laf_thread_snapshots`는 지우고 러너는 스레드를 **요청 시** 읽는다(부팅
전량 로드 제거). 메시지 타입 정의 하나(`shared/`). 런 원장은 `run-ledger.ts`만 쓴다.
크기 L. 증명: 룸 전달과 라이브 턴이 겹치는 통합 테스트에서 메시지 유실 0.

**(f) 규율을 코드로.** `requireAdmin`은 미들웨어. 관리자 라우트 목록을 걷는 테스트
(모든 `/api/admin/*`·정책·상시 허용·리셋이 401/403을 내는지). `recordAuditEvent` 외의
`auditStore.insert` 호출은 lint 규칙(biome `noRestrictedImports`) 또는 테스트로 금지.
`/health`는 DB·agent-bot·컴퓨터를 프로빙한다. 사실 코드 회귀 테스트: 라우트 응답
본문에서 공백 포함 15자 이상의 영어 문장을 찾으면 실패.

### 5.5 데이터 모델

- 마이그레이션 0024: 고아 6개 테이블 DROP, `vector` 확장 DROP, 이미지는 `postgres:17`
  로. 스키마 테스트의 목록 갱신.
- 외래키: `laf_routines.agent_id`·`laf_routine_runs.routine_id`·`computer_*.bot_id`·
  `laf_thread_messages.thread_id` 등에 `references` + ON DELETE(봇 삭제 → 라우틴
  CASCADE, 승인 CASCADE; 사용자 삭제 → 스레드에 소유자 컬럼 추가 후 CASCADE).
  `gateway.ts:1090-1092`의 거짓 주석 삭제.
- enum: `laf_thread_runs.status/origin`, `schedule_kind`, `watch_sources.kind`,
  `action_policy.mode`, `settle_without_asking`(boolean), `plugin_grants.kind`,
  `skills.origin`, `mcp_servers.provenance`.
- 이름: `daily_utc` → `daily_local`(+ `daily_time_zone`), `intelligence_channel_mappings`
  → `channel_threads`. `agent_id`/`bot_id`는 **바꾸지 않는다** — 코드 전체를 흔드는
  비용 대비 얻는 것이 없다. 대신 CLAUDE.md에 "DB에서 봇은 `agent`"라고 한 줄.
- 인덱스: `audit_events(event_type, created_at)`, `(actor_user_id, created_at)`;
  `laf_thread_runs(started_at)`; `laf_watch_events(observed_at)`(유지 시).
- 보존: 감사 행 보존 기간(§7-7 결정) + 야간 잡; 스레드 메시지는 보존하되 내보내기·
  삭제 엔드포인트(§5.9).
- jsonb: 배열도 받는 커스텀 타입 하나로 통일, 손 캐스트 네 곳 제거. 읽기에서 문자열
  행은 `[]`가 아니라 재파싱(러너의 `parseMessages`를 공용으로).
- 테스트: 봇이 친 텍스트가 `laf_thread_messages`에 들어가는 경로에 대해, `request_secret`
  가 열린 런의 비밀값이 직렬화된 스레드 어디에도 없다는 단언.

### 5.6 표면 — 사장님의 앱과 운영자의 콘솔

(앱 정보구조·어휘 보고가 도착하면 라우트별 이동 표를 붙인다. 아래는 확정된 방향.)

**(a) 두 표면.** 지금 한 앱에 두 고객이 산다. 자영업자가 볼 것: 로스터·대화·승인·
루틴·스킬·연결(카카오·네이버 계정처럼 "연결" 한 단어)·설정. 운영자(LAF 또는 고객사
개발자)가 볼 것: 경계 규칙·감사·플러그인/MCP 등록·컴퓨터·자격증명·(플레이그라운드는
삭제 후보). 라우트는 이미 `_app`/`admin`으로 갈려 있으니, **역할이 `user`뿐인 계정에는
admin 진입점을 그리지 않고**, admin의 어휘를 사장님 표면에서 전부 걷어낸다(경계 →
"허락", 감사 → "기록", 플러그인 → "연결", 스레드·엔드포인트·MCP·게이트웨이는 사장님
화면에서 0회). 크기 M.

**(b) 제안은 8패턴으로.** `presets.ts`의 8 범주를 plan-saas §4의 업무 패턴 8종으로
재편하고, 각 패턴에 "주로 쓰는 연결"(브라우저·시트·메일·MCP)을 달아 첫 봇 생성에서
"어떤 일을 맡길까요?"로 보여 준다. 크기 S.

**(c) 폰 레이아웃 — 이 프로젝트에서 제외(결정 2026-09-02).** 전용 모바일 앱이 따로
만들어진다. PC에서 남는 것만 한다: Tauri `minWidth`를 레이아웃 최소(1024)와 일치시키고,
`titleBarStyle: "overlay"`를 쓰거나 44px 예약을 뺀다. `/approve/:id`는 PC 셸의 딥링크
착지로만 만든다. 크기 S.

**(d) 상태는 계정에.** 봇별 스레드 ID를 서버가 발급·보관(`agent_preferences`에
`thread_id`), 로케일·테마는 사용자 설정. localStorage는 캐시로만. 크기 S.

**(e) 폴링·로딩.** 전역 세 폴은 `refetchIntervalInBackground: false` + 채널 범위로
이동(툴 등록은 전역이되 grant 쿼리는 활성 봇이 있을 때만). `useNeedsYou`는 소켓
이벤트로 대체(제어 상태 변경 이벤트 추가). `ComputerView` 제어 폴에 안정화 가드.
채널 라우트에 로더(채널 + 에이전트 + 프로필 병렬). 감사 표 페이지네이션(커서).
`routines.tsx`는 `routineKeys` 사용. `BotRowMenu` 메모. 크기 M.

**(f) 셸.** 알림 권한 UI는 `inShell()`이면 항상 그린다. 트레이 + 닫기→트레이 + 자동
시작 + 딥링크(`lafagent://approve/:id`, `lafagent://channel/:id`) + 단일 인스턴스.
Google·Kakao·Naver 1차 로그인을 WKWebView/WebView2에서 **먼저 잰다** — 안 되면
로그인만 시스템 브라우저로 보내고 딥링크로 돌아오는 구조가 필요하다. 크기 M.

**(g) 표면 어휘 메모 — 사용 설명서를 쓰며 발견한 것(2026-09-02).** 표면 분리 작업의
입력이다.

1. 한 가지를 네 단어로 부른다: 에이전트(사이드바·`/agents`·"새 에이전트"), 봇(환영·
   승인 카드·본문), 코워커("코워커에게 물어보는 중"), 어시스턴트(라이브 화면 전부).
   설명서는 "봇"으로 통일했다 — 표면도 그래야 한다.
2. 비밀번호 입력 버튼이 영어다: `computer-view.tsx:372` "Send to the page" / "Sending…".
3. 작성창의 유일한 버튼이 영어다: `composer.tsx:238` "Send message" / "Queue message".
4. 좌석 초과 거절이 영어이고 숫자를 박았다: `profile-store.ts:90`
   ("…seats five Bots…") — `BOT_SEATS_PER_ACCOUNT`는 설정값이다. 라우틴 상한처럼
   사실 코드 + 표면 한국어로.
5. 일반 경로의 남은 영어: "Could not start the conversation."(홈·새 채널), "No matching
   commands" / "No agents in this channel"(`triggers.ts`), 스킬 폼 도움말과 "Saving…"
   (`skill-fields.tsx`), `edit-skill.tsx` 전체.
6. 승인 카드가 열 수 없는 페이지로 보낸다: "경계 설정에서 취소할 때까지" →
   `/admin/boundaries`는 비관리자를 `/`로 돌려보낸다.
7. 10분 만료가 보이지 않는다 — 카운트다운도 문구도 없이 카드가 사라진다.
8. 사장님이 직무를 고치려 여는 봇 프로필이 AG-UI 엔드포인트와 키를 묻는다
   (`agent-fields.tsx`).
9. 스킬 삭제에 확인이 없다(라우틴·봇 삭제에는 있다).
10. 환영 화면 첫 문장 "이 창을 닫아도 계속 일합니다"는 1:1 대화(브라우저 주도)에서
    거짓이다 — 루틴·룸만 참.
11. 오해를 부르는 사전 항목: "Time (UTC)"(지역 시각으로 바뀜), 렌더되지 않는 커넥터
    요약 둘.

### 5.7 알림과 승인 단말 — 사장님은 폰에 있다

PC 우선 순서를 바꾸지 않고도 "봇이 기다린다"가 사람에게 닿아야 제품이 된다. 세 다리:

| 다리 | 무엇 | 언제 |
|---|---|---|
| PC 셸 | OS 알림 + 배지 + 트레이 + 딥링크 → `/approve/:id` | 5.6(f)와 함께 |
| 웹 푸시 | **제외(모바일은 전용 앱)** | — |
| 알림톡 | "봇 ○○이 승인을 기다립니다 → 링크". 채널·템플릿 심사가 리드타임 | **보류(외부)** — 아웃박스에 어댑터 자리만 |

서버: `notifications` 아웃박스 테이블 하나(kind, botId, approvalId, deliveredVia, at)
+ 어댑터(OS 알림은 클라이언트 폴/소켓, 웹 푸시, 알림톡, 웹훅). `watch/notify.ts`는 이
아웃박스로 흡수. KPI "야간 승인 해소 시간"은 `approval.requested`→`decided` 시각 차로
즉시 잰다. 크기 M + 외부.

### 5.8 게이트 정직화

- **플로어는 워크스페이스별**: `test:ci`가 server·app·agent-computer·root 각각의 수를
  세고 각각의 플로어를 둔다. 죽은 스위트 6개는 삭제와 함께 플로어에서 뺀다.
- **테스트 DB 격리**: `openbot_test` 데이터베이스(같은 컨테이너)를 `scripts/test-ci.ts`
  가 만들고 마이그레이션 후 돌린다. CLAUDE.md의 "공유 DB" 규칙은 사라진다.
  `policy-durability`·`connector-admin`의 삭제는 그 순간 무해해진다.
- **없던 테스트**: `/api/computer` 라우트(타이핑·파일·비밀·정책·리셋의 인가와 감사),
  라우틴·룸·워치 HTTP, `x-openbot-bot-id` 부재 400, `devAuthEnabled`의 프로덕션 거부,
  MCP 경로 `settleWithoutAsking`, 승인 카드·봇 생성의 렌더 테스트, 비밀 입력 e2e
  (감사·녹화·응답·스레드 어디에도 없음).
- **잘못된 대상 교정**: append-only 트리거는 DB에서 UPDATE를 시도해 실패를 단언.
  `toBeDefined()` 단언 재작성. 영어 산문 단언은 코드 단언으로.
- **스모크 부활**: env 이름 통일, local 모드 기대, 실존 봇 생성 → 대화 → 컴퓨터 행동
  → 감사 행 → 승인 정지·재개까지. CI에 `docker compose up` 잡으로 매일 밤 + 태그에.
- **CI**: `agent-computer`를 워크스페이스로(typecheck 포함), 태그에도 CI, `images.yml`
  이 CI를 `needs`, `main` 보호. 크기 M.

### 5.9 배포·운영·문서

- **서명**: Apple Developer ID + 공증, Windows 코드 서명 인증서. `release.yml`에 배선.
  외부 구매 필요(§7-5). 없으면 PC 앱은 배포 불가.
- **릴리스 발행**: 드래프트를 발행하는 것을 태그 절차에 포함(또는 자동 발행). 셸 버전
  문자열을 저장소에서 관리.
- **`:stable` 승격**: 태그 → CI 통과 → 이미지 `:vX.Y.Z` → 카나리 VM(sajuhook) 1일 →
  `:stable` 승격(수동 디스패치). 모델 교체 의식과 같은 모양.
- **업그레이드 스크립트**: dump → pull → up → `/health`(정직한) → 실패 시 이전 태그로.
  compose에 `pull_policy: always`는 두지 않는다(의도치 않은 이동 방지) — 스크립트가
  명시적으로 pull.
- **compose**: `POSTGRES_PASSWORD`를 `.env`로, `logging: {max-size, max-file}` 전
  서비스, `web` 헬스체크, `REVIEW_MODEL`·`BOT_MODEL_EFFORT` 전달, `BOT_MODEL` 기본값
  단일화, 이미지 lockfile + `--frozen-lockfile` + bun 고정, Dependabot.
- **PIPA 수명주기**: 내보내기(`GET /api/me/export` — 대화·메모리·라우틴·감사 zip),
  계정 삭제(백업 포함 파기 절차 문서), 보존 일정, 운영자 접속기록(SSH 세션 기록 또는
  최소한 관리자 라이브 화면 열람의 감사 행). 위탁 계약·처리방침은 문서 작업 — 법률
  자문과 함께.
- **문서 청소**: §3.8 표의 거짓 13건 수정, `.env.example` 죽은 변수 삭제, PR 템플릿의
  "여러 프로세스" 문장 삭제, README 히어로 영상 교체, `docs/README.md`가 `docs/laf/`를
  색인, `routines.md`·`coworkers.md`를 `docs/laf/`로. **한국어 사용 설명서** 한 권
  (첫 봇 만들기, 승인이란, 가르치기, 루틴, 연결, 안 되는 것).

---

## 6. 실행 순서

원칙: 각 단계는 게이트 통과 + **눈으로 본 증명** 하나로 끝난다. 앞 단계가 뒤를 막지
않는 것끼리 묶었고, 크기는 한 사람 기준이다.

| 단계 | 기간 | 내용 | 끝났다는 증명 |
|---|---|---|---|
| **0. 약속을 참으로** | 1주 | 5.1(a)(d)(e)(f) 기본 ask·붙는 No·자동 리뷰·리셋 admin / 5.4(c)(d) 라우틴 소유권·좌석 잠금 / 5.8 테스트 DB 격리 + 죽은 스위트 삭제 / 5.4(a) 지식·커넥터·Intelligence 삭제 / 5.8 CI가 이미지를 게이트, 릴리스 발행 / 5.9 `REVIEW_MODEL` 전달 | sajuhook에서 출금 승인 버튼이 멈추고, "읽기는 묻지 마"가 실제로 통과시키며(감사 행 `autoReviewed`), 직원 계정이 남의 라우틴에 403, `bun run test:ci`가 앱의 정책 행을 지우지 않는다 |
| **1. 경계와 두뇌** | 2주 | 5.1(b)(c) 구조화 질문·정산 하나 / 5.2(a)(b)(c)(f) 프롬프트·툴 카탈로그·update_state 분할 / 5.2(e) 평가 거울화 | 승인 카드가 한국어 문장을 표면에서 조립하고, MCP 쓰기와 브라우저 클릭이 같은 `settle`을 지나며(계약 테스트), 평가가 프로덕션 프롬프트 해시를 찍고 27+새 시나리오 PASS |
| **2. 브라우저** | 2주 | 5.3 전부 / 5.2(d) 컨텍스트 예산 / 5.8 스모크 부활 + 픽스처 사이트 | 네이버 스마트스토어 주문 목록을 봇이 읽어 답하는 것을 화면으로 보고(실측표에 기록), `_blank`·alert·다운로드 픽스처 3종을 스모크가 매일 통과 |
| **3. 표면** | 2주 | 5.6(a)(b)(d)(e)(f) — 폰 레이아웃 제외 / 5.7 아웃박스 + PC 딥링크 / 5.4(f) health·미들웨어 | PC 셸은 창을 닫아도 트레이에서 알림을 내고, 알림을 누르면 `/approve/:id`에 착지한다. 야간 승인 해소 시간이 숫자로 나온다 |
| **4. 구조와 수명** | 2~3주 | 5.4(b)(e) 플러그인 분할·대화 저장 / 5.5 데이터 모델 / 5.9 서명·업그레이드 스크립트·PIPA 엔드포인트·문서 청소·사용 설명서 | 부팅이 스레드 전문을 안 읽고, 룸 전달과 라이브 턴이 겹쳐도 유실 0(테스트), 서명된 dmg가 다른 Mac에서 열리고, 내보내기 zip을 받아 본다 |

단계 0은 다른 무엇보다 먼저다. 지금 이 순간 실배포가 하는 약속과 행동이 다르기
때문이다. 단계 3의 서명·알림톡은 외부 리드타임이 있으므로 **신청은 오늘**.

---

## 7. 결정 — 2026-09-02 권고대로 채택됨

아래 권고가 그대로 결정이 됐다(§0 아래 결정 메모). 외부 항목 4·5는 보류.

1. **승인·반복 상태의 자리** — 메모리 변형(결정 기록대로) vs DB 변형(재시작 생존).
   권고: 대기 질문·반복 카운트는 메모리, 상시 허용·정책은 DB. 재시작 시 대기 질문이
   사라지는 것은 "봇이 다시 묻는다"로 허용. DB 변형과 그 docstring 삭제.
2. **`watch/`·다이제스트** — 유지(플래그 뒤, 깨우기를 HTTP 자기 호출 대신 러너 직접
   호출로) vs 삭제. 권고: Tier A 고객이 생길 때까지 삭제. M0 증거는 git 태그가 지킨다.
3. **국내 추론 전환 트리거** — plan-saas는 M2. 권고: "사장님 본인이 아닌 첫 사용자"가
   생기는 순간. 그 전까지 sajuhook 외 배포 금지를 문서에.
4. **알림톡 채널·템플릿 신청** — 외부 리드타임. 권고: 오늘.
5. **Apple Developer / Windows 코드 서명 구매** — 외부. 권고: 단계 3 전.
6. **봇 5개** — 유지 vs 플랜별. 권고: 유지, 단 `BOT_SEATS_PER_ACCOUNT`를 compose에.
7. **감사·대화 보존 기간** — PIPA와 원가. 권고: 감사 1년, 대화 무기한(사용자 삭제 시
   파기), 백업 30일.
8. **테이블 이름(`agent_id` vs `bot_id`)** — 권고: 안 바꾼다.
9. **Postgres 비밀번호·`KEY_ENCRYPTION_KEY` 재키잉** — 권고: 비밀번호는 `.env`로 지금,
   재키잉은 설계만(전 행 재암호화 스크립트) 단계 4.
10. **`dry-run` 모드·`settleWithoutAsking` 컨트롤** — 그릴 것인가 지울 것인가. 권고:
    `settleWithoutAsking`은 관리자 화면에 그린다(배포가 "사람 없이 정산 금지"를 선언할
    유일한 길), `dry-run`은 지운다.

---

## 부록 A. 검증 상태

| 주장 | 방법 |
|---|---|
| 기본 정책 allow-all, 자동 리뷰 `maxTokens: 200`, 프롬프트 한글 0·무변경, compose 자원 상한 0, popup/dialog 핸들러 0 | 직접 grep/sed |
| 라우틴 소유권 미검사, 깨우기 무인증 fetch, `computers/reset` requireUser, 부팅 전량 로드, 좌석 트랜잭션 | 직접 sed |
| 32개 직무 제안이 `t()`를 거치고 테스트가 표를 걷는다(하위 보고의 반대 주장은 **틀렸다**) | 직접 grep |
| CI 1333/1290, 릴리스 드래프트, `latest.json` 0.2.0, 시크릿 목록, `main` 보호 없음 | 하위 보고가 `gh`·`curl`로 측정 |
| 나머지 [확인] 항목 | 하위 감사 보고 5건(게이트웨이, 플러그인, 에이전트·러너, 인증·채널·워치, DB, 테스트, 앱 성능·죽은 코드·모바일, 인프라)이 `path:line`으로 인용 — 이 문서에 인용을 옮겨 적었으나 실행으로 재지는 않았다 |
| 한국 사이트 동작, 웹뷰 로그인, OAuth CSRF, 스냅샷 경쟁 | [추정] — 단계 2·3의 첫 작업이 재는 것 |

## 부록 B. 이 문서가 다루지 않는 것

가격·과금 단위, 지원사업 서류, 법률 자문의 내용, laf-control(별도 저장소). 그리고
"무엇을 더 만들까"는 다루지 않았다 — 있는 것을 약속대로 만드는 것이 먼저다.

---

## 진행 기록

| 일시 | 병합 | 내용 | 게이트 |
|---|---|---|---|
| 2026-09-02 | 8b12d3a | 테스트 DB 격리(`<db>_test` + `LAF_TEST_DB_SUFFIX`), 워크스페이스별 플로어 | 1333 |
| 2026-09-02 | 6827c0c | 앱 죽은 코드 삭제(orb·/bot·미사용 의존성), 전역 폴링 범위·백그라운드 정지, 제어 폴 안정화, 감사 페이지네이션, 채널 로더, 셸 알림 권한 | 1352 |
| 2026-09-02 | 4209605 | 지식 플레인·커넥터 스텁·Intelligence 모드·워처 삭제, 테넌트 패키지 감량, 마이그레이션 0024(테이블 10개·pgvector 제거, 패키지 봇 해제), `postgres:17` | 1295 |
| 2026-09-02 | 111696d | 라우틴 소유권(404)·놓친 창 규칙·틱 겹침 가드·계정별 상한·토큰 해시 비노출, 좌석 advisory lock | 1321 |
| 2026-09-02 | 6d8fd1f | 문서 진실화(README·architecture·configuration·development·PR 템플릿), 한국어 사용 설명서 | — |
| 2026-09-02 | b5b42ae | CI가 `:stable`을 게이트(checks.yml 재사용), agent-computer 워크스페이스화, 재현 가능한 이미지, Dependabot, compose 강화(비밀번호·로그 상한·web 헬스체크·손잡이 전달·자원 상한), 정직한 `/health`, `scripts/upgrade.sh` | 1328 |
| 2026-09-02 | aa23151 | 기본 `ask`·`deny` 정책 출하, 붙는 No(30분), 자동 리뷰 수리(실측: 200토큰 상한 → 빈 답; 상한 제거 + 낮은 추론 → 1.3초 판정) + 부팅 프로빙으로 `/api/me.autoReview`, 리셋 admin 전용, `dry-run` 제거, `settleWithoutAsking` 관리 스위치, describe-point 텍스트 제거 | 1376 |
| 2026-09-03 | cb9eb17 | §7-1 반영: 승인 대기·반복 카운트는 메모리(DB 변형 삭제, 마이그레이션 0025로 테이블 3개 DROP), 룸의 승인 대기는 폴링 대신 `waitFor` 프로미스(실측: 승인 조회 20회에 DB 문장 0개, 이전 40개), LISTEN/NOTIFY 제거(커밋 후 in-process 전달), "여러 서버" 주석 일소, deployment-model.md에 프로세스 내 상태 전체 목록 | 1350 |
| 2026-09-03 | c0daf29 | 플러그인 스토어 5분할(공개 표면 바이트 동일), 금고 오류 타입화, MCP 호출 리다이렉트 거부(`laf:mcp_redirect_refused`, 실측: 첫 서버에 토큰이 나갔고 리다이렉트 대상은 아무것도 못 받음), 호스트 판정 하나(DNS 해석 포함 — `localtest.me`가 127.0.0.1로 풀려 거부됨), OAuth state 1회용 | 1397 |
| 2026-09-03 | 3a07927 | 봇 두뇌 v2: 한국어 프롬프트 합성(`shared/prompt/`, 모드별·날짜·시간대·봇 ID 주입, 실측 778→934 토큰 — 글자는 63% 줄고 토큰은 20% 늘었다), 툴 카탈로그 하나(`shared/tools/`, 한국어 설명 — 평가 12/12×3 PASS), `update_state`→`update_profile`+`manage_routine`, `remember` 비밀 필터, agent-bot 컨텍스트 예산·잘림·빈 답 처리·120초 타임아웃, 평가가 프로덕션 프롬프트·툴을 import하고 해시를 기록, `report_refusal`·`BuiltInAgent` 삭제 | 1439 |
| 2026-09-03 | 09911a1 | 데스크톱 셸: 트레이·닫기→트레이·자동 시작·`lafagent://` 딥링크·단일 인스턴스·`/approve/:id` 착지, 알림이 목적지를 기억(플러그인에 데스크톱 클릭 콜백 없음 — 다음 전면 시 이동), Overlay 타이틀바, `minWidth` 1024, `cargo check`가 typecheck. **발견**: 원격 오리진 앱 명령에 ACL 매니페스트가 없어 배지·외부 링크가 번들 빌드에서 한 번도 실행된 적 없었음 → 수리. 미측정: 웹뷰 내 1차 로그인 | 1448 |
| 2026-09-03 | 6a99045 | 테스트 정직화: `/api/computer` 30개 라우트 전수(권한·게이트웨이·비밀값 부재 3종), 헤더 계약, 프로덕션에서 dev 인증 거부, MCP 경로 `settleWithoutAsking`, append-only 트리거 실증, 동어반복 재작성, 스모크 부활(실스택 3회 7/7: 출하 정책이 결제 버튼을 멈추고 승인 후 통과, 거절 후 `declined_recently`) + 야간 워크플로. **발견**: 봇이 `computer_type`에 넣은 텍스트가 대화 저장소에 그대로 남는다(후속) | 1483 |
| 2026-09-03 | 7732f0f | 대화 저장소 하나: `laf_thread_messages`(append-only, 스레드별 advisory lock으로 seq, 메시지 id 유니크로 재도착은 갱신), 쓰기 함수 하나, 부팅 전량 로드 제거(실측: 두 번째 턴이 4행 재작성 대신 2행 추가), 런 원장 쓰기 하나, 마이그레이션 0026(스냅샷 270건 → 메시지 270행 19스레드 동일, `channel_threads` 개명, FK 7개, enum 3개, 인덱스 3개, `daily_local`), jsonb 타입 하나. 병합 후 옛 테이블을 부르던 테스트 둘 수리 | 1495 |
| 2026-09-03 | fd468b6 | 대화 가림: 비밀 필드로 거절된 `computer_type` 텍스트와 결과 없이 끝난 런의 비밀 패턴은 저장 시(`appendMessages`)와 읽기 시(러너의 프로세스 전역 메모리 사본) 모두 `[redacted: secret field]`, 재도착해도 원복 안 됨. **발견**: `server/tests/**`가 타입 검사 밖(후속) | 1516 |
| 2026-09-03 | fa585be | 표면: 봇 한 단어(에이전트·코워커·어시스턴트 → 봇, 키 26개 개명), 비관리자에게 admin 진입점 0·프로필의 엔드포인트/키는 관리자 '고급' 뒤, 남은 영어 일소, 직무 제안을 업무 패턴 8종 × 4로 재편(연결 힌트), 좌석 거절 `laf:seats_full`, 스킬 삭제 확인, 환영 문장 정정, 셸 상단 여백을 설정·관리 화면에도. 사용하며 잡은 결함 3(첫 실행이 넘어가지 않음, 잘못된 요일 행 하나가 라우틴 화면 전체를 떨어뜨림, 스킬 삭제 대화상자). 스레드 ID: 이미 서버가 계정별로 발급하고 있었고 localStorage 모듈은 죽은 코드 → 삭제 | 1532 |
| 2026-09-03 | 67fba08 | 브라우저 현실화: ko-KR·Asia/Seoul·헤드리스 표식 없는 UA, 살아 있는 본문 + iframe 병합 + settle 대기, 새 탭 채택·`computer_switch_tab`, 다이얼로그 사실 코드, 다운로드→워크스페이스·`computer_upload_file`(기본 ask), 헤더 필수(400 `laf:bot_header_missing`, `shared`/`default` 폴백 삭제), 인계 한글 IME(숨은 편집 필드), 제어 상태 파일 보존, 10분 유휴 종료(재오픈 ~100ms), 자원 상한. **실측**(컨테이너, 로그인 없음): 스마트스토어 0→1,403자·0→41 요소, 네이버 1,696→3,406자·본문 마커 1/4→4/4, 홈택스 오류→222~519자, 배민 사장님 331→2,407자. `docs/laf/browser-limits.md`. CI에 Chromium 설치 단계 | 1575 |
| 2026-09-03 | 9559450 | 정산 절차 하나(`computer/settle.ts`, 브라우저·파일·MCP가 같은 순서: 제시된 승인 → 붙는 No → `settleWithoutAsking` → 상시 허용 → 자동 리뷰 → 질문), MCP도 자동 리뷰·반복 카운트, 질문은 구조(`AskSubject`: kind·intent·host·element·file·tool·reason)로 — 영어 문장 조립기 삭제, 표면이 한국어로 조립(을/를 조사 계산, 20 행동 × 5 사유 표 테스트), 거절도 코드, 승인 카드 카운트다운("10분 남음"), 비관리자에게 경계 링크 없음, 마이그레이션 0027(상시 허용 `question`→`subject` jsonb). 실측: 로컬 픽스처에서 "‘출금 승인’을 누르려 합니다" 카드 → 이번만 허용 → 클릭 통과 → 거절 → `declined_recently`. 병합 시 `upload` 의도를 주체 타입·문장 표에 추가, `approvals.ts`의 실제 NUL 바이트를 이스케이프로 | 1605 |
| 2026-09-03 | b28e376 | PIPA 수명주기: `GET /api/me/export`(스트리밍 JSON, 자격증명·토큰·타인 행 제외, 상한 명시), `POST /api/me/delete` + 관리자 삭제(브라우저 프로필 리셋 → 연결 회수 → 트랜잭션 삭제 순서, FK 표, 감사 행은 가명화), append-only 트리거에 이름 붙은 출구 둘(`audit_pseudonymise_actor`, `audit_purge_before`; 일반 UPDATE/DELETE는 여전히 거부), 보존 틱(`AUDIT_RETENTION_DAYS` 365, 6시간마다), 설정의 계정 페이지, `docs/laf/data-lifecycle.md`, 마이그레이션 0028. 실측: 두 번째 사용자 삭제 후 테이블 카운트·가명화 2건·본인 데이터 무손상. 발견: 내보내기가 중간 실패 시 200 + 잘린 JSON → 닫는 괄호를 마지막에만 써서 잘린 문서가 무효가 되게 | 1626 |
| 2026-09-03 | ed3cd10 | 실스택 확인: 재빌드한 `agent-computer` 이미지 + 소스 서버·agent-bot(glm-5.3-flash)으로 스모크 여정 7/7 — `/health`가 database·agentBot·computer 모두 ok, 출하 정책이 결제 버튼을 멈추고 승인 후 통과, 거절 후 `declined_recently`, 루틴 답이 논스를 담음. 로컬 개발 DB의 어긋난 마이그레이션 상태 복구(백업 후 0026 수동 적용, 0028은 drizzle) | 스모크 7/7 |
| 2026-09-03 | 7c95846 | 알림 아웃박스: `laf_notifications`(마이그레이션 0029), 쓰기 하나 `enqueue`, 어댑터 socket(접속자 있을 때만)·webhook(기존 `LAF_NOTIFY_WEBHOOK_URL`)·알림톡(자리만, `LAF_ALIMTALK_*` 구멍), 앱 내 문 `GET /api/me/notifications`·`seen`, 소켓 프레임 `kind:"notification"`, 승인 답·만료·도움 요청·라우틴 완료가 행을 남김, 30일 보존, KPI `GET /api/admin/metrics/approvals`(중앙값·p90·야간 중앙값·미답). 실측: "bot-verify-10이(가) 기다립니다 — example.com에서 '결제하기'를 누르려 합니다" 한 번만, 답하면 `seen_at`. 발견: 감사 워처가 dev 배우의 빈 `actorUserId`를 읽어 아무에게도 안 알림 → `payload.actor` 우선 | 1668 |
| 2026-09-03 | c49b7cf | 게이트 정리: 테스트 디렉터리 4곳이 `tsc`에 편입 — 숨어 있던 오류 83개(아무것도 단언하지 않던 초록 테스트, 실물과 다른 스텁, 잘못된 인자) 수리, 플로어 실측 −3%(server 1149·app 227·agent-computer 128·root 72), 연결·봇 입력 거절에 `laf:` 코드 + 표면 한국어, `mcp.call_repeated` 감사 행·라벨, 역순·재실행 플레이크 스윕(느린 브라우저 테스트가 이웃을 죽이던 것 수리). 병합 후 아웃박스 테스트의 fetch 캐스트 1건을 헬퍼로 | 1669 |
| 2026-09-03 | 0b09a09 | **main 병합·발행**: `laf/redesign` → `main`(38e5bd3), 드래프트 v0.3.0~0.3.2 발행, v0.4.0은 이미지 실패(웹·서버 이미지에 `shared/` 누락, 서버 이미지는 실행 시 import 사망) + 보안 감사 지적 → Dockerfile·`images.yml`(잡별 권한, env 경유, `$/` 문법)·Dependabot 쿨다운 수리(5a4bb1d), sajuhook 흔적 제거·와일드카드만 지원(d1bd783), 탈퇴·가입이 함대에 닿는 HMAC 웹훅(0b09a09) → **v0.4.1**: CI·Images·Release 전부 성공, `:stable` 이동, 업데이터 0.4.1. **함대**: 오사카 `laf-m0`+볼륨+VCN 삭제(자원 0), sajuhook VM은 `laf destroy`로 마지막 덤프→종료→명부 archived, DNS·정문 라우팅 제거, 백업 버킷 30일 만료. 남은 클라우드는 서울 `laf-entry` 1대 | 1688 |
| 2026-09-03 | — | **함대 수명주기 가동**: laf-control(cd1f8da 푸시)에 `laf destroy`·`reconcile`·`member remove`·accounts 신호, 가입·결제→서울 A1 1/6(춘천 폴백, 오사카 금지) 개통, 탈퇴(남은 계정 0)→즉시 파기, HMAC 이벤트 문 `POST /api/fleet/events`; 함대 API를 backend 박스에 배치(`laf backend api`: SG 443, `fleet.agent.laf-co.com`, systemd+Caddy, 실측 health 200·무서명 POST 401·80 닫힘). 개통이 고객 VM `.env`에 웹훅 URL·시크릿을 심음. GoDaddy의 `sajuhook.com` A·www 레코드 삭제 | — |
| 2026-09-03 | d430c04 | **사이트 연결**: 사람이 봇 브라우저에서 한 번 로그인한 곳을 봇이 기억 — 카탈로그 17곳(`shared/sites/catalogue.ts`, `siteForUrl`·`signedIn` 판정), 게이트웨이 `navigate` 훅, `laf_site_connections`(0030, `connected_at` 불변·로그인 벽은 기존 행만 표시), `GET /api/sites/connections`·`POST /api/sites/:siteId/check`, 연결 화면 카드, user-guide §6. 입력한 글자가 행·감사에 없음을 직렬화로 단언(테스트 9). 소유자 어휘 테스트가 "경계"를 잡아 문구 교체 | — |
| 2026-09-03 | d30b506 | **원클릭 연결(OAuth 릴레이·공용 클라이언트)**: 함대의 OAuth 앱 하나가 모든 VM에 닿음 — `LAF_OAUTH_RELAY_URL`, redirect_uri는 앱 단위(`…/oauth/relay/google` 하나로 구글 5종), state `<slug>.<sealed>`(슬러그는 아무것도 보증하지 않음), `GOOGLE_OAUTH_*`(로그인 쌍과 동일)·`CAFE24_*`, slug는 `PUBLIC_ORIGIN`에서 유도·제품 도메인 밖이면 부팅 거부. 카탈로그 5종(시트 4·지메일 4·캘린더 2·비즈니스 프로필 3·카페24 5 툴, `guardedTools`: 덮어쓰기=destructive, 발송·일정·리뷰 답글·주문 상태=external). 연결 화면이 "연결 가능한 카탈로그"를 그림(관리자 목록 아님), 카페24만 몰 ID 칸. 실측(스텁 릴레이+가짜 토큰 엔드포인트): 동의·교환이 같은 redirect_uri, state 재사용 거절, 해제→행 삭제+revoke. 잡은 버그 2: `/connections`가 모든 엔트리에 호스트 첫 라벨을 `instanceName`으로 실어 보냄, `AUTH_PROVIDERS=laf`+`GOOGLE_OAUTH_CLIENT_ID`면 서버 부팅 불가(함대 VM의 바로 그 조합). 게이트 1794(server 1318·app 269·agent-computer 132·root 75). laf-control 6fd1b6e: `/oauth/relay/:provider`, `laf origins sync`, `laf env push` | 구글 restricted scope 심사(`drive.readonly`·`gmail.*`) 전에는 테스트 사용자만; 메타(인스타·카카오 채널)는 브라우저 경로 |
| 2026-09-04 | b45bbd3 | **파트너 연결(알림톡·세금계산서)**: LAF가 벤더의 고객, 각 사업장은 우리 화면에서 그 아래 등록 — 키를 받는 사람은 없다. 알림톡=솔라피(LAF 대행 키): 채널 검색 ID→인증번호→연결, 표준 템플릿 4 등록·검수 상태 표시, `alimtalk_send`=external. 세금계산서=팝빌(LAF LinkID): SDK 없이 Linkhub 인증(HMAC-SHA256 6줄 정규 문자열+본문 SHA-256, 세션 토큰 사업자번호별 캐시·2분 여유, 테스트/운영은 호스트가 아니라 서비스 ID), 회원 `laf-<사업자번호>`·비밀번호는 발급만 하고 저장 안 함, 인증서는 팝빌 팝업(`GetTaxCertURL`)을 사람이 직접, `taxinvoice_issue`=**money**(저장소 유일). 마이그레이션 0031, `/api/partners`(env 없으면 목록에서 제외, 반쪽 쌍은 부팅 거부), 파트너 트랜스포트는 `createPluginStore` 옵션(순환 의존 차단), 연결 시 모든 봇에 grant·해제 시 회수, 계정 삭제 시 파트너 정리, 아웃박스 알림톡 문(승인 요청이 소유자 휴대폰으로 실제 발화). 실측(가짜 솔라피·Linkhub·팝빌): Linkhub 서명 재계산 일치, 409 `guard`→승인→발송(`#{상호}` 치환)·`X-HTTP-Method-Override: ISSUE`. 잡은 버그: `normalizePhone`이 11자리(모든 010)를 거절, 파트너 호출의 `reachedAs`가 "deployment"로 거짓 기록, 해제가 `plugin_grants`를 남김. 게이트 1860(server 1373/플로어 1331·app 280/271·agent-computer 132·root 75) | 라이브 키로만 확인 가능한 것은 `SOLAPI_UNVERIFIED`·`POPBILL_UNVERIFIED` 데이터로 보관(connections.md가 출력): 발신프로필 키 필드명·카테고리 필수 여부·검수 결과 필드, 타 LinkID 기가입 사업자 수용 여부(거절은 그대로 표면화, 행 미기록) |
| 2026-09-05 | ae403e7 | **연결 안정화**: 죽은 연결이 "연결됨"으로 남던 것 — `mcp_user_credentials`에 `last_ok_at`·`last_failure_at`·`last_failure_code`(0032, 토큰 회전과 같은 트랜잭션에 기록), `connectionsFor`가 `health{status: ok|needs_reconnect, lastOkAt, lastFailureAt, failureCode}` 반환(`revoked`·`refresh_failed`만 재연결, `vendor_down`은 유지, `invalid_client`는 배포 전체의 일이라 행에 안 씀 — 기존 회복 테스트 2개가 잡음). 봇의 영어 거절 한 줄 → `code` 우선 읽기(app·unattended) + `tool-results.ko.ts` 72개 코드, `laf:needs_reconnect`는 벤더 호출 0회로 거절. 설정에서 연결하면 모든 봇에 툴 갱신·부여, 해제 시 회수(`offerToolsTo`/`withdrawToolsFrom`, `botsOwnedBy` 파트너와 공유). 데스크톱 복귀: `returnTo=shell` → 세션 없는 `GET /connected`(Caddy·Vite 경로 추가) + `lafagent://connected/<id>` 딥링크 허용(Rust 테스트 7). 실패 사유 토큰 5종에 한국어. 실측: 가짜 벤더 `invalid_grant` → 행 기록 → needs_reconnect → 거절 → 재연결 → 회복, 시트 툴 4×봇 2 부여/회수. 게이트 1906(server 1407·app 289·agent-computer 132·root 78) | `lafagent://` 왕복은 번들 미설치라 미관측 |
| 2026-09-05 | 337fa0f | **연결 화면 재구성**: 세 가지 연결이 "한 줄 + 스위치" — 켜면 동의 창·인라인 폼·봇 브라우저 핸드오프, 끄면 한 번 묻고 해제(사이트는 `DELETE /api/sites/:siteId/connection` 신설, 브라우저 로그인은 남는다고 말함). 상태 6종, 설정 사이드바 "연결", 스켈레톤·다시 시도, 없는 것은 안 그림. 요청 4→1(`GET /api/connections/overview`, `health` 방어적 읽기), staleTime 15s·포커스 갱신·대기 중에만 3s 폴링. 원문 스코프 → 한국어 능력 한 줄, "관리자" 문구 제거, `laf:` 코드→문장. 조종권 인수 실패·503 무시·인증서 팝업 차단 수리. 눌러서 잡은 버그 3: 취소해도 폴링이 5분 지속, 동의가 끝나도 행이 "동의 중"에 머묾, 백그라운드 재조회 실패에 화면 전체가 빨간 줄(`isError && !data`). 합친 게이트 1937(server 1419/플로어 1376·app 308/298·agent-computer 132·root 78) | 실제 구글 동의 완료·`needs_reconnect` 화면은 라이브 키로 확인 |
| 2026-09-05 | 99cc7a1 | **세금계산서(팝빌) 삭제**(김기범 결정): `server/src/plugins/tax/` 1,621줄·`/tax-invoice/*`·카탈로그 엔트리(저장소 유일의 `money` 층 툴 — 가드 층 자체는 유지)·`PARTNER_PROVIDERS`·`POPBILL_*` 파싱, 앱의 TaxRow·쿼리·복사표·i18n 24건, `tool-results.ko.ts` 블록, `.env.example`·compose·문서. 마이그레이션 0033은 `provider='tax-invoice'` 행만 삭제(파트너 테이블은 처음부터 범용이라 컬럼 없음; 실측 DELETE 1, 알림톡 행 생존). 실측: 키 있으면 파트너 카드 알림톡 1개, 없으면 0개, `/api/partners/tax-invoice/connect` 404. 게이트 1908(server 1393/플로어 1350 — 지운 26개만큼만 내림·app 305·agent-computer 132·root 78). laf-control 50c95ae에서 팝빌 키 그룹 제거, 소유자 양식·`.env`에서도 삭제 | 홈택스 사이트 연결과 "세금계산서 PDF" 예시 문장은 팝빌과 무관하므로 그대로 둠 |
| 2026-09-05 | ebcf06a | **설정 화면 다듬기**(Grok 기준: 얕고 적게, 손댈 수 있는 것만): 사이드바 정확 활성(`exact`)·폭 340→280(관리자도)·죽은 `--sidebar-width-mobile` 제거, `lg` 아래에서는 레일 대신 가로 탭(`RailNav`, 관리자 9개 링크도 동일), 알림 행의 "이 환경에서는 알림을 켤 수 없습니다" 상태, 언어 변경 "바꾸면 화면을 다시 불러옵니다"(팝업 닫힌 뒤 적용 — `onOpenChangeComplete`가 합성 없는 창에서 안 오고 `onOpenChange`가 같은 배치라 타이머로), 탈퇴 확인란에 입력할 이메일 표시·정확히 일치할 때만 활성, 내보내기 "준비하는 중…" 4초, 계정 행 스켈레톤, 중복 연결 행 제거. `PersonAvatar`(이미지 → 실패 시 이니셜, 한글 첫 음절, 이메일 해시 8색) 신설 — 설정 계정 행·사이드바 푸터. 앱 워크스페이스 첫 React 렌더 테스트 3파일(happy-dom). 실측: 1200/900/700/420px, 삭제 버튼 7케이스, 언어 왕복. 게이트 1952(server 1393·app 349/플로어 341·agent-computer 132·root 78) | `/api/me`에 로그인 제공자가 없어 계정 행에 제공자 표기는 보류 |

남은 것: `run.failed` 알림 생산자, 관리 화면의 승인 KPI 표시, 라우틴 실행 오류 문장의 코드화, 관리자 삭제 화면, 백업 30일 파기(함대 도구), 웹뷰 내 1차 로그인 측정, 코드 서명(외부), 알림톡 어댑터 실구현(외부), 국내 추론 전환(외부). 미루기로 한 것: 첫 방문 호스트 ask(§5.1 a-5).
