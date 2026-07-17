import { describe, it, expect } from "vitest";
import { parseRule, ruleMatches, evaluate, splitBashCommands } from "./rules.js";

describe("parseRule", () => {
  it("裸工具名(无 specifier)", () => {
    expect(parseRule("Bash")).toEqual({ tool: "Bash" });
  });
  it("带 specifier", () => {
    expect(parseRule("Bash(npm run test:*)")).toEqual({ tool: "Bash", specifier: "npm run test:*" });
    expect(parseRule("Edit(src/**)")).toEqual({ tool: "Edit", specifier: "src/**" });
    expect(parseRule("WebFetch(domain:example.com)")).toEqual({ tool: "WebFetch", specifier: "domain:example.com" });
  });
  it("MCP 工具名(无括号)", () => {
    expect(parseRule("mcp__server__tool")).toEqual({ tool: "mcp__server__tool" });
  });
});

describe("ruleMatches — Bash 命令前缀/精确", () => {
  const m = (rule: string, value: string) => ruleMatches(parseRule(rule), { ccTool: "Bash", value });
  it("裸 Bash 匹配任意命令", () => {
    expect(m("Bash", "rm -rf /")).toBe(true);
  });
  it(":* 前缀匹配", () => {
    expect(m("Bash(npm run test:*)", "npm run test")).toBe(true);
    expect(m("Bash(npm run test:*)", "npm run test -- --watch")).toBe(true);
    expect(m("Bash(npm run test:*)", "npm install")).toBe(false);
  });
  it("无 :* 时精确匹配", () => {
    expect(m("Bash(git status)", "git status")).toBe(true);
    expect(m("Bash(git status)", "git status -s")).toBe(false);
  });
  it("工具名不同不匹配", () => {
    expect(ruleMatches(parseRule("Bash"), { ccTool: "Read", value: "x" })).toBe(false);
  });
});

describe("ruleMatches — 路径 gitignore-glob", () => {
  const m = (rule: string, value: string) => ruleMatches(parseRule(rule), { ccTool: "Edit", value });
  it("** 深层匹配", () => {
    expect(m("Edit(src/**)", "src/a/b.ts")).toBe(true);
    expect(m("Edit(src/**)", "lib/x.ts")).toBe(false);
  });
  it("* 单段匹配(任意目录的同名)", () => {
    expect(ruleMatches(parseRule("Read(*.env)"), { ccTool: "Read", value: ".env" })).toBe(true);
    expect(ruleMatches(parseRule("Read(*.env)"), { ccTool: "Read", value: "secret.env" })).toBe(true);
    expect(ruleMatches(parseRule("Read(*.env)"), { ccTool: "Read", value: "config.json" })).toBe(false);
  });
  it("绝对路径 glob", () => {
    expect(ruleMatches(parseRule("Read(//tmp/**)"), { ccTool: "Read", value: "/tmp/x/y" })).toBe(true);
  });
});

describe("ruleMatches — WebFetch domain", () => {
  const m = (value: string) => ruleMatches(parseRule("WebFetch(domain:example.com)"), { ccTool: "WebFetch", value });
  it("精确域名", () => expect(m("https://example.com/page")).toBe(true));
  it("子域名", () => expect(m("https://api.example.com/x")).toBe(true));
  it("其它域名不匹配", () => expect(m("https://evil.com")).toBe(false));
});

describe("evaluate — deny > ask > allow > 未匹配", () => {
  const id = { ccTool: "Bash", value: "rm -rf /" };
  it("deny 命中即拒绝(即使 allow 也命中)", () => {
    expect(evaluate({ allow: ["Bash"], ask: [], deny: ["Bash(rm:*)"] }, id)).toBe("deny");
  });
  it("ask 命中优先于 allow", () => {
    expect(evaluate({ allow: ["Bash"], ask: ["Bash(rm:*)"], deny: [] }, id)).toBe("ask");
  });
  it("仅 allow 命中", () => {
    expect(evaluate({ allow: ["Bash(rm:*)"], ask: [], deny: [] }, id)).toBe("allow");
  });
  it("无规则命中 → null", () => {
    expect(evaluate({ allow: ["Bash(npm:*)"], ask: [], deny: [] }, id)).toBeNull();
  });
});

describe("splitBashCommands — 复合命令拆分", () => {
  it("按 && || ; | 换行 拆分并去空白", () => {
    expect(splitBashCommands("cd /tmp && rm -rf x")).toEqual(["cd /tmp", "rm -rf x"]);
    expect(splitBashCommands("a || b ; c | d")).toEqual(["a", "b", "c", "d"]);
    expect(splitBashCommands("npm test")).toEqual(["npm test"]);
  });
});

describe("evaluate — Bash 复合命令逐段检查(CC 行为)", () => {
  it("任一子命令命中 deny → 整条 deny(绕不过)", () => {
    const id = { ccTool: "Bash", value: "cd /tmp && rm -rf /" };
    expect(evaluate({ allow: ["Bash(cd:*)"], ask: [], deny: ["Bash(rm -rf:*)"] }, id)).toBe("deny");
  });
  it("全部子命令被 allow → allow", () => {
    const id = { ccTool: "Bash", value: "npm i && git status" };
    expect(evaluate({ allow: ["Bash(npm:*)", "Bash(git:*)"], ask: [], deny: [] }, id)).toBe("allow");
  });
  it("有子命令未被 allow 覆盖 → null(不自动放行,落到询问)", () => {
    const id = { ccTool: "Bash", value: "npm run build && rm -rf x" };
    expect(evaluate({ allow: ["Bash(npm run build)"], ask: [], deny: [] }, id)).toBeNull();
  });
  it("任一子命令命中 ask(无 deny)→ ask", () => {
    const id = { ccTool: "Bash", value: "npm i && deploy" };
    expect(evaluate({ allow: ["Bash(npm:*)"], ask: ["Bash(deploy)"], deny: [] }, id)).toBe("ask");
  });
});

// ============================================================================
// 安全机制测试:环境变量剥离、安全包装器剥离、词边界、复合命令前缀免疫、重定向剥离
// ============================================================================

describe("ruleMatches — Bash 词边界(ls:* 不匹配 lsof)", () => {
  const m = (rule: string, value: string) => ruleMatches(parseRule(rule), { ccTool: "Bash", value });
  it("前缀后必须跟空白或到串尾", () => {
    expect(m("Bash(ls:*)", "ls -la")).toBe(true);
    expect(m("Bash(ls:*)", "ls")).toBe(true);
    expect(m("Bash(ls:*)", "lsof")).toBe(false);
    expect(m("Bash(ls:*)", "lsattr")).toBe(false);
  });
  it("git commit 前缀不匹配 git config", () => {
    expect(m("Bash(git commit:*)", "git commit -m fix")).toBe(true);
    expect(m("Bash(git commit:*)", "git config user.name")).toBe(false);
  });
});

describe("ruleMatches — Bash xargs 透传", () => {
  const m = (rule: string, value: string) => ruleMatches(parseRule(rule), { ccTool: "Bash", value });
  it("裸 xargs 后跟的命令也匹配前缀规则", () => {
    expect(m("Bash(grep:*)", "xargs grep pattern")).toBe(true);
    expect(m("Bash(grep:*)", "xargs grep -r pattern")).toBe(true);
  });
  it("xargs 带 flag 不匹配(flag 存在说明不是裸透传)", () => {
    expect(m("Bash(grep:*)", "xargs -n1 grep pattern")).toBe(false);
  });
  it("deny 规则也通过 xargs 透传", () => {
    expect(m("Bash(rm:*)", "xargs rm file")).toBe(true);
  });
});

describe("evaluate — 安全包装器剥离(对标 CC stripSafeWrappers)", () => {
  it("deny 规则穿透 timeout 包装器", () => {
    const id = { ccTool: "Bash", value: "timeout 10 rm -rf /tmp" };
    expect(evaluate({ allow: [], ask: [], deny: ["Bash(rm:*)"] }, id)).toBe("deny");
  });
  it("deny 规则穿透 nohup 包装器", () => {
    const id = { ccTool: "Bash", value: "nohup rm -rf /tmp" };
    expect(evaluate({ allow: [], ask: [], deny: ["Bash(rm:*)"] }, id)).toBe("deny");
  });
  it("deny 规则穿透 nice 包装器", () => {
    const id = { ccTool: "Bash", value: "nice -n 5 rm -rf /tmp" };
    expect(evaluate({ allow: [], ask: [], deny: ["Bash(rm:*)"] }, id)).toBe("deny");
  });
  it("deny 规则穿透 time 包装器", () => {
    const id = { ccTool: "Bash", value: "time rm -rf /tmp" };
    expect(evaluate({ allow: [], ask: [], deny: ["Bash(rm:*)"] }, id)).toBe("deny");
  });
  it("allow 规则穿透 stdbuf 包装器", () => {
    const id = { ccTool: "Bash", value: "stdbuf -o0 npm test" };
    expect(evaluate({ allow: ["Bash(npm:*)"], ask: [], deny: [] }, id)).toBe("allow");
  });
  it("交替包装器:nohup + timeout 都剥离", () => {
    const id = { ccTool: "Bash", value: "nohup timeout 10 npm test" };
    expect(evaluate({ allow: ["Bash(npm:*)"], ask: [], deny: [] }, id)).toBe("allow");
  });
});

describe("evaluate — 环境变量非对称剥离(对标 CC)", () => {
  it("deny 规则剥离所有环境变量(防绕过)", () => {
    const id = { ccTool: "Bash", value: "FOO=bar rm -rf /tmp" };
    expect(evaluate({ allow: [], ask: [], deny: ["Bash(rm:*)"] }, id)).toBe("deny");
  });
  it("deny 规则剥离 DOCKER_HOST 等不安全变量", () => {
    const id = { ccTool: "Bash", value: "DOCKER_HOST=tcp://evil docker ps" };
    expect(evaluate({ allow: [], ask: [], deny: ["Bash(docker:*)"] }, id)).toBe("deny");
  });
  it("ask 规则也剥离所有环境变量", () => {
    const id = { ccTool: "Bash", value: "FOO=bar deploy prod" };
    expect(evaluate({ allow: [], ask: ["Bash(deploy:*)"], deny: [] }, id)).toBe("ask");
  });
  it("allow 规则只剥离安全环境变量(NODE_ENV)", () => {
    const id = { ccTool: "Bash", value: "NODE_ENV=prod npm test" };
    expect(evaluate({ allow: ["Bash(npm:*)"], ask: [], deny: [] }, id)).toBe("allow");
  });
  it("allow 规则不剥离不安全环境变量(防 DOCKER_HOST 绕过)", () => {
    // DOCKER_HOST 不是安全变量——allow 规则不应匹配,因为这可能改变 docker 通信目标
    const id = { ccTool: "Bash", value: "DOCKER_HOST=tcp://evil docker ps" };
    expect(evaluate({ allow: ["Bash(docker:*)"], ask: [], deny: [] }, id)).toBeNull();
  });
  it("交替剥离:env + wrapper 迭代到不动点", () => {
    const id = { ccTool: "Bash", value: "FOO=bar nohup timeout 5 rm -rf /tmp" };
    expect(evaluate({ allow: [], ask: [], deny: ["Bash(rm:*)"] }, id)).toBe("deny");
  });
});

describe("evaluate — 复合命令前缀免疫(对标 CC)", () => {
  it("前缀规则不匹配复合命令(防 cd /x && rm -rf / 整串匹配 Bash(cd:*))", () => {
    // 注意:splitBashCommands 会先拆分,每段单独检查——这里测试的是"如果某段没被拆开"的场景
    // 实际上 evaluate 先 split 再逐段查,所以复合命令的每段都是单命令,前缀规则可以匹配
    // 这里的测试验证 splitBashCommands 正常工作 + 每段前缀匹配
    const id = { ccTool: "Bash", value: "cd /tmp && rm -rf x" };
    // cd 段被 allow,rm 段无规则 → null(不自动放行)
    expect(evaluate({ allow: ["Bash(cd:*)"], ask: [], deny: [] }, id)).toBeNull();
  });
  it("复合命令中 rm 段命中 deny", () => {
    const id = { ccTool: "Bash", value: "echo hello && rm -rf /" };
    expect(evaluate({ allow: ["Bash(echo:*)"], ask: [], deny: ["Bash(rm:*)"] }, id)).toBe("deny");
  });
});

describe("evaluate — 输出重定向剥离(对标 CC)", () => {
  it("allow 规则匹配带重定向的命令", () => {
    const id = { ccTool: "Bash", value: "python script.py > /tmp/out" };
    expect(evaluate({ allow: ["Bash(python:*)"], ask: [], deny: [] }, id)).toBe("allow");
  });
  it("deny 规则穿透重定向匹配实际命令", () => {
    const id = { ccTool: "Bash", value: "rm -rf /tmp > /dev/null" };
    expect(evaluate({ allow: [], ask: [], deny: ["Bash(rm:*)"] }, id)).toBe("deny");
  });
  it("2>&1 重定向也剥离", () => {
    const id = { ccTool: "Bash", value: "npm test 2>&1" };
    expect(evaluate({ allow: ["Bash(npm:*)"], ask: [], deny: [] }, id)).toBe("allow");
  });
});
