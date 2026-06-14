import { describe, it, expect } from "vitest";
import { decide } from "./engine.js";
import { emptyPermissions } from "./settings.js";

const base = { rules: emptyPermissions() };
const rm = '{"command":"rm -rf /"}';

describe("decide — CC 优先级:deny > bypass > ask > allow > 模式/能力默认", () => {
  it("deny 规则永远拦截(即使 bypassPermissions)", () => {
    const rules = { ...emptyPermissions(), deny: ["Bash(rm:*)"] };
    expect(decide({ toolName: "exec_shell", argsJson: rm, capability: "exec", mode: "bypassPermissions", rules })).toBe("deny");
  });
  it("bypassPermissions:放行普通 exec;但危险命令仍 ask(S3.1 bypass-immune)", () => {
    expect(decide({ toolName: "exec_shell", argsJson: '{"command":"npm run test"}', capability: "exec", mode: "bypassPermissions", ...base })).toBe("allow");
    expect(decide({ toolName: "exec_shell", argsJson: rm, capability: "exec", mode: "bypassPermissions", ...base })).toBe("ask"); // rm -rf / 危险 → 即便 yolo 也要确认
  });
  it("ask 规则强制询问(优先于 allow)", () => {
    const rules = { ...emptyPermissions(), allow: ["Bash"], ask: ["Bash(rm:*)"] };
    expect(decide({ toolName: "exec_shell", argsJson: rm, capability: "exec", mode: "default", rules })).toBe("ask");
  });
  it("allow 规则命中放行", () => {
    const rules = { ...emptyPermissions(), allow: ["Bash(npm run test:*)"] };
    expect(decide({ toolName: "exec_shell", argsJson: '{"command":"npm run test"}', capability: "exec", mode: "default", rules })).toBe("allow");
  });
});

describe("decide — CC 1g:安全敏感目标", () => {
  it("bypass(yolo)下写/执行敏感目标 → 仍 ask(S3.1 bypass-immune,对标 CC)", () => {
    expect(decide({ toolName: "write_file", argsJson: '{"path":"../.ssh/authorized_keys"}', capability: "write", mode: "bypassPermissions", ...base })).toBe("ask");
    expect(decide({ toolName: "exec_shell", argsJson: '{"command":"cat ~/.bashrc"}', capability: "exec", mode: "bypassPermissions", ...base })).toBe("ask");
    expect(decide({ toolName: "edit_file", argsJson: '{"path":".git/config"}', capability: "write", mode: "bypassPermissions", ...base })).toBe("ask");
  });
  it("acceptEdits / auto 下编辑敏感路径仍 ask(不自动放行)", () => {
    expect(decide({ toolName: "edit_file", argsJson: '{"path":"a/.ssh/id_rsa"}', capability: "write", mode: "acceptEdits", ...base })).toBe("ask");
    expect(decide({ toolName: "edit_file", argsJson: '{"path":"a/.ssh/id_rsa"}', capability: "write", mode: "auto", ...base })).toBe("ask");
  });
  it("显式 allow 规则可 opt-in 放行敏感目标", () => {
    const rules = { ...emptyPermissions(), allow: ["Write(//.ssh/config)"] };
    // 普通敏感路径 + 显式 allow 该路径 → 放行(用户主动授权)
    expect(decide({ toolName: "write_file", argsJson: '{"path":".ssh/config"}', capability: "write", mode: "bypassPermissions", rules: { ...emptyPermissions(), allow: ["Write"] } })).toBe("allow");
  });
  it("普通路径不受影响", () => {
    expect(decide({ toolName: "write_file", argsJson: '{"path":"src/app.ts"}', capability: "write", mode: "bypassPermissions", ...base })).toBe("allow");
  });
});

describe("decide — auto 模式快速路径(分类器之前)", () => {
  it("② 工作区内文件编辑(acceptEdits 会放行)→ 直接 allow,不走分类器", () => {
    expect(decide({ toolName: "edit_file", argsJson: '{"path":"src/app.ts"}', capability: "write", mode: "auto", ...base })).toBe("allow");
    expect(decide({ toolName: "write_file", argsJson: '{"path":"src/new.ts"}', capability: "write", mode: "auto", ...base })).toBe("allow");
  });
  it("③ 安全白名单工具 → 直接 allow", () => {
    expect(decide({ toolName: "todo_write", argsJson: "{}", capability: "write", mode: "auto", ...base })).toBe("allow");
  });
  it("exec_shell / 网络 / 敏感编辑 → 仍 ask(交分类器)", () => {
    expect(decide({ toolName: "exec_shell", argsJson: rm, capability: "exec", mode: "auto", ...base })).toBe("ask");
    expect(decide({ toolName: "fetch_url", argsJson: '{"url":"http://x"}', capability: "network", mode: "auto", ...base })).toBe("ask");
    expect(decide({ toolName: "edit_file", argsJson: '{"path":"a/.ssh/id_rsa"}', capability: "write", mode: "auto", ...base })).toBe("ask");
  });
  it("③' 只读 shell 命令(ls/cat/git status/管道)→ 直接 allow,不走分类器", () => {
    const ro = (cmd: string) => decide({ toolName: "exec_shell", argsJson: JSON.stringify({ command: cmd }), capability: "exec", mode: "auto", ...base });
    expect(ro("ls /Users/x/proj/sub/")).toBe("allow");
    expect(ro("cat package.json")).toBe("allow");
    expect(ro("git status")).toBe("allow");
    expect(ro("git log --oneline -20")).toBe("allow");
    expect(ro("ls -la | grep foo")).toBe("allow"); // 管道:两段都只读
    expect(ro("pwd")).toBe("allow");
  });
  it("只读快速路径的安全边界:写/链式/重定向/危险/敏感 → 仍 ask", () => {
    const sh = (cmd: string) => decide({ toolName: "exec_shell", argsJson: JSON.stringify({ command: cmd }), capability: "exec", mode: "auto", ...base });
    expect(sh("rm -f a")).toBe("ask"); // 非只读
    expect(sh("git push")).toBe("ask"); // git 非只读子命令
    expect(sh("ls > out.txt")).toBe("ask"); // 重定向(会写文件)
    expect(sh("ls && rm -rf x")).toBe("ask"); // 链式
    expect(sh("cat $(whoami)")).toBe("ask"); // 命令替换
    expect(sh("find . -delete")).toBe("ask"); // find 带破坏动作
    expect(sh("cat ~/.ssh/id_rsa")).toBe("ask"); // cat 虽只读,但敏感目标 → mustConfirm 拦
    expect(sh("npm test")).toBe("ask"); // 非白名单程序 → 交分类器
  });
  it("只读快速路径只在 auto 生效:default 下 ls 仍 ask", () => {
    expect(decide({ toolName: "exec_shell", argsJson: '{"command":"ls /tmp"}', capability: "exec", mode: "default", ...base })).toBe("ask");
  });
});

describe("decide — 模式默认(无规则命中)", () => {
  it("default:read 自动放行,write/exec 询问", () => {
    expect(decide({ toolName: "read_file", argsJson: '{"path":"a"}', capability: "read", mode: "default", ...base })).toBe("allow");
    expect(decide({ toolName: "exec_shell", argsJson: rm, capability: "exec", mode: "default", ...base })).toBe("ask");
    expect(decide({ toolName: "write_file", argsJson: '{"path":"a"}', capability: "write", mode: "default", ...base })).toBe("ask");
  });
  it("acceptEdits:文件编辑自动放行,exec 仍询问", () => {
    expect(decide({ toolName: "edit_file", argsJson: '{"path":"a"}', capability: "write", mode: "acceptEdits", ...base })).toBe("allow");
    expect(decide({ toolName: "write_file", argsJson: '{"path":"a"}', capability: "write", mode: "acceptEdits", ...base })).toBe("allow");
    expect(decide({ toolName: "exec_shell", argsJson: rm, capability: "exec", mode: "acceptEdits", ...base })).toBe("ask");
  });
  it("plan:有副作用的(write/exec/network)拦截,read 放行", () => {
    expect(decide({ toolName: "exec_shell", argsJson: rm, capability: "exec", mode: "plan", ...base })).toBe("deny");
    expect(decide({ toolName: "write_file", argsJson: '{"path":"a"}', capability: "write", mode: "plan", ...base })).toBe("deny");
    expect(decide({ toolName: "read_file", argsJson: '{"path":"a"}', capability: "read", mode: "plan", ...base })).toBe("allow");
  });
  it("无 CC 对应的工具(plan 能力,如 memory/todo)默认放行", () => {
    expect(decide({ toolName: "memory_write", argsJson: "{}", capability: "plan", mode: "default", ...base })).toBe("allow");
  });
});

import { isSensitiveCall } from "./engine.js";
describe("isSensitiveCall", () => {
  it("写 .ssh / 命令含凭据路径 → 敏感;普通 → 否", () => {
    expect(isSensitiveCall("write_file", '{"path":"a/.ssh/config"}')).toBe(true);
    expect(isSensitiveCall("exec_shell", '{"command":"cat ~/.aws/credentials"}')).toBe(true);
    expect(isSensitiveCall("write_file", '{"path":"src/app.ts"}')).toBe(false);
  });
  it("仅 .dao/config.json 敏感;编辑 ~/.dao/skills 下的技能文件不算敏感", () => {
    expect(isSensitiveCall("write_file", '{"path":"/Users/x/.dao/config.json"}')).toBe(true);
    expect(isSensitiveCall("write_file", '{"path":"/Users/x/.dao/skills/foo/SKILL.md"}')).toBe(false);
  });
});
