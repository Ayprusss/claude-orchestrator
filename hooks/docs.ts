const F = '```'

export type DocPage = { id: string; title: string; body: string }

export const DOCS: DocPage[] = [
  {
    id: 'start',
    title: 'Quick start',
    body: `# Orchestrator: quick start

The orchestrator runs **many Claude Code sessions at once**, across different projects and tasks, and shows them in one pane.

1. **Projects** tab: add each project once (a name and an absolute folder path).
2. **New** tab: pick a project, write a task prompt, press **Queue**.
3. **Sessions** tab: watch tasks go queued, running, done. Select a row to read its output; kill or retry it.

Open the pane any time with ${'`/orchestrator`'}.

## Status glyphs

| Glyph | Meaning |
| --- | --- |
| ${'`.`'} | queued, waiting for a free slot |
| ${'`>`'} | running |
| ${'`+`'} | done |
| ${'`x`'} | failed |
| ${'`-`'} | killed |

## Parallel limit

Only **Max parallel** tasks run at once (Settings tab, default 3). Extra tasks wait in the queue and start by themselves as slots free up.`,
  },
  {
    id: 'backends',
    title: 'Backends',
    body: `# Two ways to run a session

Each task picks a **backend** when you create it.

## agent (in-session subagent)

Runs as a subagent of **this** session, started in the project's folder.

- Fast to start, no extra process, shares this session's login and permissions.
- Its final answer is stored as the task output.
- **Open** jumps the main view to its transcript so you can watch or steer it.
- You can choose the agent type: ${'`general-purpose`'}, ${'`Explore`'} (read-only search), ${'`Plan`'} (design only).

## process (separate headless ${'`claude -p`'})

Starts an independent ${'`claude`'} process in the project's folder and streams its output into the task.

- Fully separate session: its own context window, its own working directory.
- Best for long jobs on different projects.
- Needs the ${'`claude`'} CLI on the machine that runs this session (see Settings: **Claude binary**).
- Extra flags come from Settings: **Process args**. The default is ${'`--permission-mode acceptEdits`'}, so file edits are auto-approved but other tools are not. A headless run cannot answer permission prompts, so widen this only if you trust the task.

## Choosing

| Need | Use |
| --- | --- |
| Quick research or review in one repo | agent |
| Long refactor in another repo | process |
| Watch and steer the transcript | agent (Open) |
| Hard isolation between jobs | process |`,
  },
  {
    id: 'new',
    title: 'Creating tasks',
    body: `# The New tab

| Field | Meaning |
| --- | --- |
| Title | Short label shown in the Sessions list |
| Project | Where the session runs (its working directory) |
| Backend | agent or process |
| Model | Optional alias such as ${'`haiku`'}, ${'`sonnet`'}, ${'`opus`'}. Empty uses the default |
| Agent type | agent backend only |
| Prompt | What the session should do. Be specific: say what "done" looks like |

## Batch mode

Switch **Mode** to *batch* and put **one task per line** in the prompt box. Each line becomes its own queued task with the same project, backend and model. This is the fastest way to fan one project out into many parallel jobs, for example:

${F}
Add unit tests for src/auth
Add unit tests for src/billing
Add unit tests for src/search
${F}

## Tips

- Give parallel tasks **non-overlapping files**. Two sessions editing the same file in one folder will collide.
- For the same repo, consider a git worktree per task and register each worktree as its own project.`,
  },
  {
    id: 'model',
    title: 'Let Claude orchestrate',
    body: `# The main session as orchestrator

The mod gives the main Claude session three tools, so you can simply **ask it** to delegate:

| Tool | What it does |
| --- | --- |
| ${'`mcp__orchestrator__dispatch`'} | Queue a task: project, title, prompt, optional backend and model |
| ${'`mcp__orchestrator__status`'} | Report every task, or one by id, with the tail of its output |
| ${'`mcp__orchestrator__projects`'} | List the registered projects |

When a task that the main session dispatched **finishes**, the session is woken with a short message naming the task, so it can read the result with ${'`status`'} and decide the next step.

## Example prompts

${F}
Dispatch one process task per project in my project list: run the test
suite, and report back which projects fail.
${F}

${F}
Split the migration across the api and web projects. Dispatch one task
for each, then wait for them and summarise.
${F}

A project path the tool has not seen is registered automatically if you pass an absolute path as the project.`,
  },
  {
    id: 'limits',
    title: 'Limits and troubleshooting',
    body: `# Limits and troubleshooting

## Things to know

- **Reloads.** Task records survive a reload, but a *process* task's live stream does not: after a reload any process task still marked running is marked **failed (interrupted)**. Retry it from the Sessions tab.
- **Output size.** Each task keeps only the last ~8,000 characters of output.
- **Permissions.** Headless process tasks cannot ask you for approval. Whatever the process args allow is what they can do.
- **Mobile.** The mobile surface has no text inputs, so the New, Projects and Settings forms need the terminal or desktop surface.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Process task fails at once | The Claude binary is not on the PATH of this machine. Set its full path in Settings |
| Task stays queued | Max parallel is reached, or no project is selected |
| agent task never finishes | Open it and check whether it is waiting on a question |
| Kill does nothing for an agent task | The agent already finished, or the stop request was refused; the task is still marked killed |
| Edits collide | Two tasks share files in one folder. Use separate worktrees |

## Where state lives

Projects and settings are kept across sessions. The task list lives with the current session.`,
  },
]
