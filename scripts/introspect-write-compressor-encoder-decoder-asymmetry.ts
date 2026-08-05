// debug-evolve 第二步:内省诊断——write-compressor 新暴露的"手写encoder与给定decoder不
// 严格对称导致decomp段错误"卡点(独立于本session已经修好的缺库硬拦截/TodoWrite enforcement/
// 重写拦截三条线,那三条都没在这次真实复测里触发)。
//
// 真实卡点(retest-missingdep-write-compressor-0728,write-compressor__jmZnjdr):
// - S(msg0-14,已有信息):读过decomp.c(get_bit的renorm+split逻辑,fraction/range都是
//   定长int/long,不需要大数);读过data.txt;确认gcc/perl都在,选C;编译decomp成功。
// - B(msg15,实际做的事):写comp.c的encode_bit——renorm分支里用一个单点"low"变量+
//   手工case逻辑(bit=0时取min_new_low,bit=1时取max_new_low,越界就clamp到split
//   边界)贪心选一个字节就定下来,代码里大量"for now,让我们..." "actually,让我们用..."
//   这类边写边改主意的注释,没有carry传播/回溯机制。
// - A(参照真实solutions-reference.md的Rust solve.sh):真正的RangeEncoder不是手动
//   推导encode_bit的代数逆运算,而是把decomp本身(或其忠实重实现)当作黑盒oracle——
//   维护(low,high)两个端点(u64,不是单点int),对每个待编码bit,用二分查找
//   (find_first/find_last)在[low,high]区间里搜索"重新跑一遍decoder,喂这个候选字节
//   序列进去,解出来的bit是否等于我想要的bit"这个谓词的边界,而不是手工推导renorm公式。
// - 结果:comp.c编译通过、compressed size 2382字节达标,但comp|decomp管道段错误——
//   encoder的贪心/单点low实现在多步renorm后与decoder的真实状态发生偏移,decomp读到
//   垃圾bit序列,get_integer解出的offset/length是垃圾值,`z = Q - garbage_offset - 1`
//   导致越界指针,拷贝时段错误。会话在调试这个segfault时耗尽预算(3301行dao_stdout只
//   落了24条消息,末尾停在检查comp.log/decomp.log)。
//
// 三层递进,后一层才揭示参考答案A(oracle-guided binary search),不让模型在第0层就看到。
//
// 跑法: VOLCENGINE_API_KEY=... npx tsx scripts/introspect-write-compressor-encoder-decoder-asymmetry.ts
import { promises as fs } from "node:fs";
import { streamChat } from "../src/client/client.js";
import type { ChatMessage } from "../src/client/types.js";

const apiKey = process.env.VOLCENGINE_API_KEY ?? "";
const baseUrl = "https://ark.cn-beijing.volces.com/api/coding/v3";
const model = "deepseek-v4-pro";
if (!apiKey) { console.error("需要 VOLCENGINE_API_KEY。"); process.exit(1); }

const STATE_PATH =
  "/Users/huaruoxu/ClaudeProject/dao-code/evals/terminal-bench/jobs/retest-missingdep-write-compressor-0728/" +
  "write-compressor__jmZnjdr/agent/dao_snapshot/.dao/sessions/20260728-091510-zqbg/state.json";

const state = JSON.parse(await fs.readFile(STATE_PATH, "utf8")) as { messages: ChatMessage[] };
const systemPrompt = state.messages[0]!.content as string;
const userTask = state.messages[1]!.content as string;

async function ask(introspectionQuestion: string): Promise<string> {
  const msgs: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userTask },
    {
      role: "user",
      content:
        "以下不是继续这个任务,也不需要你调用任何工具(这里没有注册任何工具,不要输出" +
        "工具调用格式)——这是你自己在另一次独立运行里针对同一个任务真实产生的记录节选," +
        "现在请你以第三方复盘的角度,只用文字客观分析,不要尝试解题:\n\n" +
        introspectionQuestion,
    },
  ];
  const gen = streamChat({ baseUrl, apiKey, provider: "volcengine", model, messages: msgs, extra: { reasoning_effort: "medium" } });
  let result;
  while (true) { const { value, done } = await gen.next(); if (done) { result = value; break; } }
  return (result.reasoningContent ? `[推理]\n${result.reasoningContent}\n\n[正文]\n` : "") + (result.content ?? "");
}

const decompC = `int i;
int radix = 255;
int fraction;
long range = 1;
int gc() { unsigned char c = (unsigned char)getchar(); return (int)c; }
int get_bit(int ctx) {
  if ( range < radix ) {
    range *= radix;
    fraction *= radix;
    fraction += gc()-1;
  }
  int *counts = cc + ctx * 2;
  int split = range * -~*counts / (*counts + counts[1] + 2);
  int the_bit = fraction >= split;
  fraction -= split*the_bit;
  range = the_bit ? range-split : split;
  counts[the_bit]++;
  return the_bit;
}`;

const compCEncodeBitExcerpt = `void encode_bit(int bit, int ctx) {
    if (range_val < RADIX) {
        int new_range = range_val * RADIX;
        int *counts = cc + ctx * 2;
        int split = (long long)new_range * (counts[0] + 1) / (counts[0] + counts[1] + 2);
        int min_new_low = low * RADIX - 1;
        int max_new_low = low * RADIX + 254;
        if (bit == 0) {
            int target = min_new_low;
            if (target >= split) { target = split - 1; if (target < min_new_low) target = min_new_low; if (target > max_new_low) target = max_new_low; }
            int b = target - low * RADIX + 1;
            if (b < 0) b = 0; if (b > 255) b = 255;
            put_byte(b);
            low = low * RADIX + (b - 1);
        } else {
            int target = max_new_low;
            if (target < split) { target = split; if (target > max_new_low) target = max_new_low; if (target < min_new_low) target = min_new_low; }
            int b = target - low * RADIX + 1;
            if (b < 0) b = 0; if (b > 255) b = 255;
            put_byte(b);
            low = low * RADIX + (b - 1);
        }
        range_val = new_range;
    }
    int *counts = cc + ctx * 2;
    int split = (long long)range_val * (counts[0] + 1) / (counts[0] + counts[1] + 2);
    if (bit == 0) { range_val = split; } else { low += split; range_val = range_val - split; }
    counts[bit]++;
}`;

console.error("\n=== 第0层:不给标准答案,只给S和B(任务失败的事实),让模型自己诊断 ===\n");
const layer0 = await ask(
  `你当时(在那次独立运行里)读过/app/decomp.c,里面有这样一个解码函数:\n\`\`\`c\n${decompC}\n\`\`\`\n` +
  `你确认过fraction/range都是普通int/long,不需要高精度数值库。然后你写了一个compressor(comp.c),` +
  `其中encode_bit的渲染归一化(renormalization)部分是这样写的:\n\`\`\`c\n${compCEncodeBitExcerpt}\n\`\`\`\n` +
  `编译通过,压缩后的文件2382字节(在2500字节限制内)。但把它的输出喂给 ./comp | ./decomp 时,` +
  `decomp直接段错误(Segmentation fault)。\n\n请客观分析:你觉得这段encode_bit的renormalization` +
  `逻辑,从算法设计角度看,可能有什么问题导致它和decoder不同步?`,
);
console.log(layer0);

console.error("\n\n=== 第1层:揭示标准答案A(oracle-guided binary search),问是思路问题还是别的 ===\n");
const layer1 = await ask(
  `还是同一次运行里,你写的encode_bit(上面贴过的那段)最终导致comp|decomp段错误。` +
  `这道题的官方参考解法(Rust实现)采用的encoder设计是这样的:` +
  `不手工推导encode_bit渲染归一化时该输出哪个字节的代数逆运算,而是把decoder本身当作` +
  `黑盒oracle——维护(low, high)两个64位端点(不是单点的low),对每一个要编码的bit,` +
  `用二分查找在[low, high]区间里搜索:"如果把这个候选64位值转成radix-255的字节序列," +` +
  `"喂给一份decoder的忠实重实现(或者/app/decomp本身),解出来的下一个bit是不是我想要的" +` +
  `这个谓词的边界(find_first/find_last),而不是手工推导renorm该怎么算。你当时写的` +
  `encode_bit是手工case-by-case推导单点low该clamp成什么值,和这个"用decoder自己当oracle` +
  `做二分查找"的方法完全不同——你当时有没有意识到,decoder本身就是一个可以调用的确定性` +
  `函数、可以拿来当谓词做二分搜索,而不是必须手动代数求逆?如果没意识到,是因为没想到" +` +
  `可以这样用,还是想到过但选择了手推这条路?`,
);
console.log(layer1);

console.error("\n\n=== 第2层:问系统提示词有没有哪条措辞客观上鼓励或没能提示这个思路 ===\n");
const layer2 = await ask(
  `还是同一次运行。结合你现在能看到的完整系统提示词——里面有没有哪条具体措辞,客观上鼓励了` +
  `"手推数学逆运算"这条路,或者没能提示你"遇到一个已知的、可运行的正向函数(decoder)时,` +
  `可以把它当oracle用二分查找/搜索去构造满足条件的输入,而不是求它的解析逆"这个更通用的` +
  `策略?如果有,请引用原文。如果重新走一遍,系统提示词里需要补充哪一条具体指导,才会让` +
  `你在动手写encode_bit之前,先考虑"这个decoder能不能直接当oracle用"这个选项?这条指导` +
  `需要写得多具体(泛化到"任何需要构造让一个已知正向程序产生特定输出的输入"这类场景,` +
  `还是只能针对这道题这种format)?`,
);
console.log(layer2);
