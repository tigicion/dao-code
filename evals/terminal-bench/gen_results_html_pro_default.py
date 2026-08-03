#!/usr/bin/env python3
"""pro+default 独立赛道:从 results-pro-default.json + evolution-log-pro-default.md 生成 results-pro-default.html。

跟主赛道(gen_results_html.py -> results.json/results.html)、flash+default 赛道(gen_results_html_flash.py -> results-flash-default.json/html)完全隔离，不读不写 pro 赛道的任何文件
(task_overrides.json 除外——只读共享的题目诊断元信息，不影响其内容)。

用法: python3 gen_results_html_pro_default.py
输出: results-pro-default.html
"""
import json, os, html
from datetime import datetime

results = json.load(open("results-pro-default.json"))
log_path = "evolution-log-pro-default.md"
log_text = open(log_path).read() if os.path.exists(log_path) else ""

try:
    _overrides = json.load(open("task_overrides.json"))
except FileNotFoundError:
    _overrides = {}

def get_diagnosis(task, log):
    lines = log.split("\n")
    conclusions = []
    for i, line in enumerate(lines):
        if task in line:
            for j in range(max(0, i-2), min(len(lines), i+5)):
                l = lines[j].strip()
                if any(kw in l for kw in [
                    "确认真实难度", "反复推理反模式", "意图-行动脱节",
                    "真实精度", "模型判断失误", "框架bug", "已修复",
                    "自然超时", "非反模式", "混合型", "反模式变体",
                    "Weak Verification", "Premature Termination",
                    "Step Repetition", "reward=0", "reward=1",
                    "未确认为反模式", "真实任务难度", "非真实失败",
                ]):
                    conclusions.append(l[:200])
                    break
    seen = set()
    unique = []
    for c in conclusions:
        if c not in seen:
            seen.add(c)
            unique.append(c)
    return unique[-1] if unique else ""

passed = []
failed = []
no_result = []

for r in results:
    r["diagnosis"] = get_diagnosis(r["task"], log_text)
    caveat = _overrides.get(r["task"], {}).get("caveat")
    if caveat:
        r["diagnosis"] = f"⚠️ {caveat} | {r['diagnosis']}" if r["diagnosis"] else f"⚠️ {caveat}"
    if r["reward"] == 1:
        passed.append(r)
    elif r["reward"] == 0:
        failed.append(r)
    else:
        no_result.append(r)

passed.sort(key=lambda x: x["task"])
failed.sort(key=lambda x: x["task"])
no_result.sort(key=lambda x: x["task"])

total = len(passed) + len(failed)
pass_rate = len(passed) / total * 100 if total else 0

ever_passed_count = sum(1 for r in results if r.get("ever_passed"))
ever_pass_rate = ever_passed_count / total * 100 if total else 0

git_log = os.popen("git log --oneline -1").read().strip()
git_hash = os.popen("git rev-parse --short HEAD").read().strip()
now = datetime.now().strftime("%Y-%m-%d %H:%M")

def esc(s):
    return html.escape(str(s)) if s else ""

def fmt_tokens(n):
    if n is None: return "<span class='muted'>-</span>"
    if n >= 1_000_000: return f"{n/1_000_000:.1f}M"
    if n >= 1_000: return f"{n/1_000:.0f}K"
    return str(n)

def exc_badge(exc):
    if not exc: return "<span class='muted'>-</span>"
    cls = {"Timeout": "timeout", "Timeout(External)": "ext", "Cancelled": "cancel"}.get(exc, "other")
    return f"<span class='badge {cls}'>{exc}</span>"

parts = []
parts.append(f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Terminal-Bench 结果汇总(pro + default账号 独立赛道)</title>
<style>
  :root {{
    --bg: #0d1117; --fg: #c9d1d9; --border: #30363d; --header: #161b22;
    --pass: #3fb950; --fail: #f85149; --warn: #d29922; --muted: #6e7681;
    --link: #58a6ff; --row-hover: #1c2128;
  }}
  * {{ box-sizing: border-box; }}
  body {{
    background: var(--bg); color: var(--fg); font-family: -apple-system, "SF Mono", "Cascadia Code", monospace;
    margin: 0; padding: 20px; font-size: 13px; line-height: 1.5;
  }}
  h1 {{ font-size: 20px; margin: 0 0 4px; }}
  .meta {{ color: var(--muted); font-size: 12px; margin-bottom: 16px; }}
  .stats {{ display: flex; gap: 24px; margin-bottom: 20px; flex-wrap: wrap; }}
  .stat {{ background: var(--header); border: 1px solid var(--border); border-radius: 6px; padding: 12px 20px; }}
  .stat .num {{ font-size: 28px; font-weight: 700; }}
  .stat .label {{ font-size: 11px; color: var(--muted); text-transform: uppercase; }}
  .stat.pass .num {{ color: var(--pass); }}
  .stat.fail .num {{ color: var(--fail); }}
  .stat.rate .num {{ color: var(--warn); }}
  h2 {{ font-size: 16px; margin: 28px 0 10px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }}
  table {{ border-collapse: collapse; width: 100%; margin-bottom: 20px; }}
  th, td {{ text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }}
  th {{ background: var(--header); font-size: 11px; text-transform: uppercase; color: var(--muted); position: sticky; top: 0; }}
  td {{ overflow: hidden; text-overflow: ellipsis; max-width: 200px; }}
  tr:hover td {{ background: var(--row-hover); }}
  td.diag {{ max-width: 300px; white-space: normal; color: var(--muted); font-size: 12px; }}
  td.task {{ font-weight: 600; color: var(--link); }}
  td.trace {{ font-size: 11px; color: var(--muted); max-width: 250px; }}
  .badge {{ display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 600; }}
  .badge.pass {{ background: rgba(63,185,80,0.15); color: var(--pass); }}
  .badge.fail {{ background: rgba(248,81,73,0.15); color: var(--fail); }}
  .badge.none {{ background: rgba(110,118,129,0.15); color: var(--muted); }}
  .badge.timeout {{ background: rgba(210,153,34,0.15); color: var(--warn); }}
  .badge.ext {{ background: rgba(248,81,73,0.1); color: var(--fail); }}
  .badge.cancel {{ background: rgba(110,118,129,0.15); color: var(--muted); }}
  .badge.other {{ background: rgba(110,118,129,0.15); color: var(--muted); }}
  .muted {{ color: var(--muted); }}
  .diff-easy {{ color: var(--pass); }} .diff-medium {{ color: var(--warn); }} .diff-hard {{ color: var(--fail); }}
  a {{ color: var(--link); text-decoration: none; }}
  a:hover {{ text-decoration: underline; }}
  .toggle-passed {{ cursor: pointer; color: var(--muted); font-size: 12px; margin-bottom: 8px; }}
  .toggle-passed:hover {{ color: var(--fg); }}
  #passed-body {{ display: none; }}
</style>
</head>
<body>
<h1>Terminal-Bench 结果汇总 — pro + default账号 独立赛道</h1>
<div class="meta">
  最后更新: {now} |
  DAO版本: <code>{esc(git_log)}</code> |
  二进制commit: <code>{esc(git_hash)}</code> |
  与主赛道(results.json)、flash+default 赛道(results-flash-default.json)完全隔离，不共享 jobs/ 目录
</div>
<div class="stats">
  <div class="stat"><div class="label">总计</div><div class="num">{len(results)}</div></div>
  <div class="stat pass"><div class="label">按最新-通过</div><div class="num">{len(passed)}</div></div>
  <div class="stat fail"><div class="label">按最新-未通过</div><div class="num">{len(failed)}</div></div>
  <div class="stat rate"><div class="label">按最新-通过率</div><div class="num">{pass_rate:.1f}%</div></div>
  <div class="stat pass"><div class="label">按曾通过一次</div><div class="num">{ever_passed_count}</div></div>
  <div class="stat rate"><div class="label">曾通过-通过率</div><div class="num">{ever_pass_rate:.1f}%</div></div>
</div>
""")

parts.append('<h2>未通过题</h2>\n')
parts.append('<table>\n<thead><tr>')
parts.append('<th>#</th><th>题目</th><th>难度</th><th>类别</th><th>运行时间</th><th>provider</th><th>exc</th><th>曾通过</th><th>轮次</th><th>工具调用</th><th>token_in</th><th>token_out</th><th>trace 目录</th><th>排查结论</th>')
parts.append('</tr></thead>\n<tbody>\n')
for i, r in enumerate(failed, 1):
    diff_cls = {"easy": "diff-easy", "medium": "diff-medium", "hard": "diff-hard"}.get(r["difficulty"], "")
    ever_badge = (f"<span class='badge pass' title='{esc(r.get('first_pass_time'))} / {esc(r.get('first_pass_jobname'))}'>✓ 曾过</span>"
                  if r.get("ever_passed") else "<span class='muted'>-</span>")
    parts.append(f"<tr>")
    parts.append(f"<td>{i}</td>")
    parts.append(f"<td class='task'>{esc(r['task'])}</td>")
    parts.append(f"<td class='{diff_cls}'>{esc(r['difficulty'])}</td>")
    parts.append(f"<td>{esc(r['category'])}</td>")
    parts.append(f"<td>{esc(r['time'])}</td>")
    parts.append(f"<td>{esc(r['provider'])}</td>")
    parts.append(f"<td>{exc_badge(r['exc_type'])}</td>")
    parts.append(f"<td>{ever_badge}</td>")
    parts.append(f"<td>{r['turns']}</td>")
    parts.append(f"<td>{r['tool_calls']}</td>")
    parts.append(f"<td>{fmt_tokens(r['tokens_in'])}</td>")
    parts.append(f"<td>{fmt_tokens(r['tokens_out'])}</td>")
    parts.append(f"<td class='trace'>{esc(r['trial_dir'])}</td>")
    parts.append(f"<td class='diag'>{esc(r['diagnosis'][:120])}</td>")
    parts.append("</tr>\n")
parts.append('</tbody></table>\n')

parts.append('<h2>已通过题</h2>\n')
parts.append('<div class="toggle-passed" onclick="var b=document.getElementById(\'passed-body\');b.style.display=b.style.display==\'none\'?\'\':\'none\';this.textContent=b.style.display==\'none\'?\'▶ 展开 '+str(len(passed))+' 题\':\'▼ 收起\'">▶ 展开 '+str(len(passed))+' 题</div>\n')
parts.append('<div id="passed-body">\n')
parts.append('<table>\n<thead><tr>')
parts.append('<th>#</th><th>题目</th><th>难度</th><th>类别</th><th>运行时间</th><th>provider</th><th>轮次</th><th>工具调用</th><th>token_in</th><th>token_out</th><th>trace 目录</th>')
parts.append('</tr></thead>\n<tbody>\n')
for i, r in enumerate(passed, 1):
    diff_cls = {"easy": "diff-easy", "medium": "diff-medium", "hard": "diff-hard"}.get(r["difficulty"], "")
    parts.append(f"<tr>")
    parts.append(f"<td>{i}</td>")
    parts.append(f"<td class='task'>{esc(r['task'])}</td>")
    parts.append(f"<td class='{diff_cls}'>{esc(r['difficulty'])}</td>")
    parts.append(f"<td>{esc(r['category'])}</td>")
    parts.append(f"<td>{esc(r['time'])}</td>")
    parts.append(f"<td>{esc(r['provider'])}</td>")
    parts.append(f"<td>{r['turns']}</td>")
    parts.append(f"<td>{r['tool_calls']}</td>")
    parts.append(f"<td>{fmt_tokens(r['tokens_in'])}</td>")
    parts.append(f"<td>{fmt_tokens(r['tokens_out'])}</td>")
    parts.append(f"<td class='trace'>{esc(r['trial_dir'])}</td>")
    parts.append("</tr>\n")
parts.append('</tbody></table>\n</div>\n')

if no_result:
    parts.append('<h2>无结果</h2>\n<ul>\n')
    for r in no_result:
        parts.append(f"<li><strong>{esc(r['task'])}</strong>: {exc_badge(r['exc_type'])} ({esc(r['time'])}, <code>{esc(r['trial_dir'])}</code>)</li>\n")
    parts.append('</ul>\n')

parts.append('</body></html>')

with open("results-pro-default.html", "w") as f:
    f.write("".join(parts))

print(f"已生成 results-pro-default.html: {len(passed)} passed, {len(failed)} failed, {len(no_result)} no_result")
