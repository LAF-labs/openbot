# 디자인 토큰 — 값이 아니라 이름을 쓴다

작성: 2026-09-06. 대상: `app/`. 근거: `app/src/styles.css`(토큰 정의),
`app/src/components/ui/focus.ts`(포커스 링), `app/tests/design-tokens.test.ts`(래칫).
팔레트와 타입 스케일의 출처는 `styles.css` 상단 주석 — Grok Bot 0.20.0에서 실측한 값이고,
여기서 발명한 숫자는 하나도 없다.

---

## 0. 한 문장

**모든 값에는 이름이 있고, 이름이 없는 값은 아직 디자인이 아니다.** 이 문서는 그 이름들의
목록이고, `app/tests/design-tokens.test.ts`가 목록 밖의 철자를 세서 늘지 못하게 막는다.

---

## 1. 왜 이 문서가 있나 (2026-09-06 실측)

고칠 것을 세어보고 나서 쓴 문서다. 고치기 전의 `app/src` 상태:

| 종류 | 실측 | 문제 |
|---|---|---|
| 모서리 | 서로 다른 반지름 **17종** | 사다리는 8칸인데 `rounded-[3px]`×2, `[2px]`, `[5px]`, `[24px]`, `[32px]`, `[calc(var(--radius)-3px)]`, `[calc(var(--radius)-5px)]`, `rounded-{tl,tr,bl,br}-[6px]` |
| 그림자 | **7종**, 그중 토큰에서 온 것 1종 | `--sand-shadow-popover`는 정의되어 있고 **아무도 쓰지 않았다** |
| 글자 크기 | 스케일 밖 **8종** | `text-[12px]`×13, `[13px]`×13, `[11px]`×7, `[15px]`, `[20px]`, `[10px]`, `[26px]`, `[0.8rem]` |
| 색 | `bg-[var(--sand-*)]` **44곳** | 대부분 이미 별칭이 있는 색이었다 |
| 포커스 링 | 철자 **7종**, 빠진 프리미티브 **5개** | `button`엔 있고 `dropdown-menu`·`context-menu`·`combobox`엔 없었다 |
| 선택 표시 | **4종**, 그중 셋이 링 | 포커스 링과 구별되지 않았다 (§6) |
| 비활성 | `opacity-50` | near-black 채움이 눌러도 되는 중간 회색 알약이 됐다 (§6) |
| 대기 | **없음** | 로더가 4초면 여섯 화면이 4초 내내 흰 화면이었다 (§6) |
| 셀렉트 갈매기 | **2종** | `Select`와 `Combobox`가 같은 동작에 다른 표시 (§10) |

하나하나는 멀쩡해 보인다. `rounded-[3px]`는 `rounded-sm` 옆에 있어도 티가 안 난다.
**모여야만 틀리는 종류의 오류**라서 쌓이고, 그래서 개별 줄이 아니라 개수를 지킨다.

프리미티브(`app/src/components/ui/`)는 2026-09-06에 전부 비웠다. 남은 것은 화면 쪽 93곳이고
테스트의 허용 목록에 파일별로 적혀 있다.

---

## 2. 모서리 — 사다리는 8칸

Grok의 사다리는 파생이 아니라 **명시**다: 2 / 4 / 6 / 8 / 10 / 14 / 16 / 18.
`--radius` 하나에 곱셈을 걸면 이 디자인에 없는 22px, 26px 모서리가 생긴다.

| 클래스 | 값 | 토큰 | 쓰는 곳 |
|---|---|---|---|
| `rounded-xs` | 2px | `--radius-xs` | 툴팁 화살표 |
| `rounded-sm` | 4px | `--radius-sm` | 칩, 인풋 그룹 안쪽 애드온, `kbd` |
| `rounded-bubble-joined` | 6px | `--radius-bubble-joined` | 이어진 말풍선이 이웃과 만나는 두 모서리 |
| `rounded-md` | 8px | `--radius-md` | 메뉴 항목, xs·sm 버튼, 작은 아이콘 버튼 |
| `rounded-lg` | 10px | `--radius-lg` = `--radius` | 기본 버튼, 인풋, 팝오버, 사이드바 행 |
| `rounded-xl` | 14px | `--radius-xl` | 다이얼로그 |
| `rounded-2xl` | 16px | `--radius-2xl` | 큰 카드 |
| `rounded-3xl` / `rounded-bubble` | 18px | `--radius-3xl` / `--radius-bubble` | 말풍선 |

`rounded-[...]`는 쓰지 않는다. **`rounded-[min(var(--radius-md),12px)]`은 특히 쓰지 않는다** —
`--radius-md`가 8px로 고정이라 `min()`은 언제나 8을 돌려준다. 다섯 군데에 있었고 다섯 군데 다
`rounded-md`였다. 읽는 사람만 12px이라고 착각한다.

## 3. 글자 — 스케일은 6칸

루트가 14px로 고정(`html { font-size: 14px }`)이라 `rem`은 쓰지 않는다. 픽셀로 생각하고
이름으로 적는다.

| 클래스 | 크기/행간 | 쓰는 곳 |
|---|---|---|
| `text-xs` | 11 / 16 | 메타, 라벨, 배지, sm·xs 버튼 |
| `text-sm` | 13 / 18 | 목록 행, 메뉴 항목, 보조 문장 |
| `text-base` | 14 / 20 | 본문, 채팅 measure(`--chat-font-size`) |
| `text-lg` | 17 / 24 | 섹션 제목 |
| `text-xl` | 22 / 28 | 다이얼로그·화면 제목 |
| `text-2xl` | 26 / 32 | 온보딩 헤드라인 |

**12px과 15px과 20px은 이 스케일에 없다.** 화면 쪽에 각각 13곳·2곳·1곳 남아 있고, 옮길 곳은
`text-[12px]` → `text-xs`(11) 또는 `text-sm`(13), `text-[15px]` → `text-base`(14) 또는
`text-lg`(17), `text-[20px]` → `text-xl`. 어느 쪽인지는 그 자리에서 정한다 — 다만 **새 칸을
만들지는 않는다.** 스케일은 실측이지 취향이 아니다.

## 4. 높이 — 이 디자인의 그림자는 둘뿐

| 클래스 | 토큰 | 라이트 | 다크 |
|---|---|---|---|
| `shadow-popover` | `--sand-shadow-popover` | 3겹 그림자 + 1px 헤어라인 | **헤어라인 링만** |
| `shadow-composer` | `--sand-shadow-composer` | 얕은 2겹 + 헤어라인 | **헤어라인 링만** |

`shadow-md`, `shadow-lg`, `ring-1 ring-foreground/10`의 조합은 쓰지 않는다. 세 선언으로 토큰
하나를 흉내 내는 것이고, 무엇보다 **테마 규칙을 깬다**: 다크에서 깊이는 헤어라인이지 그림자가
아니다. `#070707` 위에 드리울 데가 없기 때문이다. 토큰은 그 전환을 이미 담고 있고 `shadow-md`는
담고 있지 않다.

메뉴·팝오버·콤보박스·셀렉트·다이얼로그는 전부 `shadow-popover` 하나로 통일했다.

## 5. 포커스 링 — 철자는 하나, 상수는 여섯

`app/src/components/ui/focus.ts`에서 가져다 쓴다. 손으로 다시 쓰지 않는다.

| 상수 | 언제 | 무엇을 그리나 |
|---|---|---|
| `focusRing` | 자기 테두리가 있는 컨트롤 — 버튼, 인풋, 셀렉트, 스위치 | `border-ring` + `ring-3 ring-ring/50` |
| `focusRingInset` | 패딩 있는 팝업 안의 행 — 메뉴 항목, 셀렉트 옵션, 사이드바 행 | `ring-2 ring-ring/50 ring-inset` |
| `focusRingWithin` | 자식을 통해 포커스되는 컨테이너 — 칩 필드 | `focus-within:` 형태의 하우스 링 |
| `focusRingHasControl` | 인풋 그룹 — 안의 **컨트롤**이 포커스될 때만 | `has-[[data-slot=input-group-control]:focus-visible]:` 형태 |
| `focusRingNested` | 봇의 산문이 말풍선 안에 넣은 버튼·링크 | `[button,a]:` 형태 |
| `highlightRing` | 콤보박스 옵션 — `focus-visible`이 **절대 안 걸리는** 자리 | `data-highlighted:ring-2 ring-inset` |

세 가지가 여기 적혀 있어야 하는 이유:

- **`outline-hidden`이지 `outline-none`이 아니다.** 둘 다 기본 아웃라인을 끄지만
  `outline-hidden`은 `@media (forced-colors: active)`에서 투명한 2px 아웃라인을 되돌려 놓는다.
  강제 색 테마에서는 `box-shadow` 링이 아예 그려지지 않으므로, `outline-none`은 Windows 고대비
  사용자에게 **앱 전체에 포커스 표시가 없는 상태**를 남긴다. 앱에는 두 철자가 다 있었다.
- **콤보박스 옵션에는 `focus-visible`이 절대 걸리지 않는다.** Base UI의 `Combobox.Item`은
  `tabIndex: undefined`이고 `.focus()`를 부르지 않는다 — DOM 포커스는 인풋에 남고 활성 옵션은
  `aria-activedescendant`로 가리킨다. 그래서 옵션에 쓸 상수는 `highlightRing`
  (`data-highlighted:`)이다. `focus-visible`을 걸면 **커버리지처럼 보이는 죽은 CSS**가 된다.
  메뉴와 셀렉트는 반대로 진짜 DOM 포커스를 옮기므로 `focusRingInset`이 맞다.
- **변형 접두사가 붙은 형태는 풀어 써야 한다.** Tailwind는 소스에서 **완성된 클래스 이름**을
  볼 때만 유틸리티를 만든다. `` `[button,a]:${focusRing}` ``은 런타임 문자열은 맞고 CSS는 하나도
  안 나온다 — 링이 조용히 사라지는 실패다. 그래서 `focusRingNested`·`focusRingHasControl`이
  따로 있다.

`ring` 두께는 **3(컨트롤)과 2(팝업 안의 행)** 둘뿐이다. `ring-1`은 헤어라인 테두리용이고
포커스가 아니다.

## 6. 상태 — 선택됨, 비활성, 그리고 기다리는 중

### 선택됨은 링이 아니다

"이걸 골랐다"를 말하는 방식이 화면마다 넷이었고, 그중 셋이 링이었다: 얼굴 고르개와 로스터
스트립과 노력 선택기의 `ring-2 ring-primary`(한 군데는 `ring-offset-1`까지), 컴퓨터 화면의
`bg-primary text-primary-foreground`, 루틴의 손으로 쓴 `aria-pressed:` 알약. **이 디자인에서
링은 이미 포커스를 뜻한다** — 하우스 링이 3px `--ring` 후광이다. 골라졌고 포커스도 된 타일은
같은 말을 두 가지 회색으로 두 번 했다.

그래서 **선택은 테두리와 채움, 포커스는 링**으로 갈랐다. 둘은 겹쳐도 읽힌다.

| 상수 (`ui/focus.ts`) | 클래스 | 언제 |
|---|---|---|
| `selectedClass` | `border-foreground bg-accent text-foreground` | 자기 상태를 밖에서 받는 타일·행 |
| `selectedWhenPressed` | 위와 같은 것을 `aria-pressed:`로 | 토글 버튼. **`Button`이 이미 달고 있다** |

`Button`에는 `aria-pressed={…}`만 넘기면 된다. 클래스는 필요 없다.

대상 요소에는 **테두리 상자가 먼저 있어야 한다**(`Button`은 `border border-transparent`를 이미
가지고 있다). 맨 `div`라면 `border`를 먼저 주지 않으면 선택될 때 레이아웃이 1px 움직인다.

**`data-pressed`는 일부러 뺐다.** Base UI가 이 속성을 두 가지로 쓴다: `Toggle`에서는 "켜짐"
이지만 `Combobox.Trigger`·`Select.Trigger`에서는 **"지금 눌려 있음"**이다(그래서
`combobox.tsx`가 `data-pressed:bg-transparent`로 눌림 채움을 끄고 있다). 여기서 스타일을 걸면
앱의 모든 트리거가 누를 때마다 선택된 모습으로 번쩍인다.

### 비활성은 색이 옅어진 활성이 아니다

`disabled:pointer-events-none disabled:opacity-50`(shadcn 기본값)은 **두 쪽 다 틀렸다.**

- `pointer-events-none`이 막는 것은 없다. 네이티브 `<button disabled>`는 어떤 브라우저에서도
  클릭을 발생시키지 않는다. 실제로 하는 일은 히트 테스트를 끄는 것이고, 그래서
  `cursor: not-allowed`가 한 번도 보이지 않았고 "왜 꺼져 있는지" 설명하는 툴팁을 버튼 자신에게
  달 수도 없었다.
- `opacity-50`이 화면을 망친 쪽이다. `bg-primary`는 near-black이라 50%면 **흰 글자가 얹힌
  중간 회색 알약** — 비활성 컨트롤이 아니라 그냥 평범해 보이는 보조 버튼이 된다.

지금은 **채움이 사라진다**: `disabled:bg-muted disabled:text-muted-foreground`
`disabled:cursor-not-allowed`. (2026-09-06 실측, 라이트: 기존 `#070707` @ 0.5 → 지금
`rgba(119,119,119,0.09)` 바탕에 `rgba(20,20,20,0.6)` 글자, `cursor: not-allowed`.)

히트 테스트가 돌아왔으므로 **`:hover`도 비활성 버튼에 걸린다.** 그래서 모든 variant의 호버
채움이 `not-disabled:hover:` 뒤에 있다. 새 variant를 쓸 때도 그렇게 쓴다.

**끄면 옆에 이유를 쓴다.** 비활성 버튼은 "왜"를 말하지 않으면 고장 난 버튼과 구별되지 않는다.
한 문장을 버튼 옆이나 아래에 두거나, 툴팁으로 버튼 자신에 붙인다 — 후자는 이제 가능하다.

### 기다리는 중은 흰 화면이 아니다

라우터의 `defaultPendingComponent`가 `PageSkeleton`(`ui/skeleton.tsx`)이고,
`defaultPendingMs: 300` / `defaultPendingMinMs: 300`이다. 이전에는 **아무것도 없었다**: 로더를
기다리는 라우트는 아무것도 그리지 않았고, 기다리는 라우트는 대개 `_authed`(`/api/me`를 기다린다)
라서 **앱 전체가 사라졌다.** API가 4초 걸릴 때 `/`, `/agents`, `/routines`, `/skills`,
`/settings/connected-accounts`, `/admin/audit`가 4초 내내 흰 화면이었다.

두 숫자 다 "약이 병보다 나쁘지 않게" 있는 것이다. 300ms 전에는 안 뜨니 빠른 응답에서 두 프레임
깜빡이지 않고, 한 번 떴으면 300ms는 머무니 310ms에 도착한 응답이 10ms짜리 깜빡임을 만들지
않는다. 기본값은 1000/500이고, 1초짜리 흰 화면이 바로 그 버그다.
(2026-09-06 Playwright 실측, `/api/me`를 4초 지연시켜서: 211ms 시점 스켈레톤 없음 → 409ms에
등장 → 4202ms에 사라지며 `/sign`으로.)

화면이 자기 대기 상태를 따로 그리고 싶으면 라우트의 `pendingComponent`에 같은 `PageSkeleton`을
쓴다. 모양은 `PageShell`의 measure·여백과 같게 맞춰 두었다 — 비율이 다른 자리표시자는 없느니만
못하다. 진짜 내용이 오면 페이지가 눈에 띄게 튀고, 그건 두 번 로드된 것처럼 읽힌다.

## 7. 색 — 별칭이 있으면 별칭을 쓴다

`bg-[var(--sand-…)]`는 Tailwind가 읽을 수 없는 문자열이다. 린트도, 자동완성도, 이 문서의
래칫 테스트도 못 본다. 아래 표의 왼쪽을 쓰면 전부 보인다.

| 쓰는 클래스 | 원래 변수 | 무엇 |
|---|---|---|
| `bg-background` / `text-foreground` | `--sand-bg-base` / `--sand-text-primary` | 페이지 |
| `bg-sidebar` | `--sand-bg-subtle` | 사이드바, 가라앉은 면 |
| `bg-card` / `bg-popover` | `--sand-bg-elevated` | 떠 있는 면 |
| `bg-accent` | `--sand-fill-ghost-hover` | 고스트 호버 |
| `bg-sidebar-accent` | `--sand-fill-ghost-selected` | 선택된 행 |
| `bg-muted` / `bg-secondary` | `--sand-fill-secondary` | 채운 보조면 |
| `bg-primary` / `hover:bg-primary-hover` | `--sand-fill-primary` / `-hover` | 채운 컨트롤 |
| `text-muted-foreground` | `--sand-text-secondary` | 보조 문장 |
| `border-border` / `border-input` / `border-ring` | `--sand-border-weak` / `-default` / `-focus` | 선 |
| `bg-bubble-agent` / `bg-bubble-user` | `--sand-fill-bubble-*` | 말풍선 |
| `text-on-color` | `--sand-text-on-color` | 사람 말풍선 위의 글자 — **테마를 따라 뒤집지 않는다** |
| `bg-mark` | `--sand-fill-accent` | "봇이 기다린다"는 파란 점 |
| `text-link` | `--sand-text-accent` | 링크 |

`bg-mark`, `text-link`, `bg-bubble-*`, `text-on-color`, `bg-primary-hover`는 2026-09-06에
새로 이름을 붙였다. 이름이 없어서 이스케이프로 쓰이던 것들이고, 이름이 없는 칸 하나가 열려
있으면 이미 별칭이 있는 색까지 그 문으로 나간다.

**파란색은 광고가 아니다.** 채운 컨트롤은 near-black(`bg-primary`)이고, 파랑은 링크·포커스·
알림 점에만 쓴다.

## 8. 모션 — `prefers-reduced-motion`은 취향이 아니다

`styles.css`의 `@media (prefers-reduced-motion: reduce)` 블록이 `*`에 걸어
`transition-duration`·`animation-duration`을 **1ms로 접는다**(0이 아니다 — Base UI 팝업은
`transitionend`/`animationend`로 언마운트한다).

이전 블록은 `.animate-in`, `.fade-in-0` 같은 **맨 클래스 이름**을 나열했고 **하나도 맞지
않았다.** 앱에서 그 유틸리티는 전부 `data-open:animate-in`, `data-closed:fade-out-0` 형태로
쓰이고, 변형은 클래스를 추가하는 게 아니라 **다른 클래스**(`.data-open\:animate-in`)를 만든다.
클래스 이름이 아니라 **속성**을 잡는 것이 앱이 새 변형을 쓸 때마다 썩지 않는 유일한 방법이다.

예외는 하나. **`.animate-spin`은 계속 돈다**(2초로 늦출 뿐). 스피너는 장식이 아니라 "작업이
안 끝났다"는 유일한 신호이고, 한 프레임에 얼어붙은 스피너는 그 반대를 말한다. 제자리 회전은
화면을 가로지르지도 확대하지도 않는 안전한 종류의 움직임이다.

`!important`는 쓰지 않는다. 이 블록은 어떤 `@layer`에도 들어 있지 않고, **레이어 없는 규칙은
특정도와 무관하게 레이어 안의 규칙을 이긴다.** Tailwind 유틸리티는 전부 레이어 안에 있다.
(2026-09-06 Playwright `reducedMotion: "reduce"`로 실측: `transition-colors` 0.15s → 0.001s,
`data-open:animate-in` 0.15s → 0.001s, `animate-spin` 1s → 2s, `animate-pulse` → 정지 + 0.65.)

## 9. `dark` 클래스는 `<html>`에만 붙인다

`lib/theme.ts`의 `toggleRootClass("dark", …)`가 하는 그대로다. 중첩된 `.dark`는 **안 된다**:
`shadcn/tailwind.css`가 자기 `.dark` 블록에서 `--popover`·`--accent`·`--border`를 oklch 기본값
으로 직접 선언하고, 우리 매핑은 `:root`에 있다. 루트에서는 우리 `:root`가 뒤에 와서 이기지만,
**중첩된 요소에서는 그 요소에 직접 걸린 shadcn `.dark`가 상속을 이긴다.** 다크 섬 하나가
조용히 shadcn 기본 회색으로 그려진다. (2026-09-06 실측.)

## 10. 페이지 머리글, 셀렉트의 갈매기, 그리고 `nativeButton`

### 머리글은 클래스로 나가 있다

컴포넌트(`PageShell`, `PageSection`)는 `components/layout/`에 있고 다른 스트림의 것이지만,
"페이지 제목은 몇 픽셀인가, 설명은 어디 앉는가, 그 화면의 유일한 동사는 어디 가는가"는
컴포넌트 문제이기 전에 토큰 문제다. 그래서 `ui/page-header.ts`가 클래스만 내보낸다.

| 상수 | 값 | 무엇 |
|---|---|---|
| `pageHeaderClass` | `flex flex-col gap-2` | 제목 줄 + 설명 |
| `pageTitleRowClass` | `flex flex-row items-center justify-between gap-4` | 제목과 주 동사가 같은 baseline |
| `pageTitleClass` | `font-semibold text-2xl` | 26px/600. **화면당 하나** |
| `pageDescriptionClass` | `max-w-prose text-pretty text-muted-foreground text-sm leading-relaxed` | 제목 아래 한 문장 |
| `sectionTitleRowClass` | `flex min-h-8 flex-row items-center justify-between gap-4` | `min-h-8`이라 동사가 있는 섹션과 없는 섹션이 세로로 맞는다 |
| `sectionTitleClass` | `font-semibold text-lg` | 17px/600 |
| `sectionDescriptionClass` | `mt-1 max-w-prose …` | 섹션 설명 |
| `pageMeasure.prose` / `.wide` | `max-w-2xl` / `max-w-5xl` | 설정 화면은 대체로 읽는 것이라 `prose`가 기본. `wide`는 감사 로그 하나를 위한 것이다 |

### 머리글의 동사는 `<a role="button">`이 아니다

이 앱의 페이지 머리글 하나가 지금 앵커에 `role="button"`을 씌워 만들어져 있고, 렌더마다 Base UI
경고를 콘솔에 남긴다. 스크린 리더에는 한 요소에 역할이 둘로 간다.

`render`로 다른 요소를 그릴 때는 **`nativeButton={false}`를 반드시 같이 넘긴다.** 이것이 없으면
Base UI는 여전히 네이티브 버튼인 줄 알고 `disabled`·`type` 같은 버튼 전용 속성을 앵커에 넘기고,
React가 그때마다 unknown-prop 경고를 찍는다.

```tsx
<Button nativeButton={false} render={(props) => <Link to="/" {...props} />}>
```

**링크는 버튼이 아니다.** 이동하면 `Link`를 그리고, 행동하면 `<button>`을 유지한다.

### 갈매기는 프리미티브의 것이다

`Select`의 트리거와 `Combobox`의 트리거가 서로 다른 표시를 달고 있었다 —
`IconSelector`(위아래 두 겹)와 `IconChevronDown`(하나). 한 폼의 인접한 두 줄에서 같은 동작에
두 가지 표시였고, 두 겹 갈매기는 뜻도 틀리다: 그건 스테퍼나 정렬 가능한 열의 표시이고 셀렉트는
둘 다 아니다. 지금은 둘 다 `IconChevronDown`이다. (`select.tsx`의 스크롤 화살표는 별개다 —
"더 있다"는 다른 말이다.)

화면은 네이티브 `<select>`를 쓰지 않는다(2026-09-06 기준 하나도 없다). `Select`나 `Combobox`를
쓰고, 갈매기는 직접 그리지 않는다.

## 11. 래칫

`app/tests/design-tokens.test.ts`가 `app/src`를 걸으며 위의 다섯 가지 철자를 센다.

- 목록에 없는 파일은 **0개**여야 한다.
- 목록에 있는 파일은 **적힌 수 이하**여야 한다.
- 0이 된 파일은 **줄을 지워야 한다** — 그래야 허용치가 되돌아 오르지 못한다.
- `components/ui/**`는 어떤 규칙에도 걸리면 안 된다.

주석은 세지 않는다. `text-[0.8rem]`이 왜 틀렸는지 적은 주석은 그 사례가 아니다.
