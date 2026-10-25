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
- **Settings**: max parallel sessions, the `claude` binary, and flags for headless runs.
- **Docs**: the full guide.

### HUD

Run `/orchestrator-hud` (or press **HUD** in the pane) to open a browser dashboard: an animated orb you can talk to, by text or voice, with running tasks orbiting it, a live task list, and the main conversation streamed in. It needs Node.js 18+ on PATH. It runs on `127.0.0.1` only, and each request needs a per-install token. `/orchestrator-hud stop` shuts it down. The **HUD** page of the Docs tab has details.

Two backends: **agent** (a subagent of the current session) and **process** (a separate headless `claude -p` run, which needs the `claude` CLI on the machine running the session). The main session also gets `dispatch`, `status` and `projects` tools, so you can ask it to delegate work.

## Notes

- Headless process tasks cannot answer permission prompts. They run with `--permission-mode acceptEdits` by default; change it in Settings only if you trust the task.
- Parallel tasks should not edit the same files in one folder; use a git worktree per task.
- The mobile surface has no text inputs, so the forms need the terminal or desktop surface.
