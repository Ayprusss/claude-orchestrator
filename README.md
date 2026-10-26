# Claude Orchestrator

A mod for Claude Code that adds an **orchestrator dashboard**: a pane for queueing and running many Claude Code sessions in parallel, across different projects and tasks. It also gives the main session tools to dispatch work itself. Full docs are built into the pane (the **Docs** tab).

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install orchestrator --marketplace Ayprusss/claude-orchestrator
```

From a shell:

```
claude plugin install orchestrator --marketplace Ayprusss/claude-orchestrator
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `Ayprusss/claude-orchestrator`, then Add plugin.

The repository is private: you need read access on GitHub and a git credential for github.com on your machine (an SSH key, or `gh auth login` then `gh auth setup-git`).

## Use

Run `/orchestrator` to open the pane.

- **Projects**: register each project once (a name and an absolute folder path).
- **New**: pick a project, backend, and prompt, then Queue. Batch mode makes one task per line.
- **Sessions**: watch tasks queue, run, and finish; read output, kill, retry, or open an agent's transcript.
- **Memory**: what the orchestrator remembers per project (knowledge, new facts, past tasks) and this session's ledger; delete, consolidate or clear it.
- **Settings**: max parallel sessions (up to 16), usage-limit standby, the `claude` binary, flags for headless runs, and the memory settings.
- **Docs**: the full guide.

### HUD

Run `/orchestrator-hud` (or press **HUD** in the pane) to open a browser dashboard: an animated orb you can talk to, by text or voice, with running tasks orbiting it, a live task list, and the main conversation streamed in. It needs Node.js 18+ on PATH. It runs on `127.0.0.1` only, and each request needs a per-install token. `/orchestrator-hud stop` shuts it down. The **HUD** page of the Docs tab has details.

### Code changes

The HUD shows each edit as a diff. A small window pops up beside the agent that made it, linked to it by a line, and Comms lists every change. Drag a window's edges or corner to resize it, and its title to move it. Close it with ✕, or turn pop-ups off in Settings. Edits by `process` tasks are not shown.

### All-done ping

When the main session and every task have finished, the orchestrator plays a chime (`assets/ping.wav`) on your machine, even with the HUD closed. Turn it off in Settings.

### Usage limits

By default, when your plan's 5-hour or weekly limit is reached, the orchestrator goes on standby: queued tasks wait, tasks cut off by the limit go back in the queue, and everything resumes by itself when the limit resets. Turn it off in Settings. The HUD turns red and dims while it waits.

Two backends: **agent** (a subagent of the current session) and **process** (a separate headless `claude -p` run, which needs the `claude` CLI on the machine running the session). The main session also gets `dispatch`, `status` and `projects` tools, so you can ask it to delegate work.

### Auto mode

Agent tasks work in auto mode. When an agent task is ready to start, the orchestrator asks the main session to launch it with its own Agent tool, so auto mode judges the launch against your request. (Auto mode refuses agents that plugin code starts by itself.) Tasks that are ready together are launched in one turn. To have the plugin start agents directly instead, set **Start agent tasks** to *from the plugin* in Settings; that does not work in auto mode.

### Memory

The orchestrator keeps a memory, so its work survives compaction, `/clear`, reloads and new sessions:

- A **ledger** per session (your goals, decisions, and every task with why it exists and its summary), shown to the main session in its system prompt.
- Per **project**: a summary of every finished task, the facts those summaries found, and a curated `knowledge.md`. Each new task in the project starts with a short brief from it, marked as reference material.
- Tools for the main session: `note`, `memory_search`, `memory_read`, `remember` and `forget`.

It is stored in its own folder, `~/.claude/orchestrator-memory/` by default, never in your projects or in Claude Code's own memory. Secrets are scrubbed before anything is written. Summaries use a small model (`haiku` by default), one call per finished task.

Settings: **Memory** (on/off), **Memory folder**, **Task summaries** (short, detailed or off), **Summary model**, **Task transcripts** (kept or not) and **Brief for new tasks** (a cap in characters).

The pane's **Memory** tab shows everything that is stored: knowledge, inbox, past tasks and the ledger. Delete a fact there, press **Consolidate** to merge new facts into `knowledge.md`, or **Clear project memory** (twice, to confirm) to delete a project's memory. Turning memory off stops all reads and writes but keeps what is on disk; delete the folder to remove it all. The **Memory** page of the Docs tab has details.

## Notes

- Headless process tasks cannot answer permission prompts. They run with `--permission-mode acceptEdits` by default; change it in Settings only if you trust the task.
- Parallel tasks should not edit the same files in one folder; use a git worktree per task.
- The mobile surface has no text inputs, so the forms need the terminal or desktop surface.
