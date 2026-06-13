import type { Skill } from "./skills.js";

// 把文本切成可比较词块:按空白 + 常见中英标点切,保留长度≥2 的块,小写。
function chunks(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[\s,.;:!?、，。；:!?——\-_/()\[\]{}"'`]+/)
    .filter((t) => t.length >= 2);
}

// 轻量技能发现(无向量):按"技能名+描述"与用户输入的词块双向重叠度,选最相关的若干个。
// 用于每轮把相关技能高亮给模型(在静态全表之外),技能多时显著提升匹配。
export function relevantSkills(input: string, skills: Skill[], max = 5): Skill[] {
  const inText = input.toLowerCase();
  const inChunks = chunks(input);
  if (inChunks.length === 0) return [];
  return skills
    .map((sk) => {
      const skText = `${sk.name} ${sk.description}`.toLowerCase();
      const skChunks = chunks(`${sk.name.replace(/-/g, " ")} ${sk.description}`);
      let score = 0;
      for (const c of skChunks) if (inText.includes(c)) score += 1; // 技能词出现在输入
      for (const c of inChunks) if (skText.includes(c)) score += 1; // 输入词出现在技能
      return { sk, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.sk);
}

// 渲染为"相关技能"提示(每轮注入,非持久)。无匹配返回空串。
export function formatDiscovery(matches: Skill[]): string {
  if (matches.length === 0) return "";
  return (
    `[与本任务可能相关的 skill —— 相关就先用 skill 工具加载它再动手]\n` +
    matches.map((s) => `- ${s.name}:${s.description.slice(0, 80)}`).join("\n")
  );
}
