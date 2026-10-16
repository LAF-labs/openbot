import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShopStore } from "../src/account/shop";
import {
  type BuiltInSkill,
  readBuiltInSkills,
} from "../src/plugins/built-in-skills";
import {
  deploymentOwnerOf,
  HUB_PACK_PROFILE,
  HUB_SKILL_LIMITS,
  hubSkillWrites,
  type IndustryPack,
  orderedByPack,
  packFor,
  parseIndustryPack,
  readIndustryPacks,
  withPackOnKindChange,
} from "../src/plugins/industry-packs";
import { ROUTINE_SUGGESTIONS } from "../src/routines/suggestion-catalog";
import { BUSINESS_KINDS } from "../../shared/shop/catalogue";

/**
 * The industry packs the package ships (`tenant/laf/profiles/<kind>/`), read the way the server reads
 * them at boot, and the three things a pack decides: which skills a person's VM carries, which
 * routine suggestions come first, and what a company's hub is written.
 */

const PACKAGE = join(import.meta.dir, "../../tenant/laf");
const read = () =>
  readIndustryPacks(PACKAGE, { suggestions: ROUTINE_SUGGESTIONS });

/**
 * What choosing each kind installs on a person's VM. `adds` are the pack's own skills, which arrive
 * with the kind and leave with it; `alreadyEveryones` are package skills the pack names, which every
 * deployment carries whatever the kind (a pack never hides one); `first` is the order the routine
 * suggestions are offered in before the rest of the catalogue.
 */
const INSTALLS: Record<
  string,
  { adds: string[]; alreadyEveryones: string[]; first: string[] }
> = {
  food: {
    adds: ["음식점카페"],
    alreadyEveryones: ["네이버블로그", "세금노무"],
    first: [
      "store-open-check",
      "review-watch",
      "weekly-settlement",
      "booking-check",
      "morning-brief",
    ],
  },
  online: {
    adds: ["온라인판매"],
    alreadyEveryones: ["쇼핑가격", "세금노무"],
    first: [
      "unanswered-enquiries",
      "delivery-delay",
      "stock-check",
      "weekly-settlement",
      "competitor-price",
      "ad-spend",
    ],
  },
  store: {
    adds: ["매장판매"],
    alreadyEveryones: ["쇼핑가격", "네이버블로그", "세금노무"],
    first: [
      "review-watch",
      "unanswered-enquiries",
      "weekly-settlement",
      "stock-check",
      "competitor-price",
    ],
  },
  beauty: {
    adds: ["미용뷰티"],
    alreadyEveryones: ["네이버블로그", "세금노무"],
    first: [
      "booking-check",
      "review-watch",
      "unanswered-enquiries",
      "morning-brief",
    ],
  },
  education: {
    adds: ["학원교육"],
    alreadyEveryones: ["세금노무"],
    first: ["unanswered-enquiries", "booking-check", "tax-calendar"],
  },
  health: {
    adds: ["병원약국"],
    alreadyEveryones: ["세금노무"],
    first: [
      "booking-check",
      "review-watch",
      "unanswered-enquiries",
      "tax-calendar",
    ],
  },
  office: {
    adds: ["사무전문직"],
    alreadyEveryones: ["세금노무", "네이버뉴스"],
    first: [
      "unanswered-enquiries",
      "booking-check",
      "tax-calendar",
      "morning-brief",
    ],
  },
  other: { adds: [], alreadyEveryones: [], first: [] },
};

describe("the packs the package ships", () => {
  test("there is one for every kind the shop catalogue has, and no other", async () => {
    const packs = await read();
    expect(packs.map((pack) => pack.kind)).toEqual(
      BUSINESS_KINDS.map((kind) => kind.id),
    );
    expect(Object.keys(INSTALLS).sort()).toEqual(
      BUSINESS_KINDS.map((kind) => kind.id).sort(),
    );
  });

  test.each(Object.keys(INSTALLS))(
    "choosing %s installs what its table row says",
    async (kind) => {
      const pack = packFor(await read(), kind as IndustryPack["kind"]);
      if (!pack) throw new Error(`no pack for ${kind}`);
      const packageSlugs = new Set(
        (await readBuiltInSkills(PACKAGE)).map((skill) => skill.slug),
      );
      const expected = INSTALLS[kind];
      expect(pack.own.map((skill) => skill.slug)).toEqual(expected?.adds ?? []);
      expect(pack.skills.filter((slug) => packageSlugs.has(slug))).toEqual(
        expected?.alreadyEveryones ?? [],
      );
      expect(pack.routineSuggestions).toEqual(expected?.first ?? []);
      // The places are the shop catalogue's own list, not a copy that could drift from it.
      expect(pack.places).toBe(
        BUSINESS_KINDS.find((one) => one.id === kind)?.places ?? [],
      );
    },
  );

  test("a pack's own skill is one line in the index and a body worth opening", async () => {
    for (const pack of await read()) {
      for (const skill of pack.own) {
        // The prompt's index cuts a line at 80 characters (`built-in-skills.test.ts`).
        expect(skill.summary.length).toBeLessThanOrEqual(80);
        expect(skill.instructions.length).toBeGreaterThan(100);
        expect(skill.requires).toBeUndefined();
      }
    }
  });

  test("every kind is a profile name the hub takes, and every version fits its column", async () => {
    for (const pack of await read()) {
      expect(HUB_PACK_PROFILE.test(pack.kind)).toBe(true);
      expect(pack.version.length).toBeLessThanOrEqual(40);
      expect(pack.version).toMatch(/^1\+[0-9a-f]{12}$/);
    }
  });
});

const skill = (
  slug: string,
  extra: Partial<BuiltInSkill> = {},
): BuiltInSkill => ({
  slug,
  title: `${slug} 제목`,
  summary: `${slug} 한 줄`,
  instructions: `${slug} 본문`,
  ...extra,
});

const parse = (
  text: string,
  own: BuiltInSkill[] = [skill("가게일")],
  packageSkills: BuiltInSkill[] = [
    skill("세금노무"),
    skill("지원사업", { requires: ["search_support_programs"] }),
  ],
) =>
  parseIndustryPack({
    kind: "food",
    file: "profiles/food/profile.yaml",
    text,
    own,
    packageSkills,
    suggestions: ROUTINE_SUGGESTIONS,
  });

describe("a pack that is wrong fails by name", () => {
  const good =
    'version: "1"\nskills: [가게일, 세금노무]\nroutine_suggestions: [review-watch]\n';

  test("a good one reads", () => {
    const pack = parse(good);
    expect(pack.skills).toEqual(["가게일", "세금노무"]);
    expect(pack.routineSuggestions).toEqual(["review-watch"]);
  });

  test.each([
    ["an unquoted version", good.replace('"1"', "1"), "version"],
    ["a field nothing reads", `${good}places: [instagram]\n`, "places"],
    ["a skill nobody ships", good.replace("세금노무", "없는것"), "없는것"],
    [
      "its own skill left out of the list",
      good.replace("가게일, ", ""),
      "leaves out",
    ],
    [
      "a skill that needs a tool",
      good.replace("세금노무", "지원사업"),
      "needs a tool",
    ],
    [
      "a suggestion the catalogue has no key for",
      good.replace("review-watch", "no-such-card"),
      "no-such-card",
    ],
    ["a skill named twice", good.replace("세금노무", "가게일"), "twice"],
  ])("%s", (_name, text, says) => {
    expect(() => parse(text)).toThrow(says);
    expect(() => parse(text)).toThrow("profiles/food/profile.yaml");
  });

  test("its own skill under a package skill's name is refused", () => {
    expect(() =>
      parse('version: "1"\nskills: [세금노무]\n', [skill("세금노무")]),
    ).toThrow("takes a package name");
  });

  test("a hub limit broken is refused here, not at a team's install", () => {
    const long = skill("가게일", {
      instructions: "가".repeat(HUB_SKILL_LIMITS.instructions + 1),
    });
    expect(() => parse(good, [long])).toThrow("longer than a team skill");
  });

  test("a directory that is not a kind, and a kind with no pack, fail the read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "laf-packs-"));
    try {
      await mkdir(join(dir, "profiles", "bakery"), { recursive: true });
      await expect(
        readIndustryPacks(dir, {
          packageSkills: [],
          suggestions: ROUTINE_SUGGESTIONS,
        }),
      ).rejects.toThrow("bakery is not a kind");
      await rm(join(dir, "profiles", "bakery"), { recursive: true });
      await mkdir(join(dir, "profiles", "food"), { recursive: true });
      await writeFile(
        join(dir, "profiles", "food", "profile.yaml"),
        'version: "1"\n',
      );
      await expect(
        readIndustryPacks(dir, {
          packageSkills: [],
          suggestions: ROUTINE_SUGGESTIONS,
        }),
      ).rejects.toThrow("profiles/online/profile.yaml: missing");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("text changed under the same number is a new version", () => {
    const before = parse(good);
    const after = parse(good, [skill("가게일", { instructions: "고친 본문" })]);
    expect(after.version.startsWith("1+")).toBe(true);
    expect(after.version).not.toBe(before.version);
    expect(parse(good).version).toBe(before.version);
  });
});

describe("routine suggestions in a kind's order", () => {
  const catalogue = ["a", "b", "c", "d"].map((key) => ({ key }));

  test("the pack's first, in its order, then the rest in the catalogue's", () => {
    expect(orderedByPack(catalogue, ["c", "a"]).map((one) => one.key)).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
  });

  test("a key the catalogue lacks moves nothing and adds nothing", () => {
    expect(orderedByPack(catalogue, ["x"]).map((one) => one.key)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(orderedByPack(catalogue, []).map((one) => one.key)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });
});

describe("whose kind the deployment installs", () => {
  test("the one owner of the live Bots", () => {
    expect(deploymentOwnerOf(["u1"])).toBe("u1");
  });

  test("nobody, or two owners, installs no pack", () => {
    expect(deploymentOwnerOf([])).toBeNull();
    expect(deploymentOwnerOf([null])).toBeNull();
    expect(deploymentOwnerOf(["u1", "u2"])).toBeNull();
  });
});

describe("a saved answer that changes the kind runs the reconcile", () => {
  const storeHolding = (kind: "food" | "online" | null) => {
    let held = { kind, places: [] as string[] };
    return {
      read: async () => held,
      save: async (_user: string, shop: typeof held) => {
        held = { kind: shop.kind, places: [...shop.places] };
        return held;
      },
    } as unknown as ShopStore;
  };

  test("음식점·카페 → 온라인 판매 runs it once", async () => {
    let runs = 0;
    const store = withPackOnKindChange(storeHolding("food"), async () => {
      runs += 1;
    });
    await store.save("u1", { kind: "online", places: [] });
    expect(runs).toBe(1);
  });

  test("a save that keeps the kind and changes the places runs nothing", async () => {
    let runs = 0;
    const store = withPackOnKindChange(storeHolding("food"), async () => {
      runs += 1;
    });
    await store.save("u1", { kind: "food", places: ["instagram"] });
    expect(runs).toBe(0);
  });
});

describe("a pack into a company's hub", () => {
  const pack: IndustryPack = {
    kind: "food",
    version: "1+aaaaaaaaaaaa",
    places: [],
    skills: ["가게일", "세금노무"],
    own: [skill("가게일")],
    routineSuggestions: [],
  };
  const texts = [skill("가게일"), skill("세금노무")];
  const entry = (
    slug: string,
    fields: Partial<{
      profile: string | null;
      shippedVersion: string | null;
      edited: boolean;
    }>,
  ) => ({
    slug,
    profile: "food",
    shippedVersion: "1+aaaaaaaaaaaa",
    edited: false,
    ...fields,
  });

  test("an empty hub is written every skill, as the pack's", () => {
    const { writes, kept } = hubSkillWrites(pack, texts, []);
    expect(kept).toEqual([]);
    expect(writes).toEqual([
      {
        slug: "가게일",
        method: "PUT",
        path: `/hub/v1/skills/${encodeURIComponent("가게일")}`,
        body: {
          title: "가게일 제목",
          summary: "가게일 한 줄",
          instructions: "가게일 본문",
          pack: { profile: "food", version: "1+aaaaaaaaaaaa" },
        },
      },
      {
        slug: "세금노무",
        method: "PUT",
        path: `/hub/v1/skills/${encodeURIComponent("세금노무")}`,
        body: {
          title: "세금노무 제목",
          summary: "세금노무 한 줄",
          instructions: "세금노무 본문",
          pack: { profile: "food", version: "1+aaaaaaaaaaaa" },
        },
      },
    ]);
  });

  test("a skill the team edited is never written over, and says a newer one is there", () => {
    const { writes, kept } = hubSkillWrites(pack, texts, [
      entry("가게일", { shippedVersion: "1+000000000000", edited: true }),
      entry("세금노무", { shippedVersion: "1+000000000000" }),
    ]);
    expect(kept).toEqual([{ slug: "가게일", reason: "edited", newer: true }]);
    expect(writes.map((write) => write.slug)).toEqual(["세금노무"]);
  });

  test("the team's own skill by that name, another pack's, and one already current are left", () => {
    const { writes, kept } = hubSkillWrites(pack, texts, [
      entry("가게일", { profile: null, shippedVersion: null }),
      entry("세금노무", { profile: "online" }),
    ]);
    expect(writes).toEqual([]);
    expect(kept).toEqual([
      { slug: "가게일", reason: "team", newer: false },
      { slug: "세금노무", reason: "other-pack", newer: false },
    ]);
    expect(
      hubSkillWrites(pack, texts, [entry("가게일", {}), entry("세금노무", {})])
        .kept,
    ).toEqual([
      { slug: "가게일", reason: "current", newer: false },
      { slug: "세금노무", reason: "current", newer: false },
    ]);
  });
});
