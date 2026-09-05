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

## 5. 포커스 링 — 철자는 하나, 상수는 다섯

`app/src/components/ui/focus.ts`에서 가져다 쓴다. 손으로 다시 쓰지 않는다.

| 상수 | 언제 | 무엇을 그리나 |
|---|---|---|
| `focusRing` | 자기 테두리가 있는 컨트롤 — 버튼, 인풋, 셀렉트, 스위치 | `border-ring` + `ring-3 ring-ring/50` |
| `focusRingInset` | 패딩 있는 팝업 안의 행 — 메뉴 항목, 셀렉트 옵션, 사이드바 행 | `ring-2 ring-ring/50 ring-inset` |
| `focusRingWithin` | 자식을 통해 포커스되는 컨테이너 — 칩 필드 | `focus-within:` 형태의 하우스 링 |
| `focusRingHasControl` | 인풋 그룹 — 안의 **컨트롤**이 포커스될 때만 | `has-[[data-slot=input-group-control]:focus-visible]:` 형태 |
| `focusRingNested` | 봇의 산문이 말풍선 안에 넣은 버튼·링크 | `[button,a]:` 형태 |

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

## 6. 색 — 별칭이 있으면 별칭을 쓴다

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

## 7. 모션 — `prefers-reduced-motion`은 취향이 아니다

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

## 8. `dark` 클래스는 `<html>`에만 붙인다

`lib/theme.ts`의 `toggleRootClass("dark", …)`가 하는 그대로다. 중첩된 `.dark`는 **안 된다**:
`shadcn/tailwind.css`가 자기 `.dark` 블록에서 `--popover`·`--accent`·`--border`를 oklch 기본값
으로 직접 선언하고, 우리 매핑은 `:root`에 있다. 루트에서는 우리 `:root`가 뒤에 와서 이기지만,
**중첩된 요소에서는 그 요소에 직접 걸린 shadcn `.dark`가 상속을 이긴다.** 다크 섬 하나가
조용히 shadcn 기본 회색으로 그려진다. (2026-09-06 실측.)

## 9. 래칫

`app/tests/design-tokens.test.ts`가 `app/src`를 걸으며 위의 다섯 가지 철자를 센다.

- 목록에 없는 파일은 **0개**여야 한다.
- 목록에 있는 파일은 **적힌 수 이하**여야 한다.
- 0이 된 파일은 **줄을 지워야 한다** — 그래야 허용치가 되돌아 오르지 못한다.
- `components/ui/**`는 어떤 규칙에도 걸리면 안 된다.

주석은 세지 않는다. `text-[0.8rem]`이 왜 틀렸는지 적은 주석은 그 사례가 아니다.
