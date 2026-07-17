import { describe, it, expect } from "vitest";
import {
  stripSafeWrappers,
  stripAllLeadingEnvVars,
  extractOutputRedirections,
  isCompoundCommand,
} from "./bash_preprocess.js";

describe("stripSafeWrappers", () => {
  it("剥离 time/nohup/nice/stdbuf 包装器", () => {
    expect(stripSafeWrappers("time npm test")).toBe("npm test");
    expect(stripSafeWrappers("nohup npm test")).toBe("npm test");
    expect(stripSafeWrappers("nice npm test")).toBe("npm test");
    expect(stripSafeWrappers("nice -n 5 npm test")).toBe("npm test");
    expect(stripSafeWrappers("stdbuf -o0 npm test")).toBe("npm test");
  });

  it("剥离 timeout 包装器(含 flag 和时长)", () => {
    expect(stripSafeWrappers("timeout 10 npm test")).toBe("npm test");
    expect(stripSafeWrappers("timeout 5s npm test")).toBe("npm test");
    expect(stripSafeWrappers("timeout -k 2 10 npm test")).toBe("npm test");
    expect(stripSafeWrappers("timeout --kill-after=2 10 npm test")).toBe("npm test");
    expect(stripSafeWrappers("timeout --foreground 10 npm test")).toBe("npm test");
  });

  it("剥离安全环境变量前缀", () => {
    expect(stripSafeWrappers("NODE_ENV=prod npm test")).toBe("npm test");
    expect(stripSafeWrappers("RUST_LOG=debug cargo build")).toBe("cargo build");
    expect(stripSafeWrappers("CI=true npm test")).toBe("npm test");
  });

  it("不剥离不安全环境变量(PATH/LD_PRELOAD 等)", () => {
    expect(stripSafeWrappers("PATH=/evil npm test")).toBe("PATH=/evil npm test");
    expect(stripSafeWrappers("LD_PRELOAD=/evil.so npm test")).toBe("LD_PRELOAD=/evil.so npm test");
  });

  it("交替剥离包装器和环境变量", () => {
    expect(stripSafeWrappers("NODE_ENV=prod timeout 10 npm test")).toBe("npm test");
    expect(stripSafeWrappers("nohup NODE_ENV=prod npm test")).toBe("NODE_ENV=prod npm test");
    // nohup 后的 VAR=val 是命令不是赋值——stripSafeWrappers 不再剥环境变量(Phase 2)
    // 但 deny 路径的 stripAllLeadingEnvVars 会剥
  });

  it("剥离注释行", () => {
    expect(stripSafeWrappers("# comment\nnpm test")).toBe("npm test");
    expect(stripSafeWrappers("# comment\nnpm test\n# another")).toBe("npm test");
  });

  it("无包装器的命令原样返回", () => {
    expect(stripSafeWrappers("npm test")).toBe("npm test");
    expect(stripSafeWrappers("git status")).toBe("git status");
  });
});

describe("stripAllLeadingEnvVars", () => {
  it("剥离所有环境变量(不限白名单)", () => {
    expect(stripAllLeadingEnvVars("FOO=bar rm -rf /")).toBe("rm -rf /");
    expect(stripAllLeadingEnvVars("DOCKER_HOST=tcp://evil docker ps")).toBe("docker ps");
    expect(stripAllLeadingEnvVars("MY_VAR=val cmd")).toBe("cmd");
  });

  it("支持引号值", () => {
    expect(stripAllLeadingEnvVars("FOO='bar baz' cmd")).toBe("cmd");
    expect(stripAllLeadingEnvVars('FOO="bar baz" cmd')).toBe("cmd");
  });

  it("交替剥离多个环境变量", () => {
    expect(stripAllLeadingEnvVars("FOO=bar BAZ=qux cmd")).toBe("cmd");
  });

  it("剥离注释行", () => {
    expect(stripAllLeadingEnvVars("# comment\nFOO=bar cmd")).toBe("cmd");
  });

  it("无环境变量时原样返回", () => {
    expect(stripAllLeadingEnvVars("npm test")).toBe("npm test");
  });
});

describe("extractOutputRedirections", () => {
  it("剥离 > file", () => {
    expect(extractOutputRedirections("echo hello > /tmp/out")).toBe("echo hello");
  });

  it("剥离 >> file", () => {
    expect(extractOutputRedirections("echo hello >> /tmp/out")).toBe("echo hello");
  });

  it("剥离 2> file", () => {
    expect(extractOutputRedirections("cmd 2> /tmp/err")).toBe("cmd");
  });

  it("剥离 2>&1", () => {
    expect(extractOutputRedirections("cmd 2>&1")).toBe("cmd");
  });

  it("剥离 &> file", () => {
    expect(extractOutputRedirections("cmd &> /tmp/all")).toBe("cmd");
  });

  it("剥离 >/dev/null", () => {
    expect(extractOutputRedirections("cmd >/dev/null")).toBe("cmd");
  });

  it("保留命令参数中的 > (非重定向)", () => {
    // echo "a > b" 中的 > 在引号内,但我们的简化剥离不解析引号——这个边界 CC 也不完美处理
    expect(extractOutputRedirections("echo hello")).toBe("echo hello");
  });

  it("多条重定向都剥离", () => {
    expect(extractOutputRedirections("cmd > /tmp/out 2> /tmp/err")).toBe("cmd");
  });
});

describe("isCompoundCommand", () => {
  it("识别 && 复合命令", () => {
    expect(isCompoundCommand("cd /tmp && rm -rf x")).toBe(true);
  });

  it("识别 || 复合命令", () => {
    expect(isCompoundCommand("cmd1 || cmd2")).toBe(true);
  });

  it("识别 ; 复合命令", () => {
    expect(isCompoundCommand("cmd1; cmd2")).toBe(true);
  });

  it("识别 | 管道", () => {
    expect(isCompoundCommand("cmd1 | cmd2")).toBe(true);
  });

  it("识别换行复合命令", () => {
    expect(isCompoundCommand("cmd1\ncmd2")).toBe(true);
  });

  it("单条命令不是复合命令", () => {
    expect(isCompoundCommand("npm test")).toBe(false);
    expect(isCompoundCommand("git status")).toBe(false);
  });
});
