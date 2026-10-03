/**
 * A BUTTON'S HEIGHT UNDER A FINGER.
 *
 * The cards in a conversation draw their buttons at 28px — a pointer's size. On a phone the
 * approval card's 이번만 허용 and 거부 sat a thumb's width apart at that height, and those are the
 * two buttons in the app where a press on the wrong one costs the most: one lets an action
 * through, the other stops the Bot. So where the pointer is coarse they are 36px, with the room
 * beside the words to match.
 *
 * A string, like `focus.ts` and `card-surface.ts`, so it composes into a `className` beside
 * whatever size the button already says.
 */
export const touchTall = "pointer-coarse:h-9 pointer-coarse:px-3";
