import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { installSkills } from "./install.js";

let src: string, ws: string;
beforeEach(async () => {
  src = await fs.mkdtemp(path.join(os.tmpdir(), "dao-skillsrc-"));
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "dao-skillws-"));
});
afterEach(async () => {
  await fs.rm(src, { recursive: true, force: true });
  await fs.rm(ws, { recursive: true, force: true });
});

const mkSkill = async (dir: string, name: string, body: string) => {
  await fs.mkdir(path.join(dir, name), { recursive: true });
  await fs.writeFile(path.join(dir, name, "SKILL.md"), body, "utf8");
};

describe("installSkills(本地路径,project 层)", () => {
  it("复制含 SKILL.md 的技能到 .dao/skills,跳过缺 frontmatter 的", async () => {
    await fs.mkdir(path.join(src, "skills"), { recursive: true });
    await mkSkill(path.join(src, "skills"), "tdd", "---\nname: tdd\ndescription: x\n---\n用 `Read` 和 superpowers:debug");
    await mkSkill(path.join(src, "skills"), "nofm", "没有 frontmatter 的正文");
    let out = "";
    await installSkills(src, "project", ws, (s) => { out += s; });
    // tdd 安装、nofm 跳过
    expect(await fs.readFile(path.join(ws, ".dao", "skills", "tdd", "SKILL.md"), "utf8")).toContain("name: tdd");
    await expect(fs.stat(path.join(ws, ".dao", "skills", "nofm"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(out).toContain("安装 1 个技能");
    expect(out).toContain("缺 frontmatter");
    // 外来工具名不再在装载时枚举(无字典);首次加载时由模型按用途转换。
    expect(out).toContain("自动按用途转换工具名");
  });

  it("源里没有 SKILL.md → 明确提示", async () => {
    let out = "";
    await installSkills(src, "project", ws, (s) => { out += s; });
    expect(out).toContain("未找到");
  });
});
