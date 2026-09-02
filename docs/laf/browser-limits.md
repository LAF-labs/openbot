# 봇의 브라우저가 못 하는 것 — 그리고 실제로 되는 것

봇은 컨테이너 안의 크로미움 하나를 몬다(`agent-computer`). 사람이 쓰는 브라우저와
거의 같지만, **구조적으로 안 되는 일**이 있다. 안 되는 것을 적어 두는 편이,
안 되는 줄 모르고 시키는 것보다 낫다.

아래 숫자는 전부 **실측**이다. 사이트 표는 2026-09-03에 손으로 한 번 잰 것이고,
픽스처 표는 `agent-computer/tests/korean-sites.test.ts`가 매번 다시 잰다.

---

## 1. 안 되는 것 — 사람에게 넘겨야 한다

| 무엇 | 왜 | 봇이 해야 하는 일 |
|---|---|---|
| **공동인증서·금융인증서 로그인** | 인증서는 사람의 기기(또는 USB·클라우드 저장소)에 있고, 브라우저 밖 프로그램이 서명한다. 컨테이너에는 그 프로그램도 인증서도 없다. | `computer_request_help`로 사람에게 인계 |
| **보안키패드(마우스로 누르는 숫자판)** | 은행·카드사가 키 입력을 가로채지 못하게 만든 것이다. 자동 입력을 막는 것이 그 물건의 목적이므로, 우회하면 안 되고 되지도 않는다. | 인계 |
| **캡차(CAPTCHA)** | 사람인지 확인하는 장치다. 봇이 통과하려 해서는 안 된다. | 인계 |
| **결제 인증창 / 간편결제 비밀번호** | 대개 별도 창이거나 앱으로 넘어가고, 승인은 사람의 판단이다. | 인계 |
| **`확인/취소` 창의 '확인' 누르기** | 브라우저가 띄우는 `confirm`은 봇이 대신 누르지 않는다. 내용은 `laf:dialog`로 알려 주고 **취소**를 누른다. `정말 삭제하시겠습니까?`에 예라고 답하는 것은 사람의 자리다. | 인계 |
| **휴대폰 본인인증 / 문자 인증번호** | 문자는 사람의 폰으로 온다. | 칸 하나면 `computer_request_secret`, 여러 단계면 인계 |
| **카메라·마이크·파일 탐색기 열기** | 컨테이너에 장치가 없다. 파일은 봇의 작업 공간에서만 올린다(`computer_upload_file`). | 필요한 파일을 먼저 작업 공간에 두기 |
| **1MB를 넘는 파일 내려받기** | 작업 공간 쓰기 한도와 같은 값이다. 넘으면 저장하지 않고 지운 뒤 `laf:download_too_large`로 알린다. | 사람이 직접 받기 |

### 조심할 것 하나 — 쿠키는 볼륨에 평문에 가깝게 있다

컨테이너에는 데스크톱의 키링이 없어서 크로미움을 `--password-store=basic`으로
띄운다. 로그인 쿠키는 `agent-profiles` 볼륨을 읽을 수 있으면 읽힌다. **1인 1VM**
(`deployment-model.md`)이기 때문에 감수하는 것이고, 볼륨 권한이 곧 그 경계다.
여러 사람이 한 VM을 쓰는 구성으로 바꾸면 이 문장이 먼저 거짓이 된다.

---

## 2. 되는 것 — 무엇이 어떻게 되는가

- **한국어로 뜬다.** 로케일 `ko-KR`, 시간대 `BOT_TIME_ZONE`(기본 `Asia/Seoul`).
  실측: 고치기 전에는 `navigator.language`가 `en-US@posix`, 시간대가 `UTC`였다.
- **헤드리스 표식이 없다.** UA에서 `HeadlessChrome`가 사라졌다(→ `Chrome/151…`).
  자동화 티가 가장 싸게 나는 신호 하나를 없앤 것이지, 탐지를 뚫는 것이 아니다.
- **새 탭을 따라간다.** `target=_blank`로 열린 탭이 곧 봇이 보는 탭이 되고,
  스냅샷의 `tabs`에 전부 나온다. `computer_switch_tab`으로 옮긴다.
- **경고창을 듣는다.** `alert`은 확인을 눌러 주고, `confirm`·`prompt`는 취소를
  누른 뒤 **내용을 그대로** 다음 툴 결과에 실어 준다(`laf:dialog`).
- **내려받고 올린다.** 내려받은 파일은 `작업공간/downloads/`에 이름 그대로
  저장된다(같은 이름은 `(2)`가 붙는다). 올릴 때는 작업 공간 안의 파일만 된다.
- **iframe 안을 읽는다.** 같은 출처의 iframe 본문은 페이지 본문에 합쳐지고,
  **그 안의 버튼도 눌린다** — 실측: 스냅샷이 프레임 안 버튼을 `f1e4` 같은 ref로
  주고, 그 ref로 클릭이 실제로 동작했다. 못 읽는 프레임은 `laf:frame_opaque`로
  알린다(결제창·인증창이 대개 그렇다).
- **10분 쉬면 브라우저를 닫는다.** 쿠키는 볼륨에 남으므로 로그아웃되지 않는다.
  다시 여는 데 드는 시간 — 실측: 컨텍스트 실행 **124\~136ms**, 컨테이너에서
  `navigate`까지 포함해 **637\~776ms**(닫지 않았을 때 700ms와 사실상 같다).

---

## 3. 실제 사이트에서 잰 것 (2026-09-03, 로그인 없이 첫 화면만)

`computer_navigate` → `computer_read` → `computer_snapshot`을 순서대로 부른
결과다. **고치기 전 / 고친 뒤**이고, 로그인은 하지 않았다.

| 사이트 | 본문 글자 수 | 본문이 실제로 있나 | 누를 수 있는 것 |
|---|---|---|---|
| `smartstore.naver.com` (→ `sell.smartstore.naver.com/home`) | **0 → 1,403** | 아무것도 없음 → 로그인 벽이 그대로 보임(`로그인하기`·`가입하기`·`네이버 커머스 ID 알아보기`) | **0 → 41** |
| `www.naver.com` | **1,696 → 3,406** | 스킵 링크뿐(뉴스·메일·카페 없음) → 뉴스·메일·카페·쇼핑 모두 보임, iframe 6개 본문 합쳐짐 | **130 → 200**(상한에 걸려 잘림) |
| `www.hometax.go.kr` (→ WebSquare 셸) | **502 오류 → 222\~519** | 아예 못 읽음(“Execution context was destroyed”) → 로그인·인증센터·전체메뉴·근로장려금까지 읽힘. 실행마다 다르고, 부족하면 `computer_read`를 한 번 더 부르면 된다 | **0 → 16\~57** |
| `ceo.baemin.com` | **331 → 2,407** | 줄바꿈 하나 없이 메뉴만 이어붙은 331자 → 사람이 보는 화면 그대로(줄바꿈 259개) | **43 → 101** |

읽을 것: 스마트스토어의 0자는 SPA 셸을 `domcontentloaded`에서 바로 읽어서 나온
숫자이고, 배민의 331자는 `<body>`를 **복제한 뒤** `innerText`를 읽어서 나온
숫자다(분리된 노드의 `innerText`는 `textContent`와 같아서 줄바꿈이 없고 숨은
메뉴가 섞인다). 홈택스의 502는 셸이 리다이렉트하는 도중에 읽어서 났다.

한글 렌더링은 이미지에서도 정상이다(스크린샷으로 확인). 인증 화면의
`공동·금융인증`·`간편인증`·`아이디 로그인` 세 갈래가 그대로 보이며, 앞의 둘은
위 1절대로 사람 몫이다.

### 다시 재는 법

```bash
docker compose build agent-computer
COMPUTER_TOKEN=laf-local-dev docker compose up -d agent-computer
# 헤더 없이는 400이 돌아온다. 봇 이름을 반드시 준다.
curl -s localhost:4100/navigate -X POST \
  -H 'content-type: application/json' \
  -H 'x-openbot-computer-token: laf-local-dev' \
  -H 'x-openbot-bot-id: measure-bot' \
  -d '{"url":"https://www.naver.com/"}' | head -c 400
```

로그인은 하지 않는다. 위 표는 관찰이지 계정 사용이 아니다.

---

## 4. 픽스처 — CI가 매번 확인하는 것

실제 사이트는 매주 바뀌고 새벽에 접속이 막히기도 하므로, 위에서 깨졌던 것들을
한 페이지에 모아 둔 픽스처가 테스트다(`agent-computer/tests/fixture-site.ts`).
`target=_blank` 링크, `alert`, `confirm`, 파일 입력, 다운로드 링크, 같은 출처
iframe, 비밀번호 칸, 그리고 화면에 없는 2,000자짜리 메가메뉴가 들어 있다.

`agent-computer/tests/korean-sites.test.ts`가 **진짜 `src/index.ts`를 띄워** 그
페이지를 헤더와 함께 HTTP로 몬다. 크로미움이 없는 체크아웃에서는 건너뛴다:

```bash
bunx playwright install chromium   # 없으면 이 파일의 13개가 skip된다
```

---

## 5. 봇이 받는 사실 코드

전부 `shared/prompt/tool-results.ko.ts`에 한국어가 있다. 서버와 컨테이너는 코드만
보내고 문장은 거기서 붙는다.

| 코드 | 언제 |
|---|---|
| `laf:dialog` | 페이지가 `alert`/`confirm`/`prompt`를 띄웠다. 내용이 함께 온다 |
| `laf:downloaded` | 파일이 `downloads/`에 저장됐다 |
| `laf:download_too_large` / `laf:download_failed` | 저장하지 못했다 |
| `laf:frame_opaque` | iframe 하나를 읽지 못했다 |
| `laf:secret_request_lost` | 재시작으로 비밀값 요청이 사라졌다 |
| `laf:tab_missing` | 그 번호의 탭이 없다 |
| `laf:stale_refs` | 스냅샷이 낡았다. 다시 찍어야 한다 |
| `laf:bot_header_missing` | 어느 봇인지 말하지 않은 호출(배포 버그) |
