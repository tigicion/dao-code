# DAO CODE 道

**English** · [中文](./README.md)

[![CI](https://github.com/tigicion/dao-code/actions/workflows/ci.yml/badge.svg)](https://github.com/tigicion/dao-code/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](./.nvmrc)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

> **A terminal coding agent built around cost, experience, and availability** — squeezing the most capability and the lowest cost out of the high-value DeepSeek V4.

![DAO CODE demo](docs/demo-en.gif)

DAO CODE (command `dao`) is a terminal-native AI coding assistant: it reads code, writes code, runs commands, and fixes bugs right in your terminal — streaming its reasoning and tool calls while executing safely behind an approval gate, until the task is done. It targets **DeepSeek V4** (1M context), is Chinese-first, and is inspired by Claude Code — but takes a different road: **instead of buying experience with an expensive model, it engineers a high-value model up to the same experience.**

---

## Why DAO?

### 🌐 Availability: open source, and actually usable

A coding agent is only useful if you can actually run it.

- **Claude Code** needs an Anthropic account and network access — a high bar to use out of the box in mainland China;
- **GLM's Coding Plan** has scarce quota that's often hard to grab;
- **DAO is fully open source (MIT)**, and its base **DeepSeek is register-and-go, pay-as-you-go, directly reachable in mainland China** — no network gymnastics, no quota grabbing, no waitlist.

### 💰 Cost: the cheapest of the capable models, and cheaper the more you use it

- **Low unit price** — DeepSeek sits at the lowest price tier among mainstream capable models; both input and output prices are far below the top-tier closed models.
- **Cache cuts it further** — DeepSeek's prefix-cache *hit* price is ≈ **1/10** of a miss. DAO keeps the system prefix / tool table / memory **byte-stable**, and runs reflection & memory on cache-reusing forks, so the hit rate keeps climbing.
- **Measured** (reproducible via `npm run accept:cache`): multi-turn hit rate climbs **31% → 89% → 94% → 96.3%**; within one session cumulative input grew from 14K → **324K tokens (23×)** while cost rose only **¥0.030 → ¥0.054** (miss volume stays flat at ~12K, almost entirely the cold start). A full feature (read + edit + test + self-review) measures ≈ **¥0.1**; an 83-tool-call long task ≈ **¥0.33**. Watch hit rate & cost live with `/cost`.

### 🧠 Experience: context engineering + make the agent adapt to you

- **Cross-session memory + a reflection layer** — remembers your preferences and project conventions; self-reviews when stuck and pulls back when drifting. All three run as **forks that reuse the main prefix cache** — better quality at almost no extra spend.
- **Long tasks don't drift or hit the wall** — auto-compaction carries context past the limit, and periodic refocusing curbs scope creep, so it stays on track even running autonomously for a long time.
- **Constitution-style priority** — safety & truth > your current instruction > DAO's core policy (model / cache discipline) > skills / memory. A third-party skill you install can change *how work is done*, but never the safety and cache bottom line.

### ✅ Verified

On a SWE-bench-style benchmark drawn from recent real-world open-source bug fixes (dual-track fail2pass + pass2pass judging, with test files hidden from the agent to prevent reward-hacking): **13/14 solved reliably.** See [Testing & evaluation](#-testing--evaluation).

---

## ✨ Features

The basics (tools / permissions / Skills / MCP / Hooks / subagents / rich TUI) mirror Claude Code and are all there. Here are the parts that **actually set DAO apart**:

### 🗜️ Context & cache engineering

A **byte-stable** system prefix rides DeepSeek's prefix cache to the max; reflection and memory run on **forks that reuse the main cache** (without breaking the prefix); near the limit it auto-compacts (reactive retry + in-place clearing of stale tool results + incremental summary + hard-truncate fallback if the summarizer fails); oversized output spills to disk, leaving only a pointer in context. `/cost` shows hit rate & spend; `/audit cache` pinpoints "what broke the cache" via a four-dimension fingerprint.

### 🧠 Cross-session memory (self-verifying)

At session end it distills your preferences, project conventions, and key facts; **at startup it deterministically verifies them against the current code** — stale ones dropped, changed ones flagged, rather than blindly piling up history. A decay GC clears dead memories; the model can `memory_read` on demand.

### 🔍 Reflection layer (self-correct when stuck / drifting)

**Challenger**: on a failure streak or recurring error, a skeptical independent review that questions the premise. **Refocuser**: every N turns on a long task, restate the original goal and catch scope creep. **Reply-challenger**: kicks in when you re-raise the same problem. All three run as cache-reusing forks — at almost no extra spend.

### 🪢 Long-task robustness

Session log + crash recovery (`dao -c`); **shadow-git checkpoints** (`/restore` `/rewind`, a separate snapshot that never touches your `.git`); todo list survives compaction to prevent goal drift; Definition-of-Done verification (`/dod` + `verify_done`); stuck detection with a circuit breaker; parallel / background / worktree-isolated subagents with two-way child↔parent messaging; `--goal` autonomous long-task mode.

### 🎐 A Taoist-aesthetic terminal experience

Rich Ink rendering + a Taiji splash + light/dark adaptation; `@` file references, slash-command Tab completion, **steering (type while a turn is running, queued)**, diffs with line numbers + syntax highlighting, thinking blocks, todo checklists, a Taoist-verb spinner; **ESC interrupts** (model stream and shell stop together); non-TTY auto-fallback to a plain-text REPL.

> **Basics (mirror CC, all shipped):** 24 tools · layered `allow/ask/deny` permissions + `auto` smart approval + defense-in-depth (secret scanning / SSRF / sandbox / keychain) · Skills (incl. **auto-adapting foreign skills'** tool names & model tiers) · MCP (stdio + HTTP/SSE, tools/resources/prompts) · Hooks (5 lifecycle events) · custom subagents / slash commands / plugins · multi-account profiles (`/account`) · OS cron scheduling (`/schedule`). See [Extension system](#-extension-system-mirrors-claude-code) and the tool overview below.

---

## 📦 Install

**A. Standalone binary (no Node, all platforms)** — download for your platform from [Releases](../../releases):

| Platform | File | Run |
|---|---|---|
| macOS (Apple silicon) | `dao-darwin-arm64` | `chmod +x dao-darwin-arm64 && ./dao-darwin-arm64` |
| macOS (Intel) | `dao-darwin-x64` | same as above |
| Linux | `dao-linux-arm64` / `dao-linux-x64` | `chmod +x dao-linux-* && ./dao-linux-*` |
| Windows | `dao-windows-x64.exe` | double-click, or run `dao-windows-x64.exe` in a terminal |

> On macOS, if a **browser** download says "cannot verify developer", clear the quarantine: `xattr -d com.apple.quarantine dao-darwin-*` (or right-click → Open once). Command-line downloads (`curl`/`gh`) don't hit this.
> You can rename the file to `dao` and put it on your `PATH` to just run `dao`.

**B. npm (Node ≥ 20, all platforms)** — published:

```bash
npx dao-code        # zero-install trial (verified working)
npm i -g dao-code   # global install, command name dao
```

**C. From source** (contributors):

```bash
git clone https://github.com/tigicion/dao-code.git && cd dao-code
npm install && npm run build && npm link   # then dao is global
# or run directly in dev: npm run dev
```

---

## 🚀 Quick start

1. Get a DeepSeek API key: <https://platform.deepseek.com/api_keys>

2. **Launch → follow the prompt to enter your key (easiest, all platforms, recommended):**

   ```bash
   dao                # installed (binary / global); or npx dao-code
   ```

   On first run with no key detected, it walks you through pasting one and saves it to `~/.dao/config.json` (auto-read next time — no env setup needed).

3. Or set the key manually (pick one for your OS):

   | How | Command |
   |---|---|
   | `.env` (project root, all platforms) | a line `DEEPSEEK_API_KEY=sk-...` |
   | macOS / Linux | `export DEEPSEEK_API_KEY=sk-...` |
   | Windows PowerShell | `$env:DEEPSEEK_API_KEY="sk-..."` |
   | Windows CMD | `set DEEPSEEK_API_KEY=sk-...` |

4. Light terminals: type `/theme` at runtime, or set `DAO_THEME=light` before launch.

Common slash commands (full list via `/help`):

| Command | Effect |
|---|---|
| `/init` | Scan the repo and generate `DAO.md` (project overview/conventions, auto-loaded in future sessions) |
| `/model [id]` | Switch model (no arg toggles `deepseek-v4-pro` / `deepseek-v4-flash`) |
| `/mode [x]` | Permission mode `default` / `acceptEdits` / `auto` (smart approval) / `plan` (also **Shift+Tab** to cycle) |
| `/plan` | Quick toggle plan (read-only + propose) / normal |
| `/goal <objective>` | Autonomous long-task mode (auto-approve + keep going; large tasks auto-staged) |
| `/cost` | Token usage & cache hit rate |
| `/skills` | List / toggle skills |
| `/compact` | Compact the conversation · `/clear` clear · `/help` command list · `/exit` (also `/quit`) quit |

> Add `--yolo` at launch (e.g. `dao --yolo` / `dao --yolo "task"`) to start in auto-approve; toggle anytime with `/yolo`.
> `dao --verbose` (or `--debug`) enters verbose mode **at startup**: full tool results, full thinking, and raw tool arguments.
> Plain `dao` truncates by default; at runtime press **Ctrl+O** to expand/collapse full output (mirrors CC). History already printed to the scroll region can't be edited in place, so expanding re-prints the most recent collapsed block once.

---

## ⌨️ Usage

**Interactive mode** (default):

```bash
dao
```

- Type a message and press Enter; `↑/↓` browse history; `Esc` interrupts the current turn; lines starting with `/` are slash commands (with completion hints).
- Inline editing: `←/→` move cursor, `Ctrl-A/E` line start/end, `Ctrl-W` delete word, `Backspace/Delete` delete at cursor; paste supported (no auto-submit).
- `@` to reference a file: type `@` + a path fragment to list matches, `Tab` to complete.
- Write/exec operations go through the approval gate (`[y] once  [a] remember (write allow rule)  [n] deny`); you can also pre-allow or block with allow/ask/deny rules in `.dao/settings.json` (see "Extension system · Permissions"); `/yolo` or `--yolo` auto-approves everything (deny still blocks).

**One-shot mode** (task as an argument, exits when done, no memory distillation, good for scripts):

```bash
dao "make formatDate in src/utils.ts timezone-aware"
```

---

## 🧠 How it works

```
You ──▶ Ink TUI ──▶ agent loop ──▶ DeepSeek V4
                       │  streamChat (streaming reasoning + answer)
                       │  ▶ model requests a tool call
                       │  ▶ approval gate (write/exec needs clearance)
                       │  ▶ run tool → feed result back
                       └─ loop until the model stops requesting tools
```

- **agent loop** (`src/agent/loop.ts`): each turn calls `streamChat` to stream reasoning + answer; if the model requests a tool, it runs through the approval gate, feeds the result back, and loops until done or max turns; `AbortSignal` is threaded through the model stream and tools for ESC interrupts.
- **Modes**: in plan mode, even a write/exec tool request is denied for the turn by the per-turn allow table (read-only + propose); normal mode runs as usual.
- **Memory** (`src/memory/`): at startup migrate → load → deterministically verify against live code → inject into the fixed prefix; on exit distill new facts with the cheap flash model and upsert after dedup.
- **Cache & compaction**: the system prefix is pinned to ride DeepSeek's prefix cache; near the 1M context limit early messages are auto-compacted into a summary.

---

## 🪢 Long-task robustness

Built for long tasks that "run autonomously for a long time without drifting, are recoverable, and can be verified":

- **Session log + crash recovery**: each turn writes events to `.dao/sessions/<id>/events.jsonl` and a state snapshot to `state.json`; after a crash/abnormal exit, `dao -c` resumes the last session (`src/session/log.ts`).
- **Shadow git checkpoints**: a separate `.dao/shadow.git` snapshots the working tree (never touches your `.git` / never rewrites your history); `/restore` reverts the last turn's changes in one step (`src/session/checkpoint.ts`).
- **Todo list survives compaction**: the list maintained by `todo_write` is re-injected as a system message after compaction, preventing goal drift on long tasks.
- **Definition-of-Done verification**: `/dod <command>` (or `DAO_VERIFY_CMD`) sets an executable acceptance command; `verify_done` runs it — only success (exit 0) counts as done; if unset, the model self-judges from evidence.
- **Stuck detection + circuit breaker**: repeating the same tool call / hitting the same error past a threshold → first a nudge to change approach, then a stop, so it doesn't spin and burn budget (`src/agent/stuck.ts`).
- **Large output spilled to disk**: when tool output exceeds a threshold it's spilled in full to `.dao/spill/`; the context keeps only a truncation + pointer, fetched back on demand via `read_file`.
- **Parallel / background subagents + notification queue**: pass `tasks[]` to run in parallel, or `background:true` to run in the background (returns immediately, doesn't block the main loop); on completion the result is auto-injected as a `<task-notification>` to continue (`src/agent/tasks.ts`).
- **On-demand memory retrieval**: `memory_read` lets the model actively retrieve cross-session memory (startup injects only top-K; truncated or just-written entries are still findable).
- **Long-task autonomous mode**: `dao --goal` (legacy `--task` / `--coordinator` still accepted) or `/goal <objective>` at runtime — auto-approve + autonomous continuous progress + higher turn cap; large tasks auto-stage (parallel research → synthesize → implement → `verify_done`), asking you only when truly stuck.

---

## 🧩 Extension system (mirrors Claude Code)

- **Permissions (1:1 with CC)**: three-state rules `allow / ask / deny`, syntax `Tool(specifier)` — `Bash(npm run test:*)` (command prefix), `Edit(src/**)`/`Read(//etc/**)` (gitignore-style path glob), `WebFetch(domain:example.com)`, bare tool names, `mcp__server__tool`. Priority **deny > ask > allow > mode/capability default** (deny is a hard blacklist, blocking even under YOLO). Tool names auto-map (exec_shell↔Bash, read_file↔Read, edit_file↔Edit, fetch_url↔WebFetch…), so CC's settings.json rules work as-is.
  - **Layering** (low→high priority): `~/.dao/settings.json` (user) < `.dao/settings.json` (project, committed) < `.dao/settings.local.json` (local, not committed) < **CLI** (`--allow`/`--deny`/`--add-dir`/`--permission-mode`) < **enterprise managed policy** (`/etc/dao/managed-settings.json` etc., not overridable by lower layers).
  - **Compound commands checked per-segment**: `cd /tmp && rm -rf x` is split on `&&`/`||`/`;`/`|`; any sub-command hitting deny blocks the whole line (no bypass).
  - **Permission modes** (`/mode <x>` or **Shift+Tab** to cycle; shown in the status bar): `default` (approve on demand) / `acceptEdits` (auto-approve file edits) / `auto` (AI-classifier smart approval: read-only and in-workspace edits auto-pass, uncertain ones go to a human) / `plan` (read-only planning); `bypassPermissions` (= YOLO) is launch-only via `dao --yolo`.
  - **Four approval choices**: `[y]` once / `[s]` this session / `[a]` remember (write an allow rule to `.dao/settings.local.json`) / `[n]` deny.
  - `additionalDirectories`: pre-authorized directories outside the workspace, read without prompting.
  - Engine: `src/permissions/` (rules / identity / settings / engine / gate), with end-to-end tests.
- **Custom subagent types**: `.dao/agents/<name>.md` (frontmatter: name/description/tools allowlist/model + body prompt). Pick with the `agent` tool's `agent_type`; each has its own role and tools.
- **Custom slash commands**: `.dao/commands/<name>.md` (body is a prompt template, `$ARGUMENTS`/`$1`). `/<name> args` expands into a single turn.
- **Skills (ready-to-use skills)**: `.dao/skills/<name>/SKILL.md`. Progressive disclosure: startup lists only name+description; the model loads the body on demand via the `skill` tool.
- **Hooks (lifecycle hooks)**: `.dao/hooks.json`. PreToolUse (can block) / PostToolUse (e.g. auto-format) / UserPromptSubmit (inject context / block) / SessionStart / End.
- **MCP**: `.dao/mcp.json` (same format as Claude Desktop). Connects to stdio MCP servers; tools auto-register as `mcp__<server>__<tool>`.
- **Subagent orchestration**: parallel `tasks[]`, async `background:true`, `isolate:true` git-worktree isolation, `task_send` to append instructions to a running task, foreground timeout auto-converts to background, transcripts spilled to `.dao/subagents/`.
- **Steering**: type during a running turn; Enter queues it, processed automatically once the current turn ends.

## 🛠️ Tool overview

Registry in `src/index.ts`, implementations in `src/tools/`.

| Tool | Effect |
|---|---|
| `read_file` | Read a text file, returns numbered content (supports offset/limit) |
| `list_dir` | List directory entries |
| `write_file` | Create or wholesale-rewrite a file (must have read it before overwriting) |
| `edit_file` / `multi_edit` | Exact string replacement (single / many at once) |
| `notebook_edit` | Edit Jupyter notebook cells |
| `exec_shell` (+`_poll`/`_kill`) | Run shell; foreground/background (`background=true`), read output, terminate |
| `grep_files` / `file_search` | Search by content regex / by filename glob |
| `ask_user` | Ask the user one clarifying question and wait |
| `fetch_url` / `web_search` | Fetch web page as text / DuckDuckGo web search |
| `todo_write` | Maintain a single-level task list (whole-table replace) |
| `verify_done` | Run the DoD acceptance command to decide if the task is complete |
| `memory_write` / `memory_read` | Record a cross-session memory / retrieve on demand |
| `skill` / `skill_install` | Load a skill body / install an external skill |
| `agent` / `task_send` / `message_parent` | Dispatch a subagent / append to a running one / child→parent reply |
| `schedule` | Create an OS crontab scheduled task |

---

## 🧪 Testing & evaluation

Unit tests (Vitest):

```bash
npm test          # run once
npm run test:watch
npm run typecheck
```

> `npm audit` warnings all come from the **dev test toolchain** (vitest / vite / esbuild), are not shipped in the release artifact (`dist`), and don't affect the `dao` runtime; the critical one is a `vitest --ui` server vulnerability (unused by this project). CI: [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

Agent end-to-end evaluation lives in `evals/`: SWE-bench-style, drawn from recent real open-source bug fixes, with **dual-track fail2pass / pass2pass verification** (after the fix the target test flips from fail to pass, and existing functional tests aren't broken); test files are hidden from the agent and injected only after the run, to prevent reward-hacking.

```bash
DEEPSEEK_API_KEY=sk-... node evals/run.mjs            # default 3 runs per task, see pass^k reliability
DEEPSEEK_API_KEY=sk-... EVAL_RUNS=1 node evals/run.mjs # smoke test
```

> Evaluation makes real model calls and incurs cost; each task runs in a throwaway temp dir — set `DAO_AUTO_APPROVE=1` for unattended runs. See [`evals/README.md`](evals/README.md).

---

## ⚙️ Configuration

| Variable | Description | Default |
|---|---|---|
| `DEEPSEEK_API_KEY` | API key (env / `.env` / `~/.dao/config.json` / first-run wizard) | — |
| `DEEPSEEK_BASE_URL` | API endpoint | `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | Default model | `deepseek-v4-pro` |
| `DAO_THEME` | Force terminal background `light` / `dark` | detected from `COLORFGBG` / OSC 11, else `dark` |
| `DAO_REASONING_EFFORT` | Reasoning effort | `max` |
| `DAO_MAX_TURNS` | Max tool turns per turn | `50` |
| `DAO_AUTO_APPROVE` | Skip all approvals (**sandbox/eval only**) | off |
| `DAO_REFOCUS_EVERY` | Refocuser: re-check direction every N turns on long tasks (`0`=off; only in `--goal` long-task mode) | `3` |
| `DAO_FAIL_STREAK` | Challenger: review progress after this many consecutive failed turns (interactive only) | `3` |
| `DAO_REPEAT_ERR` | Challenger: review progress after the same error recurs this many times (interactive only) | `2` |
| `DAO_CHALLENGE_REPEAT_SIM` | Challenger: similarity threshold for "user re-raising the same problem" → async challenger (`0`=off; interactive only) | `0.1` |
| `DAO_REFLECT` | Set `0` to globally disable the reflection layer (challenger + refocuser) | on |

---

## 🗺️ Status

Released **v0.1.20** (npm `dao-code` + multi-platform binaries on Releases). Core is complete: Ink TUI and Taiji splash, streaming agent loop, 24 tools, layered permissions, persistent memory, cache engineering, the reflection layer, long-task robustness, Skills/MCP/Hooks/subagent extensions, and a real OSS evaluation harness. Actively iterating — issues/PRs welcome.

---

## 🤝 Contributing

Issues and PRs welcome! Onboarding, scripts, and commit conventions are in [CONTRIBUTING.md](./CONTRIBUTING.md); the community guidelines are in [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
**Do not file security vulnerabilities via public issues** — report them privately per [SECURITY.md](./SECURITY.md). Changelog: [CHANGELOG.md](./CHANGELOG.md).

---

## 📄 License

MIT © tigicion
