# DAO CODE 道

**English** · [中文](./README.md)

[![CI](https://github.com/tigicion/dao-code/actions/workflows/ci.yml/badge.svg)](https://github.com/tigicion/dao-code/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](./.nvmrc)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

> **A terminal coding agent that refuses to trade cost for experience** — built on DeepSeek V4, the cheapest capable model, and made affordable by aggressive prefix-cache reuse and context engineering. Ink-mat black · jade green · cinnabar, a Taiji splash screen, the *Tao Te Ching* as company.

<!-- Demo: record a Taiji splash + a chat/tool-call stream as an asciinema/gif (e.g. docs/demo.gif), then uncomment the line below. -->
<!-- ![DAO CODE demo](docs/demo.gif) -->

DAO CODE (command `dao`) is a terminal-native AI coding assistant: it reads code, writes code, runs commands, and fixes bugs right in your terminal — streaming its reasoning and tool calls while executing safely behind an approval gate, until the task is done. It targets **DeepSeek V4** (1M context), is Chinese-first, and is inspired by Claude Code — but takes a different road: **instead of buying experience with an expensive model, it engineers a cheap model up to the same experience.**

```
        ☯   DAO CODE
   "The Tao that can be told is not the eternal Tao." — Laozi
```

---

## Why DAO? (Cost × Experience)

In one line: **others trade up to a pricier model for experience; DAO delivers the same experience on the cheapest model by feeding the model the right context and squeezing the cache dry.**

### 💰 Cost: structurally cheap, not stingy

- **Available in China, low per-token price** — DAO is built on DeepSeek V4: directly reachable from mainland China, with token prices far below the top-tier closed models.
- **Aggressive cache reuse** — DeepSeek's prefix-cache *hit* price is roughly 1/10 of a miss. DAO lays out the system prefix / tool table / memory to be **byte-stable**, keeps subagent model switches from breaking the main cache, and aligns memory distillation against the already-cached prefix — so the already-cheap cache stays hit and drives cost down further. Watch the hit rate live with `/cost`.
  - **Measured** (reproducible via `npm run accept:cache`, multi-turn chat): cache hit rate climbs to a steady state of **31% → 89% → 94% → 96.3%** over turns; within one session cumulative input tokens grew from 14K to **324K (23×)** while cost rose only **¥0.030 → ¥0.054**. The miss volume stays flat at ~12K tokens the whole time (almost entirely the one-time cold start), so the longer the context the more of its growth lands on the cache at ~1/10 the price — costing almost nothing. Real coding sessions, with large file/diff payloads per turn, reach the high plateau even faster.

### 🧠 Experience: give the model the context it needs + make the model adapt to you

Experience boils down to two things; every feature below is a facet of one or the other:

- **Give the model context** — cross-session persistent memory, on-demand Skills, MCP external tools, automatic compaction, and (parallel / background) subagents.
- **Make the model adapt to you** — a user model & preferences captured in memory, Hooks for custom lifecycle behavior, and an approval gate that can "remember for this session / write an allow rule."

### ✅ Verified

On a SWE-bench-style benchmark drawn from recent real-world open-source bug fixes (dual-track fail2pass + pass2pass judging, with test files hidden from the agent to prevent reward-hacking): **13/14 solved reliably.** See [Testing & evaluation](#-testing--evaluation).

---

## ✨ Features

**💰 Cost**

- **Prompt-cache aware** — exploits DeepSeek's prefix cache by pinning a stable system prefix to raise the hit rate; `/cost` shows token usage and cache hit rate in real time.

**🧠 Experience · giving the model context**

- **Persistent memory** — at session end it distills atomic facts and a user model that persist across sessions; at startup it deterministically verifies them against the live code (stale entries dropped / changes flagged), and a decay GC clears dead memories.
- **Subagents** — the `agent` tool hands an independent subtask to a subagent that runs it to completion and returns only the final result (supports parallel `tasks[]` and `background`).
- **Automatic compaction** — when nearing the context limit, early conversation is automatically summarized, preserving key facts / changes / decisions / open items.
- **Skills / MCP / Hooks** — on-demand built-in skills, external MCP tools, and lifecycle hooks (see [Extension system](#-extension-system-mirrors-claude-code)).

**🎐 Experience · adapting to you & interaction**

- **Rich Ink terminal TUI** — inline rendering on Ink (React for CLI), preserving native terminal scrollback and text selection; a Taiji splash screen (procedural yin-yang fish, jade→ink gradient wordmark, a random *Tao Te Ching* maxim). Conversation display mirrors Claude Code: tool-result `⎿` sub-blocks (Bash/grep show truncated output), thinking kept in history (dim ✻ blocks), diffs with line numbers + context + syntax highlighting, todo checklists; the spinner cycles verbs from the *Tao Te Ching* / *Zhuangzi* (comprehend / observe / contemplate / wander / transform…). Truncated by default, **Ctrl+O** to expand; `dao --verbose` is full from startup.
- **Streaming + tools + approval** — real-time streaming of reasoning and answers, autonomous tool calls, every write/exec operation passing through an approval gate (can remember "always allow this session").
- **ESC to interrupt** — built on `AbortController`, one key cancels the in-flight turn (the model stream and any running shell command stop gracefully).
- **plan / normal dual modes** — plan mode is read-only + proposes a plan, structurally blocking all write/exec tools; normal mode lands changes as usual.
- **Cross-platform light/dark adaptation** — picks colors from `DAO_THEME` / `COLORFGBG`, so light terminals aren't washed out and dark ones aren't muddy.
- **Non-TTY fallback** — under pipes / CI / eval it falls back to a plain-text readline REPL with identical behavior.

---

## 📦 Install

**A. Standalone binary (no Node)** — easiest: download the `dao-*` for your platform from [Releases](../../releases), `chmod +x`, and run.

**B. npm (Node ≥ 20)** — once published to npm:

```bash
npx dao-code        # zero-install trial
npm i -g dao-code   # global install, command name dao
```

**C. From source** (contributors):

```bash
git clone <repo-url> dao-code && cd dao-code
npm install && npm run build && npm link   # then dao is global
# or run directly in dev: npm run dev
```

---

## 🚀 Quick start

1. Set your DeepSeek API key (any one of these):

   ```bash
   export DEEPSEEK_API_KEY=sk-...        # environment variable
   # or write .env in the project root: DEEPSEEK_API_KEY=sk-...
   ```

   On first run in a real terminal with no key detected, it walks you through pasting one and can save it to `~/.dao/config.json`.
   Get a key: <https://platform.deepseek.com/api_keys>

2. Launch:

   ```bash
   dao                # installed
   npm run dev        # from source (tsx src/index.ts)
   ```

3. For light terminals:

   ```bash
   export DAO_THEME=light
   ```

Slash commands:

| Command | Effect |
|---|---|
| `/model [id]` | Switch model (no arg toggles between `deepseek-v4-pro` / `deepseek-v4-flash`) |
| `/plan` | Toggle plan (read-only + propose) / normal mode |
| `/mode [x]` | Switch permission mode `default`/`acceptEdits`/`plan`/`bypassPermissions` (also **Shift+Tab** to cycle) |
| `/yolo` | Toggle YOLO (= bypassPermissions): auto-approve all write/exec ops (deny rules still block) |
| `/clear` | Clear the conversation (keep system setup) |
| `/compact` | Manually compact the conversation |
| `/cost` (also `/cache`) | View token usage and cache hit rate |
| `/help` | List available commands |
| `/exit` (also `/quit`) | Quit |

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
- **Parallel subagents**: pass `tasks[]` to the `agent` tool to dispatch several independent subagents in parallel and aggregate.
- **Async background subagents + notification queue**: pass `background:true` to run in the background, return immediately, and not block the main loop; on completion the result is auto-injected as a `<task-notification>` to continue (`src/agent/tasks.ts`). The status bar shows the count of running background tasks.
- **On-demand memory retrieval**: `memory_search` lets the model actively retrieve cross-session memory (startup injects only top-K; truncated or just-written entries are still findable).
- **Long-task autonomous mode**: `dao --task` or `/task` — auto-approve + autonomous continuous progress + higher turn cap + a final summary; asks you only when truly stuck.
- **Coordinator orchestration**: `dao --coordinator` or `/coordinator` — turns a larger task into a multi-agent workflow (parallel research → synthesize → implement → verify) on top of async background subagents + the notification queue: dispatch research workers → end the turn → results feed back → synthesize & implement → `verify_done`.

---

## 🧩 Extension system (mirrors Claude Code)

- **Permissions (1:1 with CC)**: three-state rules `allow / ask / deny`, syntax `Tool(specifier)` — `Bash(npm run test:*)` (command prefix), `Edit(src/**)`/`Read(//etc/**)` (gitignore-style path glob), `WebFetch(domain:example.com)`, bare tool names, `mcp__server__tool`. Priority **deny > ask > allow > mode/capability default** (deny is a hard blacklist, blocking even under YOLO). Tool names auto-map (exec_shell↔Bash, read_file↔Read, edit_file↔Edit, fetch_url↔WebFetch…), so CC's settings.json rules work as-is.
  - **Layering** (low→high priority): `~/.dao/settings.json` (user) < `.dao/settings.json` (project, committed) < `.dao/settings.local.json` (local, not committed) < **CLI** (`--allow`/`--deny`/`--add-dir`/`--permission-mode`) < **enterprise managed policy** (`/etc/dao/managed-settings.json` etc., not overridable by lower layers).
  - **Compound commands checked per-segment**: `cd /tmp && rm -rf x` is split on `&&`/`||`/`;`/`|`; any sub-command hitting deny blocks the whole line (no bypass).
  - **Permission modes** (`/mode <x>` or **Shift+Tab** to cycle; shown in the status bar): `default` (approve on demand) / `acceptEdits` (auto-approve file edits) / `plan` (read-only planning) / `bypassPermissions` (= YOLO, skip approval but deny still blocks).
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
| `edit_file` | Exact string replacement (`old_string` must be unique, or use `replace_all`) |
| `exec_shell` | Run shell in the workspace; supports foreground/background (`background=true`) |
| `exec_shell_poll` | Read new output and status of a background process |
| `exec_shell_kill` | Terminate a background process (SIGTERM) |
| `grep_files` | Search by content regex (content/files modes) |
| `file_search` | Search files by filename glob |
| `ask_user` | Ask the user one clarifying question and wait |
| `fetch_url` | Fetch a web page and return de-tagged plain text |
| `web_search` | Search the web via DuckDuckGo |
| `todo_write` | Maintain a single-level task list (whole-table replace) |
| `memory_write` | Record a stable cross-session memory |
| `agent` | Dispatch an independent subtask to a subagent |

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

---

## 🗺️ Status

MVP complete: interactive Ink TUI and Taiji splash, streaming agent loop, full tool set, approval gate, ESC interrupt, persistent memory, prompt-cache awareness, plan/normal modes, automatic compaction, subagents, and a real OSS evaluation harness. Actively iterating.

---

## 🤝 Contributing

Issues and PRs welcome! Onboarding, scripts, and commit conventions are in [CONTRIBUTING.md](./CONTRIBUTING.md); the community guidelines are in [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
**Do not file security vulnerabilities via public issues** — report them privately per [SECURITY.md](./SECURITY.md). Changelog: [CHANGELOG.md](./CHANGELOG.md).

---

## 📄 License

MIT © tigicion
