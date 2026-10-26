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

Only **Max parallel** tasks run at once (Settings tab or the HUD's settings, default 3, up to 16). Extra tasks wait in the queue and start by themselves as slots free up.

## Usage limit standby

When your plan's usage limit is reached (the 5-hour or the weekly window), the orchestrator goes on **standby**, which is on by default:

- Queued tasks wait instead of launching.
- A task cut off by the limit goes back in the queue instead of failing. When it runs again, it is told to check for partial work.
- When the limit resets, everything resumes by itself. If the reset time is unknown, the orchestrator checks every few minutes with a one-token request.

Turn it off in Settings (**When the usage limit is reached**: keep going) to have tasks launch and fail as before. **Resume now** (Sessions tab, or the HUD) lifts standby by hand.`,
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

### How an agent task starts

By default (Settings: **Start agent tasks** = *from the main session*), the orchestrator does not start the agent itself. When a task's turn comes, it sends the main session one ${'`[orchestrator]`'} message listing every task that is ready, and the session launches each with its own **Agent** tool. The orchestrator then runs the agent in the project's folder, in the background, and tracks it as usual.

This is what makes agent tasks work in **auto mode**: auto mode judges each action against what you asked for, and a launch made from plugin code has no request behind it, so auto mode refuses it. A launch made by the session's own Agent tool, with the task's prompt in full, is judged like any other.

- The task shows as *running: waiting for the main session to launch it* until the launch comes.
- If no launch comes, the orchestrator asks again every 3 minutes while the session is idle, and fails the task after 3 requests.
- A refused launch (you said no, or auto mode blocked it) fails the task with the reason.
- *from the plugin* starts agents directly, as before. It skips the extra step but does not work in auto mode.

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

When an **agent** task is ready to start, the session gets an ${'`[orchestrator]`'} message asking it to launch the task with its Agent tool (see **Backends**). Tasks that become ready together are asked for in one message, so the session launches them in one turn.

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
| Everything is on standby | The usage limit was reached. It resumes at the reset, or press **Resume now** |
| Agent task fails at once with "auto mode classifier gave no verdict" | Settings: **Start agent tasks** is *from the plugin*, which auto mode refuses. Set it to *from the main session* |
| Agent task stuck "waiting for the main session to launch it" | The session is busy, or did not act on the launch message. It is asked again every 3 minutes while idle, and the task fails after 3 requests |
| Agent task fails with "The launch was refused" | You declined the Agent call, or auto mode blocked it. The reason follows in the output |

## Where state lives

Projects and settings are kept across sessions. The task list lives with the current session.`,
  },
  {
    id: 'hud',
    title: 'HUD',
    body: `# The HUD

A visual dashboard for the orchestrator in your browser: an animated orb you talk to, with every task orbiting it.

Open it with ${'`/orchestrator-hud`'}, or the **HUD** button at the end of this pane's tab row. Stop it with ${'`/orchestrator-hud stop`'}.

## What it shows

- **The orb** shows what the main session is doing: cyan while standing by, blue while it thinks, amber while it runs a tool, and it ripples while a reply streams in.
- **Moons**: each running task orbits the inner ring and each queued task the outer one. A beam marks a launch, and a burst marks a finish (green for done, red for failed). Click a moon to open the task.
- **Operations** (left): every task, with live timers. Click one for its prompt, output, and Kill, Retry or Remove.
- **Comms** (right): the main conversation, mirrored. It includes what you type in the terminal, and replies stream in as they are written.

## Talking to it

- **TALK** sends your text to this Claude Code session as a prompt, the same as typing it here. The session can then dispatch tasks itself. HUD prompts tell Claude to keep its replies short, since they may be read aloud.
- **DISPATCH** queues a task directly, in the project you pick, with no conversation.
- **Mic** (Chrome or Edge): speak, and the text is sent when you stop.
- **Speaker** (top right): reads replies and task completions aloud.
- **Gear** (top right): settings for the number of parallel agents, usage-limit standby and code-change pop-ups, plus your account's 5-hour and weekly usage.

## Code changes

Every edit the main session or an agent task makes shows up as a code diff:

- **Pop-up window** (on by default): a small diff window opens beside the agent that made the change, on its side of the orb. An animated line runs from the window to that agent's moon, or to the orb's core for the main session. A newer change from the same agent replaces the window's contents, and **‹ ›** pages back through earlier changes.
- **Resize** a window by dragging its edges or corner, and **move** it by dragging its title. New windows open at the last size you set. Double-click the corner, or use **Reset window size** in Settings, to go back to the default.
- **✕** closes the window until that agent's next change. **MUTE** stops pop-ups from that agent for the rest of the page's life. **Esc** closes them all. A finished task's window closes by itself after 20 seconds unless the pointer is on it.
- **Comms** lists every change, with **VIEW** to reopen it. A task's details list its own changes, and its row in Operations shows a ✎ count.
- Turn pop-ups off in Settings (**Pop up code changes**), and changes are only listed.

## The all-done ping

When the main session and every task are done (nothing running, nothing queued), the orchestrator plays a chime and the HUD flashes **ALL OPERATIONS COMPLETE**. It waits 3 seconds first, because a finished task wakes the main session to read the result. A quick reply under 15 seconds with no tasks stays quiet. Tasks held back by a usage limit count as not done.

The chime plays on the machine running Claude Code, even with the HUD closed: through PowerShell on Windows, \`afplay\` on macOS, and \`paplay\` or \`aplay\` on Linux. Turn it off in Settings (**Ping when all work is done**), and use **Test ping** to hear it.

Changes made by *process* tasks (separate \`claude -p\` runs) are not shown, since their edits happen outside this session.

## When tokens run out

When the usage limit is reached, the HUD powers down: the background turns red, the orb dims and sputters, and a banner counts down to the reset. Tasks waiting for it are marked **standby**. When the limit lifts, the orb powers back up. The header meters (5H, 7D) turn amber at 80% and red at 100%.

A prompt sent while the session is busy waits (shown dimmed) until the session is idle.

## How it works

The mod starts a small local server (${'`web/server.mjs`'}, Node 18+, no packages) on ${'`127.0.0.1:4747`'}, or the next free port. Every request needs a random token that is kept in the mod's store and included in the link, and the server only answers on 127.0.0.1. It exits on its own if the session goes away. A reload restarts the server, and an open tab reconnects by itself.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "HUD server exited" | Node.js is not installed or not on PATH |
| The browser does not open | Open the link that ${'`/orchestrator-hud`'} prints |
| LINK LOST | The session ended or reloaded; it reconnects when the server is back |
| No mic button | The browser has no speech recognition: use Chrome or Edge |`,
  },
]
