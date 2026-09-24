import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  normalizeSkillName,
  SKILL_SLUG_PATTERN,
  skillSlugOf,
} from "../../shared/tools/skills";
import { slashCommandTrigger } from "../src/components/channels/composer/triggers";
import { ko } from "../src/lib/i18n-ko";
import { SKILL_REFUSALS } from "../src/lib/plugins/refusals";
import { skillFormSchema } from "../src/lib/skills/form";
import {
  agentFixture,
  APP_DOM_TIMEOUT_MS,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";

/**
 * A SKILL CAN BE CALLED /리뷰답장, AND THE SCREEN TALKS ABOUT A SHOP'S WEEK.
 *
 * Measured 2026-09-24 (UI/UX audit 0.5.3, item 11): the new-skill form's examples were "standup",
 * "나의 스탠드업 스킬" and "어제 한 일을 스탠드업 업데이트로 바꿉니다", and the command had to match
 * `^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$`, so "/리뷰답장" was refused before the server ever saw it. And
 * with one Bot, a saved skill did nothing until the person found the second step of granting it.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
afterAll(async () => {
  await unmountApps();
  await removeAppDom();
});

const valid = (slug: string) =>
  skillFormSchema.safeParse({
    slug,
    title: "리뷰 답장 쓰기",
    summary: "",
    instructions: "새 리뷰마다 답글 초안을 써 줘.",
  }).success;

describe("the command's shape", () => {
  test("Korean, lower-case letters, digits and hyphens; not spaces, capitals, or a slash", () => {
    for (const slug of ["리뷰답장", "리뷰-답장", "주간정산2", "review-reply"]) {
      expect(valid(slug)).toBe(true);
    }
    for (const slug of ["리뷰 답장", "리뷰/답장", "Review", "-리뷰", "리"]) {
      expect(valid(slug)).toBe(false);
    }
    // The form's rule is the server's, not a copy of it.
    expect(SKILL_SLUG_PATTERN.test("리뷰답장")).toBe(true);
  });

  test("one spelling, however the Hangul arrived", () => {
    const decomposed = "리뷰답장".normalize("NFD");
    expect(decomposed).not.toBe("리뷰답장");
    expect(skillSlugOf(` ${decomposed} `)).toBe("리뷰답장");
    expect(normalizeSkillName(`/${decomposed}`)).toBe("리뷰답장");
  });

  test("the refusal says Korean is allowed, in Korean", () => {
    const sentence = SKILL_REFUSALS["laf:skill_slug_invalid"] ?? "";
    expect(sentence).toContain("Korean");
    expect(ko[sentence]).toContain("한글");
  });

  test("the / menu finds a Korean command by what is typed after the slash", () => {
    const trigger = slashCommandTrigger(() => [
      {
        id: "리뷰답장",
        name: "리뷰답장",
        description: "새 리뷰에 정중한 답글 초안",
        kind: "chip",
      },
      { id: "재고정리", name: "재고정리", description: "", kind: "chip" },
    ]);
    const found = (query: string) =>
      (
        trigger.onSearch?.(query, {
          signal: new AbortController().signal,
        }) as Array<{ value: string }> | undefined
      )?.map((suggestion) => suggestion.value);
    expect(found("리뷰")).toEqual(["리뷰답장"]);
    expect(found("재고")).toEqual(["재고정리"]);
  });
});

describe("with one Bot", () => {
  const BOT = agentFixture({ id: "agent_one", name: "연남이" });

  test("a saved skill is given to it, under the name as the server keeps it", async () => {
    const app = await mountApp({
      path: "/skills?new=true",
      api: (request) => {
        if (request.pathname === "/api/agents") return json({ agents: [BOT] });
        if (request.pathname === "/api/plugins" && request.method === "GET") {
          return json({ catalogue: [], servers: [], skills: [] });
        }
        if (request.method === "POST") {
          return json({ ok: true, skills: [] });
        }
        return undefined;
      },
    });
    await app.waitFor(
      () => (app.main()?.textContent ?? "").includes("연남이"),
      "the one-Bot sentence",
    );
    const text = app.host.textContent ?? "";
    expect(text).toContain(
      "Something you ask 연남이 for often, saved under a name.",
    );
    expect(text).not.toContain("standup");

    const field = (name: string) =>
      app.host.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        `[name="${name}"]`,
      );
    const slug = field("slug");
    const title = field("title");
    const instructions = field("instructions");
    if (!slug || !title || !instructions) throw new Error("no form fields");
    await app.type(slug, "리뷰답장".normalize("NFD"));
    await app.type(title, "리뷰 답장 쓰기");
    await app.type(instructions, "새 리뷰마다 정중한 답글 초안을 써 줘.");
    const save = app.buttonNamed("Save skill");
    if (!save) throw new Error("no Save skill");
    await app.click(save);
    await app.waitFor(
      () =>
        app.requests.some(
          (request) => request.pathname === "/api/plugins/grants",
        ),
      "the grant",
    );

    const posts = app.requests.filter((request) => request.method === "POST");
    expect(posts.map((request) => request.pathname)).toEqual([
      "/api/plugins/skills",
      "/api/plugins/grants",
    ]);
    expect(posts[1]?.body).toEqual({
      kind: "skill",
      ref: "리뷰답장",
      agentId: "agent_one",
    });
    await app.unmount();
    // A whole screen, typed into and saved: longer than the runner's five seconds on a cold start.
  }, 20_000);
});
