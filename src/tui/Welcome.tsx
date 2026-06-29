import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useStdout } from "ink";
import type { Capabilities } from "./capabilities.js";
import type { Background } from "./background.js";
import type { WelcomeInfo } from "./banner.js";
import type { Maxim } from "./maxim.js";
import { WORDMARK } from "./banner.js";
import { renderTaiji } from "./taiji.js";
import { gradientBlock, semHex } from "./theme.js";
import { randomTip } from "./tips.js";
import { t } from "../i18n/i18n.js";

// 长路径缩短:超过 3 段时取末 3 段并加 …/ 前缀。
function shortenPath(p: string): string {
  const segs = p.split("/").filter(Boolean);
  return segs.length <= 3 ? p : "…/" + segs.slice(-3).join("/");
}

// 订阅终端列宽:resize 时触发重渲染。会话开始前欢迎屏在动态区,跟随窗口重排;
// 固化进 <Static> 后(首条消息起)Ink 不再重绘它,订阅自然失效。
function useTermWidth(fallback: number): number {
  const { stdout } = useStdout();
  const [cols, setCols] = useState(stdout?.columns || fallback);
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setCols(stdout.columns || fallback);
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout, fallback]);
  return cols || fallback; // 0/undefined 回退(终端偶尔报 0)
}

// 响应式欢迎屏(Ink):整宽圆角边框 + 居中 logo + 两栏页脚,随终端 resize 重排。
export function Welcome({
  info,
  caps,
  bg,
  maxim,
  skipFooter,
}: {
  info: WelcomeInfo;
  caps: Capabilities;
  bg: Background;
  maxim: Maxim;
  skipFooter?: boolean;
}) {
  // 订阅 resize:列宽变化触发重渲染,使整宽边框与两栏随终端重排。
  const columns = useTermWidth(caps.columns);
  const narrow = columns < 72;
  // 太极(16)+ 间距(5)+ 词标(60)+ 边框与 padding(6)≈ 87,留点余量。
  const sideBySide = columns >= 92;

  const taiji = renderTaiji(caps, bg);
  const wm = gradientBlock(WORDMARK, "jade", "ink", caps, bg);
  const c = (sem: Parameters<typeof semHex>[0]) => semHex(sem, bg);
  const tip = useRef(randomTip()).current; // 随机一条引导,本次挂载固定(固化进 Static 后冻结)

  // 落款 + 名句合一行(紧凑;「道」已由朱印承担,不再重复)。
  const sealLine = (
    <Text>
      <Text color={c("jade")}>DAO CODE</Text>
      <Text color={c("dim")}>{"  ·  "}v{info.version}{"  ·  "}</Text>
      <Text color={c("jade")}>「{maxim.text}」</Text>
    </Text>
  );

  return (
    <Box
      borderStyle="round"
      borderColor={c("jade")}
      width={columns}
      flexDirection="column"
      paddingX={2}
      paddingY={1}
    >
      {/* logo:宽屏太极居左、词标+落款居右(垂直居中);窄屏退化为上下堆叠 */}
      {sideBySide ? (
        <Box justifyContent="center" alignItems="center">
          <Box flexDirection="column" marginRight={5}>
            {taiji.map((line, i) => (
              <Text key={`t${i}`}>{line}</Text>
            ))}
          </Box>
          <Box flexDirection="column" alignItems="center">
            {wm.map((line, i) => (
              <Text key={`w${i}`}>{line}</Text>
            ))}
            <Box marginTop={1}>{sealLine}</Box>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" alignItems="center">
          {taiji.map((line, i) => (
            <Text key={`t${i}`}>{line}</Text>
          ))}
          {wm.map((line, i) => (
            <Text key={`w${i}`}>{line}</Text>
          ))}
          <Box marginTop={1}>{sealLine}</Box>
        </Box>
      )}

      {/* 页脚两栏:左信息 / 右快速开始(窄屏堆叠) */}
      {!skipFooter && (
      <Box marginTop={1} flexDirection={narrow ? "column" : "row"}>
        <Box flexDirection="column" flexGrow={1}>
          <Text>
            <Text color={c("dim")}>{t("welcome.model")}</Text>
            <Text color={c("ink")}>
              {info.model} · {info.thinking} · {t("welcome.ctx")}
            </Text>
          </Text>
          <Text>
            <Text color={c("dim")}>{t("welcome.dir")}</Text>
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
          <Text color={c("dim")}>{t("welcome.quickstart")}</Text>
          <Text color={c("dim")}>{t("welcome.hint")}</Text>
          <Text color={c("jade")}>{t("welcome.try")}{tip}</Text>
        </Box>
      </Box>
      )}
    </Box>
  );
}
