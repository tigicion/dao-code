import React from "react";
import { Box, Text, useStdout } from "ink";
import type { Capabilities } from "./capabilities.js";
import type { Background } from "./background.js";
import type { WelcomeInfo } from "./banner.js";
import type { Maxim } from "./maxim.js";
import { WORDMARK } from "./banner.js";
import { renderTaiji } from "./taiji.js";
import { gradientBlock, semHex } from "./theme.js";

// 长路径缩短:超过 3 段时取末 3 段并加 …/ 前缀。
function shortenPath(p: string): string {
  const segs = p.split("/").filter(Boolean);
  return segs.length <= 3 ? p : "…/" + segs.slice(-3).join("/");
}

// 响应式欢迎屏(Ink):整宽圆角边框 + 居中 logo + 两栏页脚,随终端 resize 重排。
export function Welcome({
  info,
  caps,
  bg,
  maxim,
}: {
  info: WelcomeInfo;
  caps: Capabilities;
  bg: Background;
  maxim: Maxim;
}) {
  // useStdout 的 columns 在 resize 时更新,触发重渲染。
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? caps.columns;
  const narrow = columns < 72;

  const taiji = renderTaiji(caps, bg);
  const wm = gradientBlock(WORDMARK, "jade", "ink", caps, bg);
  const c = (sem: Parameters<typeof semHex>[0]) => semHex(sem, bg);

  return (
    <Box
      borderStyle="round"
      borderColor={c("jade")}
      width="100%"
      flexDirection="column"
      paddingX={2}
      paddingY={1}
    >
      {/* logo:太极 + 词标,整体居中 */}
      <Box flexDirection="column" alignItems="center">
        {taiji.map((line, i) => (
          <Text key={`t${i}`}>{line}</Text>
        ))}
        {wm.map((line, i) => (
          <Text key={`w${i}`}>{line}</Text>
        ))}
      </Box>

      {/* 落款 + 名句,居中 */}
      <Box flexDirection="column" alignItems="center" marginTop={1}>
        <Text>
          <Text color={c("vermilion")}>【道】</Text>
          {"  "}
          <Text color={c("jade")}>DAO CODE</Text>
          <Text color={c("dim")}>
            {"  ·  "}DeepSeek V4 编码之道{"  ·  "}v{info.version}
          </Text>
        </Text>
        <Text color={c("jade")}>「{maxim.text}」</Text>
      </Box>

      {/* 页脚两栏:左信息 / 右快速开始(窄屏堆叠) */}
      <Box marginTop={1} flexDirection={narrow ? "column" : "row"}>
        <Box flexDirection="column" flexGrow={1}>
          <Text>
            <Text color={c("dim")}>模型 </Text>
            <Text color={c("ink")}>
              {info.model} · {info.thinking} · 1M 上下文
            </Text>
          </Text>
          <Text>
            <Text color={c("dim")}>目录 </Text>
            <Text color={c("ink")}>{shortenPath(info.cwd)}</Text>
            {info.branch ? <Text color={c("jade")}>{"  ⎇ "}{info.branch}</Text> : null}
          </Text>
        </Box>

        {!narrow && (
          <Box
            borderStyle="single"
            borderColor={c("dim")}
            borderTop={false}
            borderBottom={false}
            borderRight={false}
            marginX={2}
          />
        )}

        <Box flexDirection="column" flexGrow={1} marginTop={narrow ? 1 : 0}>
          <Text color={c("dim")}>快速开始</Text>
          <Text color={c("dim")}>输入消息开始 · /help 命令 · @ 引用文件 · Esc 打断</Text>
        </Box>
      </Box>
    </Box>
  );
}
