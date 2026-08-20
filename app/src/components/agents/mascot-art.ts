/**
 * The thirty-five faces, as vectors.
 *
 * These are the characters from the ip-as-logo showcase wall (s1dashu/ip-as-logo-skill, MIT — see
 * NOTICE), redrawn shape by shape against the original tiles rather than cropped out of the wall
 * photograph. The crops carried the photograph with them: the fabric's shading swept through every
 * tile, so the same character was lighter on one side of the grid than the other, and none of it
 * survived scaling the way a drawing does. A vector is the same face at 16 pixels and at 300, weighs
 * twelve kilobytes for the whole set against the crops' hundred and fifty, and takes the app's
 * rounded corners without resampling.
 *
 * Each entry is the inner markup of a 96 x 96 viewBox, background rect included. The markup is a
 * checked-in string written here, never anything a user typed, which is what makes rendering it with
 * dangerouslySetInnerHTML below merely ugly rather than dangerous.
 */

type MascotArt = {
  /** The ground the character sits on, for surfaces that carry the colour themselves. */
  background: string;
  /** Inner SVG markup for a 0 0 96 96 viewBox. */
  markup: string;
};

export const MASCOT_ART: Record<string, MascotArt> = {
  r0c0: {
    background: "#A6543E",
    markup: `<rect width="96" height="96" fill="#A6543E"/>
<path d="M14 52 Q6 18 18 14 Q28 12 34 34 Z" fill="#F3E7CC"/>
<path d="M60 32 Q70 8 80 14 Q88 20 78 46 Z" fill="#F3E7CC"/>
<ellipse cx="44" cy="98" rx="54" ry="56" fill="#F3E7CC"/>
<rect x="20" y="62" width="14" height="8" rx="4" fill="#39302A" transform="rotate(-6 27 66)"/>
<rect x="58" y="64" width="14" height="8" rx="4" fill="#39302A" transform="rotate(5 65 68)"/>
<ellipse cx="40" cy="84" rx="8.5" ry="6.5" fill="#39302A"/>`,
  },
  r0c1: {
    background: "#1050E7",
    markup: `<rect width="96" height="96" fill="#1050E7"/>
<path d="M4 34 Q2 20 14 18 Q28 16 28 32 L26 56 Q24 66 14 62 Q2 56 4 34 Z" fill="#FFFFFF"/>
<path d="M70 38 Q70 24 82 26 Q94 28 92 44 L88 62 Q84 72 76 66 Q68 60 70 38 Z" fill="#FFFFFF"/>
<ellipse cx="49" cy="66" rx="34" ry="34" fill="#FFFFFF"/>
<rect x="35" y="52" width="7" height="12" rx="3.5" fill="#17181A"/>
<rect x="56" y="52" width="7" height="12" rx="3.5" fill="#17181A"/>
<ellipse cx="49" cy="74" rx="8" ry="6.5" fill="#17181A"/>`,
  },
  r0c2: {
    background: "#026DBF",
    markup: `<rect width="96" height="96" fill="#026DBF"/>
<path d="M50 26 Q44 8 54 5 Q64 3 64 14 Q64 22 56 26 Z" fill="#EFE9D9"/>
<rect x="46" y="24" width="14" height="7" rx="3" fill="#E2DBC8"/>
<ellipse cx="36" cy="78" rx="40" ry="48" fill="#EFE9D9"/>
<rect x="6" y="56" width="64" height="30" rx="15" fill="#33393B"/>
<path d="M20 70 q5 -7 10 0" stroke="#EFE9D9" stroke-width="4" fill="none" stroke-linecap="round"/>
<path d="M50 70 q5 -7 10 0" stroke="#EFE9D9" stroke-width="4" fill="none" stroke-linecap="round"/>
<path d="M34 74 q6 5 12 0" stroke="#EFE9D9" stroke-width="4" fill="none" stroke-linecap="round"/>`,
  },
  r0c3: {
    background: "#C3BEEF",
    markup: `<rect width="96" height="96" fill="#C3BEEF"/>
<path d="M2 62 Q-6 30 18 26 Q34 24 36 42 L34 66 Q30 78 16 76 Q4 74 2 62 Z" fill="#4C4B55"/>
<path d="M60 40 Q62 22 80 24 Q98 28 94 52 Q90 72 74 70 Q60 68 60 40 Z" fill="#4C4B55"/>
<ellipse cx="48" cy="74" rx="34" ry="34" fill="#54535E"/>
<path d="M42 74 L42 96 L58 96 L58 84 Q58 74 50 72 Q44 71 42 74 Z" fill="#4C4B55"/>
<path d="M58 88 Q58 96 50 96 Q44 96 44 90" stroke="#4C4B55" stroke-width="7" fill="none" stroke-linecap="round"/>
<rect x="34" y="58" width="4.5" height="12" rx="2.2" fill="#DCD9F4"/>
<rect x="60" y="58" width="4.5" height="12" rx="2.2" fill="#DCD9F4"/>`,
  },
  r0c4: {
    background: "#734A6C",
    markup: `<rect width="96" height="96" fill="#734A6C"/>
<rect x="46" y="6" width="13" height="16" rx="6" fill="#E8D2A4"/>
<ellipse cx="36" cy="80" rx="44" ry="46" fill="#F2E3C0"/>
<path d="M-10 52 Q-6 24 30 20 Q68 16 78 40 Q84 54 68 56 L2 60 Q-12 60 -10 52 Z" fill="#E8D2A4"/>
<circle cx="30" cy="74" r="4" fill="#2E2620"/><circle cx="56" cy="74" r="4" fill="#2E2620"/>
<path d="M34 82 q9 9 19 0" stroke="#2E2620" stroke-width="5" fill="none" stroke-linecap="round"/>`,
  },
  r0c5: {
    background: "#050505",
    markup: `<rect width="96" height="96" fill="#050505"/>
<circle cx="26" cy="34" r="9" fill="#FCFCFC"/><circle cx="72" cy="36" r="9" fill="#FCFCFC"/>
<ellipse cx="49" cy="84" rx="38" ry="48" fill="#FCFCFC"/>
<path d="M30 58 q5 -3 10 0" stroke="#111" stroke-width="4" fill="none" stroke-linecap="round"/>
<path d="M58 60 q5 -3 10 0" stroke="#111" stroke-width="4" fill="none" stroke-linecap="round"/>
<path d="M43 70 L51 70 L47 75 Z" fill="#111"/>
<path d="M47 75 v6" stroke="#111" stroke-width="3.4" stroke-linecap="round"/>`,
  },
  r0c6: {
    background: "#33756C",
    markup: `<rect width="96" height="96" fill="#33756C"/>
<path d="M-14 96 L-14 30 Q-8 -4 36 -2 Q72 0 78 34 Q84 66 62 84 Q40 100 10 96 Z" fill="#D9E4E8"/>
<ellipse cx="64" cy="56" rx="3.6" ry="4.6" fill="#16262C" transform="rotate(12 64 56)"/>
<path d="M16 72 q20 12 42 -2" stroke="#1E3238" stroke-width="5.5" fill="none" stroke-linecap="round"/>`,
  },
  r1c0: {
    background: "#B1523C",
    markup: `<rect width="96" height="96" fill="#B1523C"/>
<path d="M58 62 L58 34 Q58 22 68 22 Q78 22 78 34 L78 48 Q78 60 68 62 Z" fill="#EDDDBB"/>
<path d="M12 96 L12 34 Q12 14 31 14 Q50 14 50 34 L50 96 Z" fill="#F5EAD1"/>
<path d="M50 74 Q62 74 66 66 L70 58 L72 70 Q66 82 50 82 Z" fill="#EDDDBB"/>
<rect x="25" y="44" width="5.5" height="8" rx="2.7" fill="#2C2620"/>
<rect x="37" y="44" width="5.5" height="8" rx="2.7" fill="#2C2620"/>
<rect x="29" y="58" width="8" height="4" rx="2" fill="#2C2620"/>`,
  },
  r1c1: {
    background: "#000000",
    markup: `<rect width="96" height="96" fill="#000000"/>
<circle cx="22" cy="26" r="12" fill="#F5F5F5"/><circle cx="22" cy="26" r="5" fill="#111"/>
<circle cx="74" cy="26" r="12" fill="#F5F5F5"/><circle cx="74" cy="26" r="5" fill="#111"/>
<ellipse cx="48" cy="70" rx="44" ry="46" fill="#F5F5F5"/>
<ellipse cx="27" cy="58" rx="9" ry="7" fill="#111" transform="rotate(-10 27 58)"/>
<ellipse cx="69" cy="58" rx="9" ry="7" fill="#111" transform="rotate(10 69 58)"/>
<ellipse cx="48" cy="76" rx="12" ry="9" fill="#111"/>`,
  },
  r1c2: {
    background: "#605393",
    markup: `<rect width="96" height="96" fill="#605393"/>
<ellipse cx="24" cy="86" rx="22" ry="18" fill="#EFE3C4"/>
<path d="M34 96 Q30 30 52 12 Q60 6 66 14 Q84 40 78 96 Z" fill="#F2E7CB"/>
<circle cx="60" cy="44" r="10" fill="#22242B"/>
<rect x="52" y="62" width="14" height="5.5" rx="2.7" fill="#22242B" transform="rotate(8 59 65)"/>`,
  },
  r1c3: {
    background: "#2B3F56",
    markup: `<rect width="96" height="96" fill="#2B3F56"/>
<path d="M44 96 L46 72 Q48 60 63 60 Q80 60 82 74 L82 96 Z" fill="#EDE2C6"/>
<path d="M12 68 Q-4 64 2 46 Q10 20 46 18 Q84 18 90 46 Q94 64 76 66 Q40 72 12 68 Z" fill="#F1E8D2"/>
<rect x="56" y="72" width="7" height="11" rx="3.5" fill="#20242C"/>
<rect x="72" y="72" width="7" height="11" rx="3.5" fill="#20242C"/>
<rect x="62" y="86" width="9" height="4.5" rx="2.2" fill="#20242C"/>`,
  },
  r1c4: {
    background: "#3E4147",
    markup: `<rect width="96" height="96" fill="#3E4147"/>
<ellipse cx="18" cy="34" rx="34" ry="38" fill="#FBFBFB"/>
<ellipse cx="56" cy="58" rx="42" ry="46" fill="#33353B"/>
<rect x="36" y="46" width="8" height="16" rx="4" fill="#FBFBFB"/>
<rect x="66" y="42" width="8" height="16" rx="4" fill="#FBFBFB"/>
<path d="M30 78 Q34 68 48 70 Q70 62 76 74 Q78 84 64 86 Q40 88 30 78 Z" fill="#5A5D63"/>`,
  },
  r1c5: {
    background: "#F0EEE6",
    markup: `<rect width="96" height="96" fill="#F0EEE6"/>
<path d="M2 58 Q0 44 10 44 Q20 44 20 56 L20 68 Q20 76 28 78 L28 96 L2 96 Z" fill="#1A72D8"/>
<path d="M66 54 Q66 42 76 42 Q86 44 84 56 Q82 66 72 68 L66 70 Z" fill="#1A72D8"/>
<path d="M26 96 L26 42 Q26 24 45 24 Q64 24 64 42 L64 96 Z" fill="#1A72D8"/>
<path d="M30 30 Q30 12 45 12 Q60 12 60 30 L62 34 L28 34 Z" fill="#3A3D40"/>
<path d="M12 30 Q10 40 22 38 L74 34 Q86 32 82 24 Q78 18 66 22 L26 28 Q16 26 12 30 Z" fill="#3A3D40"/>
<circle cx="40" cy="48" r="3.4" fill="#17181B"/><circle cx="55" cy="48" r="3.4" fill="#17181B"/>
<path d="M42 57 q6 6 12 0" stroke="#17181B" stroke-width="3.6" fill="none" stroke-linecap="round"/>`,
  },
  r1c6: {
    background: "#5674D6",
    markup: `<rect width="96" height="96" fill="#5674D6"/>
<circle cx="32" cy="44" r="13" fill="#F5A302"/><circle cx="32" cy="44" r="6" fill="#6B4A0A"/>
<circle cx="76" cy="40" r="13" fill="#F5A302"/><circle cx="76" cy="40" r="6" fill="#6B4A0A"/>
<ellipse cx="54" cy="84" rx="42" ry="42" fill="#F5A302"/>
<circle cx="40" cy="72" r="4.2" fill="#332413"/><circle cx="66" cy="72" r="4.2" fill="#332413"/>
<path d="M42 82 Q53 92 64 82 Q58 79 53 79 Q47 79 42 82 Z" fill="#332413"/>`,
  },
  r2c0: {
    background: "#B1523C",
    markup: `<rect width="96" height="96" fill="#B1523C"/>
<path d="M96 10 Q40 14 22 52 Q10 78 28 96 L96 96 Z" fill="#D6E2E8"/>
<ellipse cx="34" cy="60" rx="4" ry="5.5" fill="#16262E" transform="rotate(-12 34 60)"/>
<path d="M32 76 q20 14 42 0" stroke="#16262E" stroke-width="6" fill="none" stroke-linecap="round"/>`,
  },
  r2c1: {
    background: "#B48730",
    markup: `<rect width="96" height="96" fill="#B48730"/>
<circle cx="20" cy="44" r="15" fill="#F4E3B2"/><circle cx="50" cy="32" r="17" fill="#F4E3B2"/>
<circle cx="80" cy="42" r="15" fill="#F4E3B2"/><circle cx="10" cy="72" r="15" fill="#F4E3B2"/>
<circle cx="88" cy="70" r="15" fill="#F4E3B2"/><circle cx="28" cy="92" r="16" fill="#F4E3B2"/>
<circle cx="70" cy="92" r="16" fill="#F4E3B2"/><circle cx="49" cy="66" r="34" fill="#F4E3B2"/>
<circle cx="28" cy="46" r="6.5" fill="#E8CD8E"/><circle cx="70" cy="44" r="6.5" fill="#E8CD8E"/>
<circle cx="49" cy="72" r="24" fill="#F7ECC8"/>
<circle cx="40" cy="66" r="3.4" fill="#231C12"/><circle cx="58" cy="66" r="3.4" fill="#231C12"/>
<path d="M44 76 L54 76 L49 82 Z" fill="#231C12"/>
<path d="M49 82 v4" stroke="#231C12" stroke-width="3" stroke-linecap="round"/>`,
  },
  r2c2: {
    background: "#FAF9D0",
    markup: `<rect width="96" height="96" fill="#FAF9D0"/>
<ellipse cx="58" cy="66" rx="44" ry="46" fill="#2F3130"/>
<rect x="22" y="46" width="60" height="34" rx="17" fill="#D95B33"/>
<ellipse cx="40" cy="62" rx="5" ry="7" fill="#26221E"/>
<ellipse cx="66" cy="60" rx="5" ry="7" fill="#26221E" transform="rotate(12 66 60)"/>
<path d="M48 70 q5 5 11 0" stroke="#26221E" stroke-width="3.6" fill="none" stroke-linecap="round"/>`,
  },
  r2c3: {
    background: "#2B5840",
    markup: `<rect width="96" height="96" fill="#2B5840"/>
<path d="M-8 96 L-8 40 Q0 18 22 18 Q44 18 50 34 Q58 30 62 40 Q74 52 70 70 Q68 88 52 96 Z" fill="#CFCCC4"/>
<ellipse cx="30" cy="58" rx="5.5" ry="6" fill="#242424"/>
<rect x="52" y="66" width="13" height="5.5" rx="2.7" fill="#242424" transform="rotate(-10 58 69)"/>`,
  },
  r2c4: {
    background: "#356699",
    markup: `<rect width="96" height="96" fill="#356699"/>
<circle cx="28" cy="56" r="46" fill="#EFD9AC"/>
<path d="M28 56 m-28 0 a28 28 0 1 1 56 0 a21 21 0 1 1 -42 0 a15 15 0 1 1 30 0 a9 9 0 1 1 -18 0" fill="none" stroke="#DCC08B" stroke-width="6" stroke-linecap="round"/>
<path d="M62 58 Q58 22 68 20 Q76 20 74 44 L72 58 Z" fill="#EFD9AC"/>
<path d="M78 58 Q76 26 85 26 Q93 28 90 50 L88 60 Z" fill="#EFD9AC"/>
<ellipse cx="68" cy="32" rx="2.8" ry="3.8" fill="#222"/>
<ellipse cx="85" cy="36" rx="2.8" ry="3.8" fill="#222"/>`,
  },
  r2c5: {
    background: "#204C83",
    markup: `<rect width="96" height="96" fill="#204C83"/>
<circle cx="38" cy="60" r="22" fill="#F5EBCB"/>
<circle cx="62" cy="46" r="26" fill="#F5EBCB"/>
<circle cx="24" cy="78" r="20" fill="#F5EBCB"/>
<circle cx="66" cy="80" r="26" fill="#F5EBCB"/>
<rect x="20" y="60" width="66" height="36" fill="#F5EBCB"/>
<circle cx="52" cy="72" r="3.8" fill="#20242C"/><circle cx="70" cy="72" r="3.8" fill="#20242C"/>
<path d="M55 82 q6 5 12 0" stroke="#20242C" stroke-width="4" fill="none" stroke-linecap="round"/>`,
  },
  r2c6: {
    background: "#8FA68A",
    markup: `<rect width="96" height="96" fill="#8FA68A"/>
<circle cx="26" cy="40" r="15" fill="#3B423B"/>
<circle cx="26" cy="42" r="9" fill="#F2ECDA"/><ellipse cx="28" cy="43" rx="4" ry="5" fill="#20241F"/>
<circle cx="76" cy="30" r="16" fill="#3B423B"/>
<circle cx="76" cy="32" r="10" fill="#F2ECDA"/><ellipse cx="77" cy="33" rx="4.4" ry="5.5" fill="#20241F"/>
<path d="M2 96 L2 66 Q6 44 30 46 Q44 30 66 36 Q92 40 94 66 L94 96 Z" fill="#40473F"/>
<path d="M30 72 q22 10 44 -4" stroke="#20241F" stroke-width="4.5" fill="none" stroke-linecap="round"/>`,
  },
  r3c0: {
    background: "#F0633C",
    markup: `<rect width="96" height="96" fill="#F0633C"/>
<path d="M-10 44 Q6 16 34 16 Q44 16 46 24 Q52 18 60 22 Q90 34 100 62 L100 100 L20 100 Q-8 76 -10 44 Z" fill="#25292E"/>
<path d="M34 22 Q40 14 46 20 Q50 25 44 30 Q38 33 34 28 Q31 25 34 22 Z" fill="#25292E"/>
<path d="M18 36 Q34 24 48 34 Q64 48 58 68 Q50 88 34 82 Q14 74 14 54 Q14 42 18 36 Z" fill="#EFE6CE"/>
<circle cx="40" cy="26" r="2.4" fill="#EFE6CE"/><circle cx="53" cy="30" r="2.4" fill="#EFE6CE"/>
<path d="M26 48 q7 1 11 6 M24 58 q7 1 11 6 M36 44 q7 1 11 6" stroke="#25292E" stroke-width="2.6" fill="none" stroke-linecap="round"/>`,
  },
  r3c1: {
    background: "#6E7967",
    markup: `<rect width="96" height="96" fill="#6E7967"/>
<circle cx="20" cy="34" r="13" fill="#EFE9D4"/>
<circle cx="72" cy="30" r="13" fill="#EFE9D4"/>
<ellipse cx="46" cy="78" rx="46" ry="48" fill="#F2EDDD"/>
<ellipse cx="24" cy="62" rx="4.6" ry="5.6" fill="#2A2A28"/>
<ellipse cx="64" cy="60" rx="4.6" ry="5.6" fill="#2A2A28"/>
<ellipse cx="45" cy="82" rx="9" ry="7" fill="#33322E"/>`,
  },
  r3c2: {
    background: "#E6FBA7",
    markup: `<rect width="96" height="96" fill="#E6FBA7"/>
<path d="M26 96 L26 90 Q18 88 18 80 L18 40 Q18 22 40 22 L74 22 Q92 22 92 42 L92 96 Z" fill="#EE7429"/>
<path d="M30 96 Q30 88 38 88 Q46 88 46 96 Z" fill="#EE7429"/>
<path d="M62 96 Q62 88 70 88 Q78 88 78 96 Z" fill="#EE7429"/>
<rect x="30" y="28" width="46" height="7" rx="3.5" fill="#5B3013"/>
<ellipse cx="42" cy="54" rx="5" ry="6.5" fill="#4A2812"/>
<ellipse cx="68" cy="54" rx="5" ry="6.5" fill="#4A2812"/>
<path d="M46 66 Q55 76 64 66 Q59 62 55 62 Q50 62 46 66 Z" fill="#4A2812"/>`,
  },
  r3c3: {
    background: "#63778D",
    markup: `<rect width="96" height="96" fill="#63778D"/>
<path d="M-8 96 L-8 52 Q-2 20 34 18 Q66 16 76 40 Q92 48 90 62 Q88 74 72 74 Q60 92 34 92 Z" fill="#F2ECDC"/>
<path d="M60 62 Q76 58 86 62 Q80 70 66 70 Z" fill="#E4DCC6"/>
<ellipse cx="32" cy="50" rx="3.6" ry="4.6" fill="#1D2226"/>`,
  },
  r3c4: {
    background: "#393F3B",
    markup: `<rect width="96" height="96" fill="#393F3B"/>
<path d="M20 62 L8 54 Q2 48 8 42 Q14 38 18 46 L26 56 Z" fill="#E96A45"/>
<path d="M62 46 Q84 42 88 58 Q92 74 76 80 L72 72 Q82 68 79 59 Q76 51 62 54 Z" fill="#E96A45"/>
<path d="M16 96 Q10 62 34 52 Q58 44 74 58 Q88 72 82 96 Z" fill="#E96A45"/>
<ellipse cx="48" cy="46" rx="20" ry="9" fill="#E96A45"/>
<circle cx="48" cy="36" r="8" fill="#E96A45"/>
<path d="M26 96 Q24 68 48 64 Q72 62 74 88 L74 96 Z" fill="#FBEFD8"/>
<circle cx="42" cy="78" r="3.2" fill="#B4472A"/><circle cx="57" cy="78" r="3.2" fill="#B4472A"/>
<path d="M44 86 q5 4 11 0" stroke="#B4472A" stroke-width="3.2" fill="none" stroke-linecap="round"/>`,
  },
  r3c5: {
    background: "#050505",
    markup: `<rect width="96" height="96" fill="#050505"/>
<path d="M14 48 Q10 24 18 20 Q25 17 30 28 Q38 24 48 24 Q58 24 64 28 Q70 17 77 21 Q84 25 80 48 Q84 56 84 64 Q84 88 48 88 Q12 88 12 64 Q12 55 14 48 Z" fill="#FBFBF7"/>
<rect x="34" y="58" width="8" height="13" rx="4" fill="#111"/>
<rect x="58" y="58" width="8" height="13" rx="4" fill="#111"/>
<ellipse cx="50" cy="76" rx="4.2" ry="3.4" fill="#111"/>`,
  },
  r3c6: {
    background: "#6D4C6E",
    markup: `<rect width="96" height="96" fill="#6D4C6E"/>
<path d="M18 96 Q14 34 48 22 Q68 16 78 34 Q90 56 88 96 L74 88 L60 96 L44 88 L30 96 Z" fill="#EFE3CD"/>
<ellipse cx="46" cy="52" rx="7" ry="9" fill="#3C2B3C" transform="rotate(-8 46 52)"/>
<ellipse cx="68" cy="50" rx="7" ry="9" fill="#3C2B3C" transform="rotate(8 68 50)"/>`,
  },
  r4c0: {
    background: "#363C35",
    markup: `<rect width="96" height="96" fill="#363C35"/>
<circle cx="48" cy="11" r="6" fill="none" stroke="#7C90D8" stroke-width="4.5"/>
<path d="M14 54 Q14 18 48 18 Q82 18 82 54 L82 60 L14 60 Z" fill="#7C90D8"/>
<path d="M20 50 Q20 40 48 40 Q76 40 76 50 L76 66 Q76 72 68 72 L28 72 Q20 72 20 66 Z" fill="#F4EEDC"/>
<path d="M32 22 L32 40 M48 20 L48 40 M64 22 L64 40" stroke="#6B7EC6" stroke-width="3.6" stroke-linecap="round"/>
<path d="M12 60 Q10 70 22 70 L74 70 Q86 70 84 60 L84 66 Q84 74 74 74 L22 74 Q12 74 12 66 Z" fill="#7C90D8"/>
<path d="M18 72 Q14 86 20 92 Q27 96 28 84 L29 72 Z" fill="#7C90D8"/>
<path d="M36 74 L36 88 Q38 97 45 94 Q50 91 48 82 L48 74 Z" fill="#7C90D8"/>
<path d="M56 74 L56 84 Q58 94 65 90 Q69 86 67 78 L66 72 Z" fill="#7C90D8"/>
<path d="M74 70 L73 80 Q74 88 80 84 Q84 79 82 72 Z" fill="#7C90D8"/>
<path d="M36 52 q4 -5 8 0" stroke="#2C3140" stroke-width="3.2" fill="none" stroke-linecap="round"/>
<path d="M53 52 q4 -5 8 0" stroke="#2C3140" stroke-width="3.2" fill="none" stroke-linecap="round"/>
<path d="M43 60 q5 4 10 0" stroke="#2C3140" stroke-width="3.2" fill="none" stroke-linecap="round"/>`,
  },
  r4c1: {
    background: "#011A6D",
    markup: `<rect width="96" height="96" fill="#011A6D"/>
<path d="M12 96 Q6 84 14 78 Q8 40 34 26 Q58 14 74 34 Q88 52 84 78 Q92 84 84 92 L74 86 L62 94 L50 86 L38 96 L26 86 Z" fill="#F2E3BC"/>
<circle cx="40" cy="54" r="7.5" fill="#F06414"/>
<ellipse cx="64" cy="54" rx="9" ry="10" fill="#F06414"/>
<path d="M46 68 Q46 62 52 62 Q59 62 57 69 Q55 75 50 73 Q46 71 46 68 Z" fill="#F06414"/>`,
  },
  r4c2: {
    background: "#000000",
    markup: `<rect width="96" height="96" fill="#000000"/>
<path d="M28 60 Q30 44 40 42 Q46 40 48 46 Q58 42 68 46 Q72 40 78 42 Q86 46 84 58 Q92 66 90 76 Q88 96 60 96 L34 96 Q26 84 28 60 Z" fill="#FCFCFA"/>
<circle cx="52" cy="74" r="3.2" fill="#111"/><circle cx="76" cy="72" r="3.2" fill="#111"/>
<path d="M60 80 l4 3 l4 -3" stroke="#111" stroke-width="2.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  r4c3: {
    background: "#6F3CED",
    markup: `<rect width="96" height="96" fill="#6F3CED"/>
<ellipse cx="32" cy="74" rx="46" ry="48" fill="#F7F5F2"/>
<path d="M6 74 Q4 46 22 42 Q30 40 34 46 Q40 40 48 44 Q60 50 58 68 Q56 86 36 88 Q10 90 6 74 Z" fill="#3C3A44"/>
<rect x="22" y="56" width="6.5" height="13" rx="3.2" fill="#F7F5F2"/>
<rect x="42" y="56" width="6.5" height="13" rx="3.2" fill="#F7F5F2"/>
<rect x="28" y="74" width="13" height="7" rx="3.5" fill="#F7F5F2"/>`,
  },
  r4c4: {
    background: "#764750",
    markup: `<rect width="96" height="96" fill="#764750"/>
<path d="M22 52 Q8 20 20 12 Q30 6 36 30 L40 50 Z" fill="#F2E8D4"/>
<path d="M52 50 Q54 10 68 6 Q80 4 76 28 Q72 46 62 54 Z" fill="#F2E8D4"/>
<ellipse cx="42" cy="84" rx="44" ry="44" fill="#F5EDDD"/>
<ellipse cx="22" cy="72" rx="4.6" ry="5.6" fill="#26221E"/>
<ellipse cx="58" cy="72" rx="4.6" ry="5.6" fill="#26221E"/>
<path d="M36 82 l4 4 l4 -4" stroke="#26221E" stroke-width="3.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M40 86 v5" stroke="#26221E" stroke-width="3" stroke-linecap="round"/>`,
  },
  r4c5: {
    background: "#5C76D4",
    markup: `<rect width="96" height="96" fill="#5C76D4"/>
<path d="M20 32 Q4 28 6 40 Q8 50 22 46 Z M18 52 Q2 52 6 62 Q10 70 24 62 Z M24 68 Q12 74 18 82 Q24 88 32 78 Z" fill="#333A45"/>
<path d="M70 30 Q86 24 88 36 Q88 46 74 44 Z M78 48 Q94 48 90 58 Q86 66 74 60 Z M74 64 Q86 70 80 78 Q74 84 66 76 Z" fill="#333A45"/>
<ellipse cx="48" cy="54" rx="30" ry="28" fill="#F7F4EE"/>
<path d="M58 78 Q76 82 76 96 L36 96 Q36 82 46 78 Z" fill="#F7F4EE"/>
<circle cx="42" cy="52" r="5" fill="#17181B"/><circle cx="44" cy="50" r="1.8" fill="#fff"/>
<path d="M50 60 q6 3 11 -2" stroke="#17181B" stroke-width="3.4" fill="none" stroke-linecap="round"/>`,
  },
  r4c6: {
    background: "#050505",
    markup: `<rect width="96" height="96" fill="#050505"/>
<ellipse cx="34" cy="72" rx="38" ry="38" fill="#FCFCFA"/>
<path d="M50 40 Q70 34 76 54 Q80 74 66 80 Q54 84 50 72 Q44 52 50 40 Z" fill="#FCFCFA"/>
<circle cx="18" cy="64" r="4" fill="#111"/><circle cx="44" cy="62" r="4" fill="#111"/>
<path d="M25 76 L37 76 L31 83 Z" fill="#111"/>
<path d="M24 88 q4 4 8 0 M32 88 q4 4 8 0" stroke="#111" stroke-width="3" fill="none" stroke-linecap="round"/>`,
  },
};
