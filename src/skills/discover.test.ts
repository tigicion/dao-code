import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  discoverSkillDirsForPath,
  initConditionalPool,
  activateConditionalSkillsForPaths,
  resetDiscoveryState,
  pendingConditionalCount,
} from "./discover.js";
import type { Skill } from "./skills.js";

function mkSkill(name: string, paths?: string[]): Skill {
  return {
    name,
    description: `skill ${name}`,
    slug: name.toLowerCase(),
    body: `body of ${name}`,
    dir: "/tmp",
    ...(paths?.length ? { paths } : {}),
  };
}

describe("initConditionalPool", () => {
  beforeEach(() => resetDiscoveryState());

  it("带 paths 的 skill 进入待激活池,不带 paths 的直接返回", () => {
    const skills = [mkSkill("a"), mkSkill("b", ["*.ts"]), mkSkill("c", ["src/**"])];
    const unconditional = initConditionalPool(skills);
    expect(unconditional.map((s) => s.name)).toEqual(["a"]);
    expect(pendingConditionalCount()).toBe(2);
  });

  it("空 paths 不进入待激活池", () => {
    const skills = [mkSkill("a", [])];
    const unconditional = initConditionalPool(skills);
    expect(unconditional.map((s) => s.name)).toEqual(["a"]);
    expect(pendingConditionalCount()).toBe(0);
  });
});

describe("activateConditionalSkillsForPaths", () => {
  beforeEach(() => resetDiscoveryState());

  it("匹配文件路径 -> 激活对应 skill,从池中移除", () => {
    const skills = [mkSkill("ts-skill", ["**/*.ts"]), mkSkill("py-skill", ["**/*.py"])];
    initConditionalPool(skills);
    expect(pendingConditionalCount()).toBe(2);

    const activated = activateConditionalSkillsForPaths(["/project/src/foo.ts"], "/project");
    expect(activated.map((s) => s.name)).toEqual(["ts-skill"]);
    expect(pendingConditionalCount()).toBe(1); // py-skill 仍在池中
  });

  it("不匹配任何路径 -> 返回空数组", () => {
    initConditionalPool([mkSkill("ts-skill", ["*.ts"])]);
    const activated = activateConditionalSkillsForPaths(["/project/src/foo.py"], "/project");
    expect(activated).toEqual([]);
    expect(pendingConditionalCount()).toBe(1);
  });

  it("已激活的 skill 不会被重复激活", () => {
    initConditionalPool([mkSkill("ts-skill", ["*.ts"])]);
    const first = activateConditionalSkillsForPaths(["/project/a.ts"], "/project");
    const second = activateConditionalSkillsForPaths(["/project/b.ts"], "/project");
    expect(first).toHaveLength(1);
    expect(second).toEqual([]); // 已经从池中移除了
  });

  it("多文件路径,匹配任一即激活", () => {
    initConditionalPool([mkSkill("ts-skill", ["*.ts"])]);
    const activated = activateConditionalSkillsForPaths(["/project/a.py", "/project/b.ts"], "/project");
    expect(activated).toHaveLength(1);
  });

  it("路径在 cwd 之外(../) -> 跳过", () => {
    initConditionalPool([mkSkill("ts-skill", ["*.ts"])]);
    const activated = activateConditionalSkillsForPaths(["/other/dir/a.ts"], "/project");
    expect(activated).toEqual([]);
  });

  it("无待激活 skill -> 直接返回空", () => {
    const activated = activateConditionalSkillsForPaths(["/project/a.ts"], "/project");
    expect(activated).toEqual([]);
  });
});

describe("discoverSkillDirsForPath", () => {
  let tmpDir: string;

  beforeEach(async () => {
    resetDiscoveryState();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dao-test-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("向上遍历找到 .dao/skills/ 目录", async () => {
    // 创建 tmpDir/sub/.dao/skills/
    const subDir = path.join(tmpDir, "sub");
    const skillDir = path.join(subDir, ".dao", "skills");
    await fs.mkdir(skillDir, { recursive: true });
    const filePath = path.join(subDir, "file.ts");
    const found = await discoverSkillDirsForPath(filePath, tmpDir);
    expect(found).toEqual([skillDir]);
  });

  it("跳过 node_modules 内的 .dao/skills/", async () => {
    const nmDir = path.join(tmpDir, "node_modules", "pkg", ".dao", "skills");
    await fs.mkdir(nmDir, { recursive: true });
    const filePath = path.join(tmpDir, "node_modules", "pkg", "index.ts");
    const found = await discoverSkillDirsForPath(filePath, tmpDir);
    expect(found).toEqual([]);
  });

  it("不含 cwd 本身(已启动时加载)", async () => {
    const skillDir = path.join(tmpDir, ".dao", "skills");
    await fs.mkdir(skillDir, { recursive: true });
    const filePath = path.join(tmpDir, "file.ts");
    const found = await discoverSkillDirsForPath(filePath, tmpDir);
    expect(found).toEqual([]); // cwd 级不发现
  });

  it("已检查过的目录不重复发现", async () => {
    const subDir = path.join(tmpDir, "sub");
    const skillDir = path.join(subDir, ".dao", "skills");
    await fs.mkdir(skillDir, { recursive: true });
    const filePath = path.join(subDir, "file.ts");
    const first = await discoverSkillDirsForPath(filePath, tmpDir);
    const second = await discoverSkillDirsForPath(filePath, tmpDir);
    expect(first).toHaveLength(1);
    expect(second).toEqual([]); // 已检查过
  });

  it("目录不存在 -> 返回空", async () => {
    const filePath = path.join(tmpDir, "sub", "deep", "file.ts");
    const found = await discoverSkillDirsForPath(filePath, tmpDir);
    expect(found).toEqual([]);
  });
});
