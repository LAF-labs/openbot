import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough/parseOnly";
import {
  defaultRemarkPlugins,
  type PluginConfig,
  type StreamdownProps,
} from "streamdown";

/**
 * A TILDE IS TONE, AND A RANGE. STRIKETHROUGH IS TWO OF THEM EACH SIDE OF WHAT IS STRUCK.
 *
 * Pressed on the running app, 2026-10-02: the Bot answered "안녕하세요~! 오늘도 화이팅~! 감사합니다~.
 * 또 오세요~." and the screen drew "안녕하세요! 오늘도 화이팅! 감사합니다. 또 오세요." with a line through
 * "! 오늘도 화이팅" and ". 또 오세요". And then, drawn by the same renderer: one "감사합니다~~!" struck
 * out the rest of its paragraph, and "감사합니다~~ 좋은 하루 되세요." grew a second pair of tildes
 * at its end.
 *
 * In Korean a tilde is how a sentence is made friendly — 감사합니다~, 네~~! — and how a range is
 * written — 9시~18시. Markdown has three ways of reading one as strikethrough, and each is told
 * otherwise here:
 *
 *  1. ONE TILDE EACH SIDE. GFM reads `~one~` the same as `~~two~~`, and the plugin below, which lets
 *     a mark open or close against a Korean letter, made every tilde after one an opener.
 *     `ONE_TILDE` is the option GitHub's own extension has for this, given to both readers of `~`.
 *  2. A PAIR THAT IS NEVER CLOSED. While an answer arrives the renderer closes what is still open,
 *     and it closed `~~` — so a single 네~~! struck everything after it, in a finished answer too.
 *     `markdownRemend` stops that one completion.
 *  3. TWO PAIRS OF TONE IN A PARAGRAPH. 네~~! 알겠습니다~~! is, to the letter, `~~! 알겠습니다~~`.
 *     `toneTildes` reads what was struck: text that begins with the punctuation a sentence ends on
 *     and the space after it, right after a word, was not struck by anybody.
 *
 * All of it arrived with the Korean-friendly strikethrough plugin (2026-09-25) and was in every
 * answer with a friendly ending since.
 */
const ONE_TILDE = { singleTilde: false } as const;

/** What the renderer is not to close for an answer. See 2 above. */
export const markdownRemend: NonNullable<StreamdownProps["remend"]> = {
  strikethrough: false,
};

/** As much of the syntax tree as `toneTildes` reads. */
type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };

/** The punctuation a sentence ends or pauses on, and the space that follows it. */
const ENDS_A_SENTENCE = /^[!?.,…:;)\]}！？。，、：；）]+\s/;
const ONLY_PUNCTUATION = /^[!?.,…:;)\]}！？。，、：；）]+$/;

/**
 * Whether what was struck begins the way the rest of a sentence does after a tilde of tone: with
 * the punctuation the sentence ended on, and then a space or a new line.
 *
 * THE SPACE IS THE SIGNAL. What is struck on purpose may begin with punctuation too, and hang on a
 * Korean word just the same — `버전~~.old~~`, a comma taken out, `값은~~.5~~` — and the first version
 * of this put the tildes back for every one of them (review, first round). What follows the
 * punctuation of a struck name is the name; what follows the punctuation a sentence ended on is the
 * next sentence, after a space.
 */
function beginsAfterSentence(struck: MarkdownNode): boolean {
  const [first, second] = struck.children ?? [];
  if (first?.type !== "text") return false;
  const words = first.value ?? "";
  if (ENDS_A_SENTENCE.test(words)) return true;
  // The same, where the answer broke the line by hand.
  return ONLY_PUNCTUATION.test(words) && second?.type === "break";
}

/** Whether what stands before a node touches it: a word, a mark, anything but space or nothing. */
function isAttached(before: MarkdownNode | undefined): boolean {
  if (!before) return false;
  return !(before.type === "text" && /\s$/.test(before.value ?? ""));
}

function putToneBack(parent: MarkdownNode): void {
  const children = parent.children;
  if (!children) return;
  for (let index = 0; index < children.length; index += 1) {
    const node = children[index];
    if (!node) continue;
    if (
      node.type === "delete" &&
      isAttached(children[index - 1]) &&
      beginsAfterSentence(node)
    ) {
      const tilde = (): MarkdownNode => ({ type: "text", value: "~~" });
      children.splice(index, 1, tilde(), ...(node.children ?? []), tilde());
      // Its own words are looked at next, from the tilde that now stands where it stood.
      continue;
    }
    putToneBack(node);
  }
}

/**
 * See 3 above. A transform over the tree the parsers made, not a second reading of the text: it
 * undoes one decision of theirs where the result says it was wrong.
 *
 * Both conditions, because each alone is something people write: `~~. 그리고~~ 대신` strikes the end
 * of one sentence and the start of the next, after a space; `가격은~~만원~~팔천 원` and
 * `버전~~.old~~` strike right after a word.
 */
function toneTildes() {
  return (tree: unknown) => putToneBack(tree as MarkdownNode);
}

/**
 * Emphasis that closes against a Korean letter, read as emphasis.
 *
 * MEASURED 2026-09-25: the Bot wrote `기온은 **23.5°**예요` and the chat drew the asterisks. CommonMark
 * decides whether `**` may close by what surrounds it, and a closing run preceded by punctuation (`°`)
 * must be followed by whitespace or punctuation — a Korean letter is neither, so the run stays text.
 * Korean attaches particles straight onto the word, so this is not an edge case but most bold a Bot
 * writes. `remark-cjk-friendly` (tats-u, MIT) relaxes exactly that rule next to CJK letters and
 * nothing else; its strikethrough sibling does the same for GFM's `~~`, which is what keeps
 * `~~1.5%~~에서` struck.
 *
 * Streamdown's `cjk` slot places the first before remark-gfm and the second after it, which is the
 * order the strikethrough plugin requires (it does nothing when placed before remark-gfm). Only the
 * parsers are taken: nothing here serialises markdown back out.
 *
 * This module is imported only from behind the transcript renderer's lazy boundary, with Streamdown,
 * so the parsers stay out of the first screen alongside it.
 */
export const markdownPlugins: PluginConfig = {
  cjk: {
    name: "cjk",
    type: "cjk",
    remarkPluginsBefore: [remarkCjkFriendly],
    remarkPluginsAfter: [[remarkCjkFriendlyGfmStrikethrough, ONE_TILDE]],
    remarkPlugins: [
      remarkCjkFriendly,
      [remarkCjkFriendlyGfmStrikethrough, ONE_TILDE],
    ],
  },
};

type RemarkPlugins = NonNullable<StreamdownProps["remarkPlugins"]>;

/** GFM as the renderer ships it — the parser alone, or the parser with its options — told once more. */
function withOneTilde(gfm: RemarkPlugins[number]): RemarkPlugins[number] {
  if (Array.isArray(gfm)) {
    const [parser, options] = gfm;
    return [parser, { ...(options as object | undefined), ...ONE_TILDE }];
  }
  return typeof gfm === "function" ? [gfm, ONE_TILDE] : gfm;
}

/**
 * The renderer's own parsers, with GFM told the same thing about one tilde, and the tone put back.
 *
 * Both readers of `~` have to be told: remark-gfm's, which strikes `~하나~`, and the Korean-friendly
 * one above, which takes over next to a Korean letter. Built from what the renderer ships rather
 * than by importing remark-gfm here, so the version drawn is the renderer's own and its other
 * parsers come along whatever they are. Handed to every place the renderer is drawn, beside
 * `markdownPlugins` and `markdownRemend` — `markdown-tilde.test.tsx` walks the source for all three,
 * and draws `~하나~` to know that the renderer still calls its GFM by this name.
 */
export const markdownRemarkPlugins: RemarkPlugins = [
  ...Object.entries(defaultRemarkPlugins).map(([name, plugin]) =>
    name === "gfm" ? withOneTilde(plugin) : plugin,
  ),
  toneTildes,
];
