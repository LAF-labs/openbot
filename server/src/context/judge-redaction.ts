/**
 * What leaves this deployment for a judge — Jev, or the model standing in for it — about a
 * conversation: the words with secrets taken out, typed values masked, and page content marked
 * sensitive left out.
 *
 * THE PRIVACY SWITCH'S OTHER HALF. `JEV_ENABLED` decides whether Jev is asked at all (off by
 * default: it is hosted in the US, `~/laf/docs/jev-oss-evaluation.md` §5); this decides what it is
 * shown when it is. Applied to the GLM fallback too, which answers the same questions from the same
 * state, so the two arms of the eval judge the same text.
 *
 * THREE RULES, each one the product's own elsewhere:
 *
 *   A typed value is never shown (CLAUDE.md, "Never record what somebody typed"). `computer_type`'s
 *   `text` becomes a placeholder, and so does every element `value` a snapshot carries — a field's
 *   value is what somebody typed into it.
 *   A field marked secret is not shown at all. The computer marks a password box, or a box labelled
 *   like one, `type: "password"` (`agent-computer/src/aria-snapshot.ts`); such an element is left out
 *   of the result entirely, label included.
 *   Anything shaped like a credential or a personal number is replaced: keys and tokens, card
 *   numbers, resident registration numbers, account passwords written inline, e-mail addresses and
 *   phone numbers. Order numbers, amounts and dates stay — they are what a keep-or-drop question is
 *   about, and the needle the eval looks for.
 *
 * Pure, so the rule can be tested by serialising the output and asserting a value is nowhere in it.
 */

/** What a typed value becomes. */
export const TYPED_PLACEHOLDER = "[typed]";

const PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // API keys and bearer tokens: sk-…, pk_…, xoxb-…, ghp_…, Bearer …, JWTs.
  [/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}/g, "[secret]"],
  [/\b(?:xox[abpr]|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{8,}/g, "[secret]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [secret]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[secret]"],
  // A password, PIN or code written inline: 비밀번호: …, password=…
  [
    /((?:비밀번호|비번|암호|password|passwd|pwd|pin|otp|인증번호|보안코드|cvc|cvv)\s*[:=：]\s*)\S+/gi,
    "$1[secret]",
  ],
  // Korean resident registration number (주민등록번호), with or without the dash.
  [/\b\d{6}-?[1-4]\d{6}\b/g, "[id-number]"],
  // Card numbers: 13–19 digits in groups.
  [/\b(?:\d[ -]?){12,18}\d\b/g, "[card]"],
  // E-mail addresses and Korean mobile/landline numbers.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  [/\b0\d{1,2}[- .]?\d{3,4}[- .]?\d{4}\b/g, "[phone]"],
];

/** Text with every credential- or personal-number-shaped token replaced. */
export function redactText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** How one value of a kind is told from another without being shown: by what it is, not how it is spelt. */
function sameValueKey(kind: string, value: string): string {
  if (kind === "email") return value.toLowerCase();
  if (kind === "phone" || kind === "card" || kind === "id-number") {
    return value.replace(/\D/g, "");
  }
  return value;
}

/**
 * A redaction that keeps WHICH value stood where, for a judge that has to say whether two texts
 * are about the same thing: the first address it meets is `[email 1]`, a different one
 * `[email 2]`, and the first again is `[email 1]` wherever it comes back — in the owner's sentence
 * or in the action it is held against. One of these is made per judgement and both sides go
 * through it.
 *
 * `redactText` alone was used for that at first, on both sides, and every address became the one
 * word `[email]`: a standing instruction naming one recipient then read the same as an action aimed
 * at any other, and the reviewer could let it through unasked (found by review of #232, 2026-10-13;
 * the Jev path had carried it since #217). A judge that cannot tell two recipients apart is not
 * redacted, it is blinded, and a boundary must never lie.
 *
 * Text that has already been through one of these comes out unchanged, so handing an
 * already-redacted pair to a second reviewer is safe.
 */
export function matchingRedaction(): {
  text: (text: string) => string;
  deep: (value: unknown) => unknown;
} {
  const seen = new Map<string, Map<string, number>>();
  const numbered = (kind: string, value: string): string => {
    const ofKind = seen.get(kind) ?? new Map<string, number>();
    seen.set(kind, ofKind);
    const key = sameValueKey(kind, value);
    const at = ofKind.get(key) ?? ofKind.size + 1;
    ofKind.set(key, at);
    return `[${kind} ${at}]`;
  };
  const text = (input: string): string => {
    let out = input;
    for (const [pattern, replacement] of PATTERNS) {
      const kind = /\[([a-z-]+)\]/.exec(replacement)?.[1];
      if (!kind) continue;
      // What the placeholder stands in for: the match without the words the replacement keeps.
      const kept = replacement.startsWith("$1")
        ? 1
        : replacement.startsWith("Bearer ")
          ? "bearer"
          : 0;
      out = out.replace(pattern, (match: string, ...groups: unknown[]) => {
        const lead =
          kept === 1
            ? String(groups[0] ?? "")
            : kept === "bearer"
              ? (/^Bearer\s+/i.exec(match)?.[0] ?? "")
              : "";
        const head = kept === "bearer" ? "Bearer " : lead;
        return `${head}${numbered(kind, match.slice(lead.length))}`;
      });
    }
    return out;
  };
  const deep = (value: unknown): unknown => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(deep);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          deep(item),
        ]),
      );
    }
    return value;
  };
  return { text, deep };
}

/** A value with every string in it redacted, the same shape otherwise. */
export function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        redactDeep(item),
      ]),
    );
  }
  return value;
}

/** The tool whose arguments carry what somebody (or the Bot) typed. */
const TYPING_TOOL = "computer_type";

/** A call's arguments as a judge may see them. */
export function redactedInput(
  tool: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const masked =
    tool === TYPING_TOOL && "text" in args
      ? { ...args, text: TYPED_PLACEHOLDER }
      : args;
  return redactDeep(masked) as Record<string, unknown>;
}

function isSecretElement(element: unknown): boolean {
  if (!element || typeof element !== "object") return false;
  return (element as Record<string, unknown>).type === "password";
}

/** A snapshot's elements, with secret fields left out and every value masked. */
function withoutTypedValues(elements: unknown[]): unknown[] {
  return elements
    .filter((element) => !isSecretElement(element))
    .map((element) => {
      if (!element || typeof element !== "object") return element;
      const fields = element as Record<string, unknown>;
      return typeof fields.value === "string" && fields.value
        ? { ...fields, value: TYPED_PLACEHOLDER }
        : fields;
    });
}

/**
 * A tool result as a judge may see it. JSON results are read as JSON, so a snapshot's secret fields
 * and values can be found by what they are rather than by what they look like; anything else is
 * redacted as text.
 */
export function redactedResult(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return redactText(text);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return redactText(text);
  }
  const fields = parsed as Record<string, unknown>;
  const cleaned = Array.isArray(fields.elements)
    ? { ...fields, elements: withoutTypedValues(fields.elements) }
    : fields;
  return JSON.stringify(redactDeep(cleaned));
}

/** Lines worth showing past the head: key–value lines, and lines carrying numbers or dates. */
const SALIENT =
  /[:：]\s*\S|\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,3}(?:,\d{3})+\s*원|\b\d{6,}\b/;

/**
 * A short, redacted excerpt of a result — what compaction shows the judge in place of upstream's
 * `ok, N chars (omitted)`, so a result is not judged blind (the 2026-09-25 evaluation's run 6: an
 * order result holding a refund reason nobody restated was dropped because Jev never saw it).
 *
 * The head, then the salient lines past it — a detail line ("환불 사유: …", an order number, an
 * amount, a date) deep in a page is exactly what the head alone would miss. Bounded, and
 * deterministic: the same result is always the same excerpt.
 */
export function resultExcerpt(text: string, chars = 700): string {
  const safe = redactedResult(text);
  let body = safe;
  let title = "";
  try {
    const parsed = JSON.parse(safe) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      title = typeof parsed.title === "string" ? `${parsed.title}\n` : "";
      if (typeof parsed.text === "string") body = parsed.text;
      else if (Array.isArray(parsed.elements)) {
        body = parsed.elements
          .map((element) => {
            const fields = (element ?? {}) as Record<string, unknown>;
            return `${String(fields.role ?? "")} ${String(fields.name ?? "")}`.trim();
          })
          .join("\n");
      }
    }
  } catch {
    // Not JSON: the text itself.
  }
  /*
   * THE SALIENT LINES FIRST, the head after. Measured (eval:compaction, 2026-09-25): with the head
   * first, an order page's first 350 characters were delivery boilerplate and the refund reason sat
   * at the end of the excerpt, and Jev kept the result at 0.50 — a coin toss at the threshold.
   */
  const salient: string[] = [];
  let used = 0;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !SALIENT.test(trimmed)) continue;
    const bounded = trimmed.slice(0, 160);
    if (used + bounded.length > Math.floor(chars / 2)) break;
    salient.push(bounded);
    used += bounded.length + 1;
  }
  const lead = [title.trim(), ...salient].filter(Boolean).join("\n");
  const room = Math.max(0, chars - lead.length);
  const head = body.slice(0, room);
  const more = body.length > room ? " …" : "";
  return `${lead}\n---\n${head}${more}`;
}
