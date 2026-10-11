# 검토 소견을 거르는 장부 — 기각 패턴

작성: 2026-10-11. 근거 규칙: `CLAUDE.md` "How a change lands" — 검토는 마르는 것이 아니라
가려서 끝난다. 소견은 고치기 전에 네 칸(지금 고침 · 생각해 볼 것 · 적어 둠 · 기각)으로 나뉘고,
기각은 이유와 함께 스레드에 보인다. 한 풀 리퀘스트에서 **세 번째 검토부터**, 이 장부의 패턴에
맞는 소견은 패턴 이름을 적고 기본으로 기각한다.

**패턴으로 기각하지 않는 것.** 보안, 로그인과 세션, 돈, 데이터 손실과 마이그레이션, 개인정보.
이 다섯은 몇 번째 검토든, 아래 패턴에 아무리 닮았든, 매번 읽는다. 아래 세 번째 항목의 "건너뛰지
않을 때"가 그 예다 — 같은 모양의 소견이 키가 어디로 가는지를 말하는 순간 P1이었고, 고쳤다.

## 적는 법

항목 하나는 다섯 줄이다. 실제 검토 스레드에서 **두 번 이상 돌아온 것**만 적고, 출처는 댓글의
주소다. 한 번 본 것은 후보로 적되 "후보"라고 표시한다. 패턴을 지어 넣지 않는다 — 장부에 없는
모양은 그냥 읽는다.

- **패턴** — 소견이 말하는 것, 한 문장.
- **건너뛸 때** — 참이어야 하는 조건. 조건을 보이는 데 드는 명령이 있으면 그 명령.
- **건너뛰지 않을 때** — 같은 모양이 진짜였던 경우.
- **예** — 실제 소견의 제목이나 문구.
- **출처** — 댓글 주소. 몇 번째 검토인지.

## 항목

### 1. 값의 또 다른 표기를 판정 규칙이 읽지 못한다

- **패턴.** 평가의 순수 판정 규칙(정답·오답·그 외를 가르는 정규식)이 어떤 값의 한 표기 —
  콜론으로 쓴 시각, 요일 약자, 오전/오후, 다른 달, 만 단위만 쓴 값, `9~16시`, 쉼표 금액,
  `0.3kg` — 를 읽지 못해 그 표기로 쓴 답이 `other`나 `partial`로 분류된다는 소견.
- **건너뛸 때.** 저장된 보고서를 그 규칙으로 다시 찍었을 때(`EVAL_MEMORY_REPORT=…`, 모델 호출
  없음) 모든 표가 바이트까지 같을 때 — 측정된 답 어디에도 그 표기가 없다는 뜻이다. 답글에
  그 사실을 적고, 고침은 후속으로 보낸다. 이 PR의 수치는 그대로 선다.
- **건너뛰지 않을 때.** 다시 찍은 표에서 한 칸이라도 움직일 때. 같은 PR의 3차에서 "필수 값이
  빠졌다"는 이웃 모양(아래 2번)이 한 행을 옮겼다 — 그것은 기각이 아니라 지금 고침이었고, 문서와
  PR 본문의 수치를 바꿨다. 모델이 그 표기를 실제로 쓰는 것이 보일 때도 같다.
- **예.** "Recognize colon-formatted business hours"(1차), "Recognize abbreviated weekdays as
  wrong answers"(2차), "Distinguish AM and PM in business hours" · "Recognize an incorrect payment
  month"(3차), "Recognize 만-only prices as wrong values" · "Recognize wrong hours at the start of
  shorthand ranges" · "Accept numeric won equivalents for shipping thresholds" · "Treat 0.3 kg as the
  300 g package size"(4차).
- **출처.** PR #183, 네 번의 검토 모두에서. 1~3차는 고치고 매번 "No measured number moves"를
  적었다 — <https://github.com/LAF-labs/openbot/pull/183#discussion_r4241345004>,
  <https://github.com/LAF-labs/openbot/pull/183#discussion_r4241412759>,
  <https://github.com/LAF-labs/openbot/pull/183#discussion_r4241480309>,
  <https://github.com/LAF-labs/openbot/pull/183#discussion_r4241480347>. 4차의 넷은 주인의
  결정으로 후속으로 보냈다 —
  <https://github.com/LAF-labs/openbot/pull/183#discussion_r4241510698>,
  <https://github.com/LAF-labs/openbot/pull/183#discussion_r4241510695>,
  <https://github.com/LAF-labs/openbot/pull/183#discussion_r4241510709>,
  <https://github.com/LAF-labs/openbot/pull/183#discussion_r4241510714>, 결정은
  <https://github.com/LAF-labs/openbot/pull/183#issuecomment-6109210815>.

### 2. 사실에 필수 값이 하나 빠져 있어 불완전한 줄이 온전한 것으로 센다

- **패턴.** 평가의 사실 표에서 한 값(주체, 단위의 기준, 평일 제한, 개수, 되풀이의 주기)을
  요구하지 않아, 그 값 없이 쓴 기억 줄이나 답이 `whole`·`correct`로 분류된다는 소견.
- **건너뛸 때.** 1번과 같은 확인으로 다시 찍은 표가 그대로일 때 — 그리고 그때뿐이다. 이 모양은
  한 번 진짜였으므로(아래), 확인 없이 패턴만으로 기각하지 않는다.
- **건너뛰지 않을 때.** 다시 찍은 표가 움직일 때. 3차의 "Require recurrence in recurring-deadline
  facts"는 `recurring-deadline/correction`의 생존을 3/3에서 0/3으로 옮겼다 — 요약이 "매주"를 잃고
  금요일만 남겼던 것을 옛 규칙이 온전하다고 셌던 것이다.
- **예.** "Require the subject before calling a memory whole"(1차), "Require the unit basis for
  unit-price facts" · "Require the weekday restriction for phone hours" · "Require all three jars in
  the corrected preference"(2차), "Require recurrence in recurring-deadline facts"(3차),
  "Classify contradictory extra values as wrong" · "Verify recall-time memories before counting them
  as written"(4차).
- **출처.** PR #183. 고치고 수치가 그대로였던 것 —
  <https://github.com/LAF-labs/openbot/pull/183#discussion_r4241345078>,
  <https://github.com/LAF-labs/openbot/pull/183#discussion_r4241412850>,
  <https://github.com/LAF-labs/openbot/pull/183#discussion_r4241412917>,
  <https://github.com/LAF-labs/openbot/pull/183#discussion_r4241412968>; 한 행을 옮긴 것 —
  <https://github.com/LAF-labs/openbot/pull/183#discussion_r4241480234>; 4차에서 후속으로 보낸
  것 — <https://github.com/LAF-labs/openbot/pull/183#discussion_r4241510692>,
  <https://github.com/LAF-labs/openbot/pull/183#discussion_r4241510705>.

### 3. 저장된 실행이 한 번도 지나지 않은 하네스의 길

- **패턴.** 하네스가 제품과 다르게 세거나 다르게 기다리는 길이 있다는 소견 — 검색이 아닌
  프로젝트 읽기를 세지 않는다, 두 집합을 빼서 겹치는 턴을 놓친다, 제품의 90초 대신 120초를
  기다린다, OpenRouter 밖의 공급자에서는 비용을 못 센다 — 인데, 이 PR이 잰 실행은 그 길을 지난
  적이 없다.
- **건너뛸 때.** 보고서가 모든 호출을 셀 수 있고(실행마다 다리를 건넌 호출의 수와 종류가 보고서에
  적힌다) 그 길을 지난 호출이 0일 때. 답글에 그 수를 적는다("0/372", "4/372"). 고침은 후속으로.
- **건너뛰지 않을 때.** 그 길이 키나 비밀이 **어디로 가는지**에 관한 것일 때 — 3차의 "Do not
  send non-OpenRouter keys to Jev"는 같은 모양("이 PR의 실행은 OpenRouter였으니 새어 나간 것은
  없다")으로 왔지만 보안이라 패턴으로 기각하지 않고 P1로 고쳤다. 또 그 길이 측정의 부하 자체를
  바꿀 때 — 2차의 "Seed the first busy day with busy traffic"은 저장된 실행이 설명보다 쉬운
  첫날을 쟀다는 뜻이라, 고치고 수치에 "그 실행은 더 가벼운 첫날이었다"고 표시했다.
- **예.** "Preserve non-search project reads in lookup metrics"(1차), "Count overlapping elsewhere
  lookups independently"(3차), "Match the production compaction timeout" · "Account for costs
  outside OpenRouter"(4차).
- **출처.** PR #183. 지난 호출이 0이라 수치가 그대로였던 것 —
  <https://github.com/LAF-labs/openbot/pull/183#discussion_r4241345153>,
  <https://github.com/LAF-labs/openbot/pull/183#discussion_r4241480455>; 보안이라 고친 것 —
  <https://github.com/LAF-labs/openbot/pull/183#discussion_r4241480128>; 부하를 바꿔 표시한 것 —
  <https://github.com/LAF-labs/openbot/pull/183#discussion_r4241413133>; 4차에서 후속으로 보낸
  것 — <https://github.com/LAF-labs/openbot/pull/183#discussion_r4241510700>,
  <https://github.com/LAF-labs/openbot/pull/183#discussion_r4241510691>.

## 아직 없는 것

세 항목 모두 한 PR(#183)의 네 번의 검토에서 왔고, 모두 `evals/`의 측정 하네스에 대한 소견이다.
제품 코드의 검토에서 되풀이된 패턴은 아직 보지 못했으므로 적지 않았다. 다음 PR의 세 번째
검토에서 같은 모양이 돌아오면 그때 적는다.
