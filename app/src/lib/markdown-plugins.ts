import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough/parseOnly";
import type { PluginConfig } from "streamdown";

/**
 * Emphasis that closes against a Korean letter, read as emphasis.
 *
 * MEASURED 2026-09-25: the Bot wrote `기온은 **23.5°**예요` and the chat drew the asterisks. CommonMark
 * decides whether `**` may close by what surrounds it, and a closing run preceded by punctuation (`°`)
 * must be followed by whitespace or punctuation — a Korean letter is neither, so the run stays text.
 * Korean attaches particles straight onto the word, so this is not an edge case but most bold a Bot
 * writes. `remark-cjk-friendly` (tats-u, MIT) relaxes exactly that rule next to CJK letters and
 * nothing else; its strikethrough sibling does the same for GFM's `~~`.
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
    remarkPluginsAfter: [remarkCjkFriendlyGfmStrikethrough],
    remarkPlugins: [remarkCjkFriendly, remarkCjkFriendlyGfmStrikethrough],
  },
};
