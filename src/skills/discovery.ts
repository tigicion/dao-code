import type { Skill } from "./skills.js";
import { shingles, shingleOverlap } from "../text/similarity.js";

// 召回阈值:共享 ≥1 个字符二元组即算相关。二元组是相邻两字,本身已是有意义的双字单位
// (一个二字词/词缀),而非单字噪声;短输入常只靠一个关键词命中(如"测试"撞 debugging),
// 故阈值取 1 以保召回——discovery 只是每轮的软提示(top-N),召回优先于精度。
const MIN_OVERLAP = 1;

// 轻量技能发现(无向量):按用户输入与"技能名+描述+触发条件"的【字符二元组重叠】排序,选最相关的若干个。
// 用字符二元组而非空白分词——中文无词边界,分词会把整句中文塌缩成匹配不上的大块(见 ../text/similarity)。
// 每轮把相关技能高亮给模型(在静态全表之外),技能多时显著提升命中,中英一视同仁。
// weight:可选的使用频率加权(见 usage.ts),只用于【相关者之间】并列打破,不会让无关技能进榜。
export function relevantSkills(input: string, skills: Skill[], max = 5, weight?: (name: string) => number): Skill[] {
  return relevantSkillsScored(input, skills, max, weight).map((x) => x.sk);
}

// 同 relevantSkills,但保留每条的【相关度分数】——供技能触发审计记录"为什么(没)被提示"。
export function relevantSkillsScored(
  input: string, skills: Skill[], max = 5, weight?: (name: string) => number,
): { sk: Skill; score: number }[] {
  const inShingles = shingles(input);
  if (inShingles.size === 0) return [];
  return skills
    .map((sk) => {
      // when_to_use(触发条件)纳入语料——它常含"调试/新功能/之前"等触发词,比 description 更能命中任务。
      const skShingles = shingles(`${sk.name.replace(/-/g, " ")} ${sk.description} ${sk.whenToUse ?? ""}`);
      return { sk, score: shingleOverlap(inShingles, skShingles) };
    })
    .filter((x) => x.score >= MIN_OVERLAP)
    // 主序:二元组重叠(相关度);次序:使用频率加权(常用且最近用过的优先)。
    .sort((a, b) => b.score - a.score || (weight ? weight(b.sk.name) - weight(a.sk.name) : 0))
    .slice(0, max);
}

// 渲染为"相关技能"提示(每轮注入,非持久)。无匹配返回空串。
export function formatDiscovery(matches: Skill[]): string {
  if (matches.length === 0) return "";
  return (
    `[与本任务可能相关的 skill —— 相关就先用 skill 工具加载它再动手]\n` +
    matches.map((s) => `- ${s.name}:${`${s.description}${s.whenToUse ? ` 何时用:${s.whenToUse}` : ""}`.slice(0, 120)}`).join("\n")
  );
}
