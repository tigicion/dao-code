import { describe, it, expect } from "vitest";
import { decide, decideAsync } from "./engine.js";
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
  it("bypass(yolo)下 SECRET_TARGET(真实泄密风险)仍 ask,即便只是写也一样(S3.1 bypass-immune,对标 CC)", () => {
    expect(decide({ toolName: "write_file", argsJson: '{"path":"../.ssh/authorized_keys"}', capability: "write", mode: "bypassPermissions", ...base })).toBe("ask");
  });
  it("bypass(yolo)下 WRITE_ONLY_SENSITIVE_TARGET(/etc、.git、shell启动脚本)不再 bypass-immune——用户已经显式yolo,读写都放行", () => {
    // 真实撞见的案例:nginx-request-logging 这类 sysadmin 任务要写 /etc/nginx/nginx.conf,
    // headless+yolo 场景下没有人能应答确认,旧的 bypass-immune 设计让这整类任务结构性地做不完。
    // WRITE_ONLY_SENSITIVE_TARGET 本身不是秘密(不同于 SECRET_TARGET),yolo 语义就是
    // "已经决定不要为动作类风险弹确认",不该跟真实泄密风险用同一条免疫规则。
    expect(decide({ toolName: "edit_file", argsJson: '{"path":".git/config"}', capability: "write", mode: "bypassPermissions", ...base })).toBe("allow");
    expect(decide({ toolName: "exec_shell", argsJson: '{"command":"cat ~/.bashrc"}', capability: "exec", mode: "bypassPermissions", ...base })).toBe("allow");
    expect(decide({ toolName: "exec_shell", argsJson: '{"command":"cat /etc/postfix/main.cf"}', capability: "exec", mode: "bypassPermissions", ...base })).toBe("allow");
    expect(decide({ toolName: "exec_shell", argsJson: '{"command":"ls /etc/systemd/system/"}', capability: "exec", mode: "bypassPermissions", ...base })).toBe("allow");
    expect(decide({ toolName: "write_file", argsJson: '{"path":"/etc/hosts"}', capability: "write", mode: "bypassPermissions", ...base })).toBe("allow");
  });
  it("yolo 下 shell 重定向截断(echo x > /etc/foo)仍要确认——这是独立的 S2.1 危险命令检测,不是 WRITE_ONLY_SENSITIVE_TARGET,不受这次放宽影响", () => {
    // `>` 重定向本身风险更高(shell 元字符面更大),跟"用 write_file/edit_file 工具结构化地
    // 改 /etc/ 下的文件"是不同风险等级,这条保护没有被这次改动动到。
    expect(decide({ toolName: "exec_shell", argsJson: '{"command":"echo x > ~/.bashrc"}', capability: "exec", mode: "bypassPermissions", ...base })).toBe("ask");
    expect(decide({ toolName: "exec_shell", argsJson: '{"command":"echo x > /etc/postfix/main.cf"}', capability: "exec", mode: "bypassPermissions", ...base })).toBe("ask");
  });
  it("非 yolo 模式下 WRITE_ONLY_SENSITIVE_TARGET 依然要确认,行为不变——放宽只针对显式 --yolo", () => {
    expect(decide({ toolName: "write_file", argsJson: '{"path":"/etc/hosts"}', capability: "write", mode: "default", ...base })).toBe("ask");
    expect(decide({ toolName: "edit_file", argsJson: '{"path":".git/config"}', capability: "write", mode: "acceptEdits", ...base })).toBe("ask");
    expect(decide({ toolName: "exec_shell", argsJson: '{"command":"cat /etc/postfix/main.cf > /tmp/x"}', capability: "exec", mode: "auto", ...base })).toBe("ask");
  });
  it("凭据/密钥类(SECRET_TARGET)读也泄漏,不管读写、不管走哪个工具,一律确认", () => {
    expect(decide({ toolName: "exec_shell", argsJson: '{"command":"cat ~/.ssh/id_rsa"}', capability: "exec", mode: "bypassPermissions", ...base })).toBe("ask");
    expect(decide({ toolName: "exec_shell", argsJson: '{"command":"cat /etc/shadow"}', capability: "exec", mode: "bypassPermissions", ...base })).toBe("ask");
    // read_file 之前完全没被 mustConfirm 覆盖过(capability=read 从不满足旧条件)——这是新补的一致性:
    // 不管拿 read_file 还是 exec_shell 的 cat 读私钥,结果都是内容进模型上下文,不该只挡后者。
    expect(decide({ toolName: "read_file", argsJson: '{"path":"~/.ssh/id_rsa"}', capability: "read", mode: "bypassPermissions", ...base })).toBe("ask");
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
  it("exec_shell(危险)/ 敏感编辑 → 仍 ask(交分类器)", () => {
    expect(decide({ toolName: "exec_shell", argsJson: rm, capability: "exec", mode: "auto", ...base })).toBe("ask");
    expect(decide({ toolName: "edit_file", argsJson: '{"path":"a/.ssh/id_rsa"}', capability: "write", mode: "auto", ...base })).toBe("ask");
  });
  it("网络查询(web_search/fetch_url)auto 下直接 allow(不再弹审批)", () => {
    expect(decide({ toolName: "web_search", argsJson: '{"query":"x"}', capability: "network", mode: "auto", ...base })).toBe("allow");
    expect(decide({ toolName: "fetch_url", argsJson: '{"url":"http://x"}', capability: "network", mode: "auto", ...base })).toBe("allow");
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
  it("只读快速路径不再局限于 auto:default/acceptEdits 下纯只读命令也直接 allow,不用弹审批", () => {
    const ro = (mode: "default" | "acceptEdits") => decide({ toolName: "exec_shell", argsJson: '{"command":"ls /tmp"}', capability: "exec", mode, ...base });
    expect(ro("default")).toBe("allow");
    expect(ro("acceptEdits")).toBe("allow");
    const roPipe = (mode: "default" | "acceptEdits") => decide({ toolName: "exec_shell", argsJson: '{"command":"find src -name \'*.ts\' | wc -l"}', capability: "exec", mode, ...base });
    expect(roPipe("default")).toBe("allow");
    expect(roPipe("acceptEdits")).toBe("allow");
  });
  it("但 default/acceptEdits 下非只读命令仍要询问(没有全面放开 exec_shell)", () => {
    expect(decide({ toolName: "exec_shell", argsJson: '{"command":"npm install"}', capability: "exec", mode: "default", ...base })).toBe("ask");
    expect(decide({ toolName: "exec_shell", argsJson: rm, capability: "exec", mode: "acceptEdits", ...base })).toBe("ask");
  });
  it("default 下只读命令碰到敏感目标(SECRET_TARGET)依然要确认——快速放行不绕过凭据保护", () => {
    expect(decide({ toolName: "exec_shell", argsJson: '{"command":"cat ~/.ssh/id_rsa"}', capability: "exec", mode: "default", ...base })).toBe("ask");
  });
  it("plan 模式不享受这条快速路径:exec_shell 一律 deny,即便命令本身只读——plan 跳过了 mustConfirm," +
    "若在这里放行会让 cat ~/.ssh/id_rsa 绕过凭据检查,保持原有'exec 一律拦'更安全", () => {
    expect(decide({ toolName: "exec_shell", argsJson: '{"command":"ls /tmp"}', capability: "exec", mode: "plan", ...base })).toBe("deny");
    expect(decide({ toolName: "exec_shell", argsJson: '{"command":"cat ~/.ssh/id_rsa"}', capability: "exec", mode: "plan", ...base })).toBe("deny");
  });
  it("显式 ask 规则命中时,即便命令只读也要问——用户显式规则优先于自动只读快速路径", () => {
    const rules = { ...emptyPermissions(), ask: ["Bash(ls:*)"] };
    expect(decide({ toolName: "exec_shell", argsJson: '{"command":"ls /tmp"}', capability: "exec", mode: "default", rules })).toBe("ask");
    expect(decide({ toolName: "exec_shell", argsJson: '{"command":"ls /tmp"}', capability: "exec", mode: "auto", rules })).toBe("ask");
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

describe("decideAsync(AST 路径,exec_shell 真实运行时走这条)— 只读快速路径同样生效", () => {
  it("default/acceptEdits 下纯只读命令直接 allow", async () => {
    expect(await decideAsync({ toolName: "exec_shell", argsJson: '{"command":"find src -name \'*.ts\' | wc -l"}', capability: "exec", mode: "default", ...base })).toBe("allow");
    expect(await decideAsync({ toolName: "exec_shell", argsJson: '{"command":"git log --oneline -5"}', capability: "exec", mode: "acceptEdits", ...base })).toBe("allow");
  });
  it("非只读命令依然 ask", async () => {
    expect(await decideAsync({ toolName: "exec_shell", argsJson: '{"command":"npm install"}', capability: "exec", mode: "default", ...base })).toBe("ask");
  });
  it("plan 模式不享受快速路径,敏感目标不被绕过", async () => {
    expect(await decideAsync({ toolName: "exec_shell", argsJson: '{"command":"ls /tmp"}', capability: "exec", mode: "plan", ...base })).toBe("deny");
    expect(await decideAsync({ toolName: "exec_shell", argsJson: '{"command":"cat ~/.ssh/id_rsa"}', capability: "exec", mode: "plan", ...base })).toBe("deny");
  });
  it("default 下敏感目标(SECRET_TARGET)只读也要确认", async () => {
    expect(await decideAsync({ toolName: "exec_shell", argsJson: '{"command":"cat ~/.ssh/id_rsa"}', capability: "exec", mode: "default", ...base })).toBe("ask");
  });
  it("显式 ask 规则优先于只读快速路径", async () => {
    const rules = { ...emptyPermissions(), ask: ["Bash(ls:*)"] };
    expect(await decideAsync({ toolName: "exec_shell", argsJson: '{"command":"ls /tmp"}', capability: "exec", mode: "default", rules })).toBe("ask");
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
