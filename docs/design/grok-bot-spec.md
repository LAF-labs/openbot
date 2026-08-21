# Grok Bot 프론트 실측 스펙 (v0.20.0)

출처: `/Applications/Grok Bot.app/Contents/Resources/app.asar`
→ `dist/renderer/assets/index-DTIy1z2L.css` (544KB, StyleX atomic) + `index-CphCyQnY.js`(런타임 테마 생성기).
번들은 StyleX라 클래스가 해시(`sand-1rg5ohu`)다. 해시 → 선언 사전(6,453개)을 만들고 컴포넌트별로 역디코딩했다.
**검증:** 라이트 팔레트 130개 토큰을 배포 CSS와 대조 → 130/130 일치. 추정값 없음.

## 1. 팔레트
런타임에서 `document.documentElement.dataset.theme = "cursor-light" | "cursor-dark"` 를 찍고
`<style id="sand-cursor-theme">`를 주입한다. 라이트/다크 130개 토큰 전량 → `sand-tokens.css`.

핵심 값:

| 역할 | light | dark |
|---|---|---|
| `bg/base` (채팅 바닥) | `#fcfcfc` | `#070707` |
| `bg/subtle` (사이드바) | `#f7f7f7` | `#111111` |
| `bg/elevated` | `#fcfcfc` | `#181818` |
| `text/primary` | `#141414` | `#fcfcfc` |
| `text/secondary` | `#14141499` | `#fcfcfc99` |
| `text/tertiary` | `#14141466` | `#fcfcfc66` |
| `border/weak` | `#1414141a` | `#fcfcfc1a` |
| `fill/ghost-hover` | `#77777717` | `#7777772c` |
| `fill/ghost-selected` | `#7777772b` | `#77777752` |
| `fill/bubble-agent` | `#eeeeee` | `#262626` |
| `fill/bubble-user` | `#070707` | `#5a5a5a` |
| `fill/accent` | `#1084fe` | `#1084fe` |

- 회색은 **완전 무채색이 아니라 `#777777` 알파**로 쌓는다 (ghost/secondary 계열).
- 다크에서 그림자 토큰은 전부 투명 — 그림자 대신 hairline ring으로 깊이를 낸다.

## 2. 타이포
시스템 산세리프. **macOS에서 regular = 420** (400 아님), medium 500, semibold 600.

| 스타일 | size/line | tracking | 쓰임 |
|---|---|---|---|
| heading1 | 26/32 | -0.015em | |
| heading2 | 22/28 | -0.012em | 마크다운 h1 |
| heading3 | 17/24 | -0.008em | 마크다운 h2 |
| body1 | 14/20 | 0 | **메시지 본문, Bot 이름** |
| body2 | 13/18 | 0 | 사이드바 프리뷰 |
| label | 12/16 | 0 | 헤더 보조 |
| caption | 11/16 | 0.005em | 시각, 섹션 헤더 |

## 3. 반경 (런타임 오버라이드 적용 후)
`xs 2 / sm 4 / base 8 / lg 10 / xl 14 / 2xl 16 / 3xl 18 / full 9999`

## 4. 레이아웃 상수
- 사이드바 `280px`, 인포 패널 `320px`, 채팅 최소 `424px`
- 타이틀바 `44px` (compact 38 / large 52), 신호등 여백 `72px`
- hairline `0.5px`
- 컨트롤 높이 `xs 20 / sm 24 / base 28 / lg 32`, 글리프 16px
- 스페이싱 4px 그리드 (1=4 … 20=80), 0.25 단위(1px)까지 있음

## 5. 사이드바 Bot 행 (`sand-agent-item`)
```
높이 54px · radius 10px · flex-row · gap 8px · text-align left
outline: var(--sand-border-focus), outline-offset -2px
transition: transform,width,padding  cubic-bezier(.22,1,.36,1)
```
- 아바타 36px, `position:relative`, 상태 dot는 코너 절대배치
- 본문 2줄: 이름(body1, `text/primary`, ellipsis) + `margin-inline-start:auto` 시각(caption, `text/tertiary`)
- 프리뷰 행 `min-height:18px`, body2, `text/secondary`; 차단 상태면 `text/warning`
- 선택 = `fill/ghost-selected`, hover = `fill/ghost-hover`
- 축소(rail) 변형은 **54×54, padding 9px** — 별도 72px 레일이 아니라 같은 행의 collapsed 상태
- 핀 변형은 세로 스택 + 캡션(최대 92px)

## 6. 메시지 버블 (`zo.message`) ★ 핵심
```
padding: 8px 12px
border-radius: 18px
background: var(--sand-fill-bubble-agent)
color: var(--cursor-text-primary)
font: 14px / 20px, letter-spacing 0
```
- 유저 버블: `fill/bubble-user` + `text-invert`
- **연속 그룹핑**: 이어지는 버블은 붙는 쪽 모서리만 `6px`로 줄인다
  (`assistantContinuedPrev` = top-left 6, `…Next` = bottom-left 6; 유저는 right 쪽)
- 이모지 단독 메시지: 배경/패딩 제거, 32/38px
- 미디어 단독: 패딩·배경·radius 전부 0
- 마크다운: `ul` line-height 20, `padding-inline-start 20px`; 인라인 코드/`pre`는 radius 8 + `bg-quinary`

## 7. 컴포저 (`sand-kit-message-input-frame`)
```
background: var(--sand-fill-elevated)
border: 0.5px solid var(--sand-border-default)   /* focus 시 border/focus */
box-shadow: 0 2px 8px -1px #0000000d, 0 1px 2px #00000008, 0 0 0 1px #e4e4e40a
transition: height,border-radius,border-color,background-color
```
- 액션 원형 버튼 `28px`, 글리프 16px
- 전송 글리프 전환은 opacity+scale(.5→1), `cubic-bezier(.22,1,.36,1)`
- 높이 전환에 스프링형 `linear()` 이징을 쓴다 (0.3s 확장 / 0.12s 축소)

## 8. 그 외 확인된 것
- 채팅 헤더: 20px 아바타 + 이름(body1 semibold), 우측 아이콘 버튼
- 상태 배지 행: `min-height 22px`, `gap 6px`, `padding 0 8px`, 12px, `text/secondary`
- 카드류: `padding 12px`, `gap 12px`, `border 1px solid stroke-tertiary`, `radius 16px`
- 배지 pill: `padding 2px 8px`, radius full, dot 6px
- 사이드바 컨테이너는 `container-type: inline-size` — 폭 기반 컨테이너 쿼리로 확장/축소를 전환

## 9. 우리가 가져갈 것 / 안 가져갈 것
가져감: 위 1~7 전부(수치·구조·모션). 우리 색은 accent만 우리 값으로 치환.
안 가져감: `--cursor-*` 에디터/신택스 레이어(VSCode 브릿지), 터미널 ANSI, diff 색.
