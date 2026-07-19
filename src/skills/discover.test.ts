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

  it("启动预扫描命中的 skill(paths 已被调用方清空)只出现一次,不用调用方再手动 push 一次", () => {
    // 复刻 index.ts 的实际用法:启动预扫描匹配到的 skill,调用方会传一份 paths:undefined 的克隆
    // 进来(模拟"已经预激活,不该再进待激活池")。之前 index.ts 在这之后还有一个额外的 for 循环
    // 把原始(paths 未清空)的那份也 push 了一次,导致同一个 skill 出现两次——这里验证只调用
    // initConditionalPool 一次、不做那个额外 push,该 skill 也已经完整地出现在返回值里。
    const preMatched = mkSkill("b", ["*.ts"]); // 假设启动预扫描已经匹配到它
    const skillsForPool = [mkSkill("a"), { ...preMatched, paths: undefined }];
    const skills = initConditionalPool(skillsForPool);
    expect(skills.filter((s) => s.name === "b")).toHaveLength(1);
    expect(skills.map((s) => s.name)).toEqual(["a", "b"]);
    expect(pendingConditionalCount()).toBe(0); // 没有真正带 paths 的 skill 进池
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

  it("目录当时不存在,之后建了 -> 后续调用能发现(不永久负缓存)", async () => {
    const subDir = path.join(tmpDir, "sub");
    const filePath = path.join(subDir, "file.ts");
    await fs.mkdir(subDir, { recursive: true });
    const first = await discoverSkillDirsForPath(filePath, tmpDir);
    expect(first).toEqual([]); // 这时 .dao/skills 还没建
    const skillDir = path.join(subDir, ".dao", "skills");
    await fs.mkdir(skillDir, { recursive: true }); // 用户/工具中途建了 skill 目录
    const second = await discoverSkillDirsForPath(filePath, tmpDir);
    expect(second).toEqual([skillDir]); // 应该能发现,不是被第一次的"不存在"结果永久卡住
  });
});
