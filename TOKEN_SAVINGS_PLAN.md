# Token Savings Plan

How to make the orchestrator use fewer tokens per session, both in the main session's context and in the agents it runs, which share the account's usage limits. Branch: `token-savings`.

Status: items **1, 2, 3 and 6 are built** (§3). Items 4, 5 and 7 are specified in §4 and being built.

## 1. Where the tokens went (measured in the pilot sessions)

| Where | Cost | Why |
|---|---|---|
| Subagents, memory-harness round (6 agents, Opus) | ~806k tokens (113–193k each) | Each read the whole 50 KB plan (~12k tokens), much of `register.tsx` (85 KB, ~21k) and other large files, then explored on its own |
| Subagents, HUD-controls round (4 agents, Sonnet) | ~305k tokens (62–92k each) | Tighter prompts and a cheaper model already cut it about 3× |
| Main session, per task | each prompt about 3 times | The prompt is in the `dispatch` call, again in the `[orchestrator]` launch request, and again in the Agent call. Ten tasks of ~2.3k characters each come to ~17k tokens of repeats |
| Main session, reports | ~1–1.5k tokens per agent | Reports had no length limit, and each stays in context until compaction |

## 2. The improvements, ranked by saving for the work

| # | Improvement | Saves | Work | Status |
|---|---|---|---|---|
| 1 | **No third copy of the prompt.** For a task the main session dispatched since the last compaction, the launch request says "use the prompt you gave dispatch", plus any additions (memory brief, resume note, report note). Prompts queued from the HUD or pane are still sent in full | ~⅓ of per-task overhead in the main session | Small | **Built** |
| 2 | **Short reports.** Every agent and process task is told to end with at most N words (default 150), and to put longer detail in a report file the main session reads only when needed | 5–8k tokens of main context per fan-out of six | Small | **Built** |
| 3 | **Default task model and effort.** Tasks with no model or effort set get the defaults from Settings: Sonnet and medium out of the box. Ask for Opus when a task needs it | About 3× on agent tokens (measured: memory round vs HUD round) | Small | **Built** |
| 4 | **Briefs instead of whole plans.** `dispatch` takes a list of files or plan sections, which becomes the agent's reading list, so a unit does not read the whole plan | ~12k tokens × agents per fan-out | Medium | Planned |
| 5 | **Split the two huge files.** Move the HUD's CSS and JS out of `index.html` (93 KB) into `web/hud/`, and split `register.tsx` (85 KB) into modules, so agents read 5–10 KB instead of 90 | Up to ~20k tokens per agent that touches the HUD or the core | Medium (refactor) | Planned |
| 6 | **Slow down before the limit.** Above a threshold of the 5-hour or weekly window (default 80%), the orchestrator runs fewer tasks at once (default 2). This sits ahead of the existing standby at 100% | Spreads what is left of a window instead of spending it on six agents at once | Small | **Built** |
| 7 | **Shared context written once** (`dispatch_batch`). *Revised*: the first idea, putting the shared part of fan-out prompts first so agents reuse the cache, does not work, because an agent's prompt is one text block and caching only reuses text up to a breakpoint. Instead the shared text is written once and kept in a brief file each agent reads | The shared part of a fan-out, once in the main session instead of N times; with item 4, agents read one short brief | Small | Specified (§4.3) |

Also small:
- `status` with an id returns up to 2,000 characters of output; the summary alone is often enough.
- The ledger snapshot cap (6,000 characters) could drop to ~3,000.

## 3. What was built

### 3.1 No third copy of the prompt (item 1)

- **When the full prompt is left out:** each task records whether the main session dispatched it, and in which "context epoch". The epoch goes up at every compaction of the main conversation and at `/clear`. Only a task dispatched in the current epoch skips the full prompt, because only then is its dispatch call still in context.
- **What the launch request says instead:** "prompt: the exact prompt you passed to dispatch for this task". It adds the text to put before it (the memory brief) and after it (a resume note, the report note), between marker lines.
- **Checking the launch:** the `agent.spawn` hook checks that the launched prompt contains the dispatch prompt (whitespace aside). If it does not, the launch is refused and the task is asked for again with the full prompt. The prompt is never rewritten by the plugin, so what auto mode judged is what runs.

### 3.2 Short reports (item 2)

Setting **Report length** (`reportWords`; 150 by default, 0 turns it off). The orchestrator appends to every task's prompt:

> When you finish, reply in at most 150 words: the outcome, the files you changed, and anything left undone or blocking. Put longer detail in `<memory folder>/reports/<task id>.md` and give that path.

When memory is off, the file part is left out.

### 3.3 Default task model and effort (item 3)

Settings **Default task model** (`defaultTaskModel`, `sonnet`) and **Default task effort** (`defaultTaskEffort`, `medium`). They apply to any task queued with no model or effort of its own: from `dispatch`, the HUD or the pane. Set either to Default (`''`) to leave the choice to Claude Code.

### 3.4 Slow down before the limit (item 6)

Settings **Slow down at** (`throttleAtPercent`, 80; 0 turns it off) and **Tasks at once when slowed** (`throttledParallel`, 2). While any usage window is at or above the threshold, at most that many tasks run at once, or fewer if Max parallel is lower. Tasks already running are not stopped. The status line shows `slowed`. Standby at 100% works as before.

## 4. Specifications for items 4, 5 and 7

### 4.1 Item 5: split the two huge files (two Sonnet agents, in parallel)

Pure refactors: **no change in behavior.** Every existing test passes unchanged (tests may change only their imports), the project type-checks, and `claude plugin validate .` passes.

**5a, the HUD (`web/index.html`, 1,945 lines: CSS on lines 11–378, one inline script on lines 532–1,942).**
- **CSS** moves to `web/hud.css`, and `web/server.mjs` serves it (token-checked like the module scripts).
- **Script** moves to `web/hud/core/*.js`: plain scripts loaded in order before the existing modules (`session`, `tasks`, `permissions`). They share one namespace object instead of the IIFE's closure.
  - Suggested files: `state.js` (state, transport, `window.HUD`), `orb.js` (canvas), `ui.js` (tasks, drawer, comms, settings), `diffs.js`, `voice.js` and `boot.js`.
  - Each file stays under ~25 KB.
- **`index.html`:** keeps only markup and the loader, and ends under ~15 KB.
- **`window.HUD`:** the contract is unchanged.
- **Check:** a smoke test in a browser: start `node web/server.mjs --port 4792 --token <16+ chars>`, push a snapshot and a `history` event to `/api/push`, then open the page. Expect no console errors, and the header, task list, drawer, Comms and dispatch popover all working.

**5b, the plugin core (`hooks/register.tsx`, 2,368 lines).** `register.tsx` becomes wiring only (the `on(...)` hooks, each calling named functions), under ~25 KB. The logic moves to `hooks/core/`:

| File | Holds |
|---|---|
| `state.ts` | Every atom (`projects`, `tasks`, `settings`, `view`, `draft`, `hud`, `limit`), `DEFAULT_SETTINGS`, and accessor functions (`getTasks`, `setTask`, `updateTasks(fn)`, `getSettings`, `applySettings`, …) |
| `queue.ts` | `addTasks`, `pump`, `launch`, `finish`, `killTask`, `retryTask`, `askLaunches` / `checkLaunches` / `onLaunched`, `describeTask` |
| `standby.ts` | Usage-limit standby: `enterLimit`, `exitLimit`, `recheck`, `requeue`, `onLimitFailure` |
| `hud-bridge.ts` | `hudSnapshot`, `onHudCommand`, the server start/stop/tick, `pushHistory` |
| `pane.tsx` | The pane's `ui.render` body as a function |
| `tools.ts` | Tool schemas, and the handlers for `dispatch`, `status`, `projects` and the memory tools |
| `ping.ts` | The all-done ping |

Engine rules the split must respect (found in this repo):
- `$` may only be passed to functions named directly (named imports, never `ns.fn($)`).
- `update(...)` and `read(...)` take an atom defined **in the same file**. That is why every atom and its accessors live in `state.ts`, and other files go through those accessors.
- Module-level variables (the live handles) must have one owner, and other files use functions.

### 4.2 Item 4: briefs instead of whole plans

- **`reads` on `dispatch`** (and on each `dispatch_batch` task): a list of `path` or `path#Heading`, relative to the project folder.
- **The brief file:** at dispatch the orchestrator writes `<memory folder>/briefs/<task id>.md`:
  - each `#Heading` entry becomes that section's text, from its heading to the next heading of the same or a higher level;
  - each plain `path` is listed as a file to read.
- **What the prompt gets:** one line, "Read the brief at <path> first; it has the sections of the plan you need. Read other files only as your work needs them." The extracted text never passes through the main session.
- **Without memory** (no memory folder): the sections are put into the prompt itself instead.
- **Large-read guard** (setting `largeReadKB`, default 40; 0 is off). When an orchestrator agent task reads a file larger than the limit with no `offset`/`limit`, the read is refused: "This file is N KB: read the part you need with offset and limit, or search it first." Briefs are exempt. This applies only to agents the orchestrator launched, never to the main session.

### 4.3 Item 7: shared context written once (`dispatch_batch`)

- **The tool:** `dispatch_batch { shared, tasks: [{ project, title, prompt, reads?, model?, effort?, backend?, why? }] }`.
- **Where the shared text goes:** into one brief file, `briefs/batch-<id>.md`. Each task's own brief (item 4) starts by naming it. So the main session writes the shared text once, and each agent reads one short brief.
- **Launch:** each task's prompt is the brief line plus its own `prompt`, so launch requests stay short even in full mode.
