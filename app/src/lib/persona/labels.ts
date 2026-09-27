import type { Persona } from "@shared/persona";

/**
 * The four answers' words, as English keys with Korean in `i18n-ko.ts` — read through `t(variable)`,
 * so `app/tests/persona.test.ts` walks them.
 */
export const PERSONA_LABELS: Readonly<Record<Persona, string>> = {
  student: "Student",
  worker: "Office worker",
  owner: "Business owner",
  other: "Other",
};
