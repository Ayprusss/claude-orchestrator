# Token Savings Plan

How to make the orchestrator use fewer tokens per session, both in the main session's context and in the agents it runs, which share the account's usage limits. Branch: `token-savings`.

Status: items **1, 2, 3 and 6 are built** (§3). Items 4, 5 and 7 are planned.

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
| 7 | **Prompts ordered for the cache.** Fan-out prompts start with the shared part (rules, context, reading list) and end with the unit's own part. Agents launched together then reuse the cached prefix, which costs much less than fresh input | Cache reads on every agent but the first | None (how prompts are written) | Planned: template below |

Also small:
- `status` with an id returns up to 2,000 characters of output; the summary alone is often enough.
- The ledger snapshot cap (6,000 characters) could drop to ~3,000.

### Template for item 7 (fan-out prompts)

```
[shared, identical for every unit, first]
Context: <one paragraph>. Rules: <worktree, files you own, tests to run, how to commit>.
Read only: <files/sections>. Coordination: <board path>.
[unit-specific, last]
You are unit X. Build: <contract>. Report: <what to include>.
```

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
