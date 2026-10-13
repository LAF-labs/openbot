/**
 * READING A TOOL CALL'S ARGUMENTS WHILE THEY ARE STILL BEING WRITTEN.
 *
 * A card grows as the Bot writes it — a title, then a figure, then the next — because the
 * arguments are read before their JSON is closed. Until 2026-10-13 `@copilotkit/react-core` did
 * that reading (`partialJSONParse` in `@copilotkit/shared`, which is `partial-json` 0.1.7 with
 * every kind of value allowed to be partial). This is that parser, kept to the letter: what a
 * person sees mid-stream is whatever it returns for each prefix, so a parser that was merely
 * correct would draw a different card for the same bytes — a number that appears a chunk later, a
 * string cut at another place. `tests/partial-json.test.ts` holds it to the old one's answers for
 * every prefix of real arguments.
 *
 * Its oddities are therefore kept and not fixed, and are worth knowing:
 * - what follows a closed value is not read (`{"a":1} and more` is `{ a: 1 }`);
 * - a number cut at its end is read as far as it parses (`12` of `123`), so a figure can be seen
 *   to grow;
 * - a number that does not parse falls back to the text before the LAST `e` ANYWHERE in the input,
 *   which is a number only by accident; when it is not, the value is left out;
 * - a literal is completed from its first letters (`tr` is `true`, `nu` is `null`).
 *
 * Ported from partial-json (https://github.com/promplate/partial-json-parser-js), which is:
 *
 * MIT License
 *
 * Copyright (c) 2023 Promplate Dev Team
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 * and associated documentation files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
 * BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

/** Any value at all, as far as it has been written. Throws where there is nothing to read yet. */
function readPartial(text: string): unknown {
  const length = text.length;
  let index = 0;

  const fail = (what: string): never => {
    throw new Error(`${what} at position ${index}`);
  };

  const skipBlank = () => {
    while (index < length && " \n\r\t".includes(text.charAt(index))) index++;
  };

  /** A word that is whole, or one cut short at the end of the input. */
  const isWord = (word: string): boolean =>
    text.substring(index, index + word.length) === word ||
    (length - index < word.length && word.startsWith(text.substring(index)));

  const readAny = (): unknown => {
    skipBlank();
    if (index >= length) fail("Unexpected end of input");
    const here = text.charAt(index);
    if (here === '"') return readString();
    if (here === "{") return readObject();
    if (here === "[") return readArray();
    if (isWord("null")) {
      index += 4;
      return null;
    }
    if (isWord("true")) {
      index += 4;
      return true;
    }
    if (isWord("false")) {
      index += 5;
      return false;
    }
    if (isWord("Infinity")) {
      index += 8;
      return Number.POSITIVE_INFINITY;
    }
    if (
      text.substring(index, index + 9) === "-Infinity" ||
      (1 < length - index &&
        length - index < 9 &&
        "-Infinity".startsWith(text.substring(index)))
    ) {
      index += 9;
      return Number.NEGATIVE_INFINITY;
    }
    if (isWord("NaN")) {
      index += 3;
      return Number.NaN;
    }
    return readNumber();
  };

  const readString = (): unknown => {
    const start = index;
    let escaped = false;
    index++;
    while (
      index < length &&
      (text.charAt(index) !== '"' ||
        (escaped && text.charAt(index - 1) === "\\"))
    ) {
      escaped = text.charAt(index) === "\\" ? !escaped : false;
      index++;
    }
    if (text.charAt(index) === '"') {
      return JSON.parse(text.substring(start, ++index - Number(escaped)));
    }
    try {
      return JSON.parse(`${text.substring(start, index - Number(escaped))}"`);
    } catch {
      // An escape cut in two (`\u12`): what came before the last backslash.
      return JSON.parse(`${text.substring(start, text.lastIndexOf("\\"))}"`);
    }
  };

  const readObject = (): Record<string, unknown> => {
    index++;
    skipBlank();
    const object: Record<string, unknown> = {};
    try {
      while (text.charAt(index) !== "}") {
        skipBlank();
        if (index >= length) return object;
        const key = readString() as string;
        skipBlank();
        index++;
        try {
          object[key] = readAny();
        } catch {
          return object;
        }
        skipBlank();
        if (text.charAt(index) === ",") index++;
      }
    } catch {
      return object;
    }
    index++;
    return object;
  };

  const readArray = (): unknown[] => {
    index++;
    const array: unknown[] = [];
    try {
      while (text.charAt(index) !== "]") {
        array.push(readAny());
        skipBlank();
        if (text.charAt(index) === ",") index++;
      }
    } catch {
      return array;
    }
    index++;
    return array;
  };

  const readNumber = (): unknown => {
    if (index === 0) {
      if (text === "-") fail("Not sure what '-' is");
      try {
        return JSON.parse(text);
      } catch {
        return JSON.parse(text.substring(0, text.lastIndexOf("e")));
      }
    }
    const start = index;
    if (text.charAt(index) === "-") index++;
    while (index < length && !",]}".includes(text.charAt(index))) index++;
    try {
      return JSON.parse(text.substring(start, index));
    } catch {
      if (text.substring(start, index) === "-") fail("Not sure what '-' is");
      return JSON.parse(text.substring(start, text.lastIndexOf("e")));
    }
  };

  return readAny();
}

/**
 * A tool call's arguments as far as they have been written: an object, always. Nothing yet, a
 * value that is not an object, and text that is no JSON at all are each `{}` — a renderer is
 * handed arguments it can read fields off, never a failure.
 */
export function partialJSONParse(json: unknown): Record<string, unknown> {
  try {
    if (typeof json !== "string" || !json.trim()) return {};
    const parsed = readPartial(json.trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}
