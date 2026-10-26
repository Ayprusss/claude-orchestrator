# HUD Controls Plan

Four features that let the person run the orchestrator from the HUD without switching to the terminal. Branch: `hud-controls` (from `memory-harness`). Planned by the main session (Opus); built by four Sonnet agents in parallel; wired and merged by the main session.

## 1. The features and what the API allows

| # | Feature | Verdict | How |
|---|---|---|---|
| 1 | Pick the **orchestrator's** model and effort in the HUD | Model: yes. Effort: if this build has an `/effort` command | `$.command.run({ command: 'model', args })` runs `/model <alias>` as typed. Effort: look for an `effort` command in `$.command.list()`; if none, the control shows disabled with the reason |
| 2 | A button to pick each **task's** model and effort | Yes, mostly | Agent tasks the main session launches: the Agent tool takes `model` and `effort`, so the launch request names both. Process tasks: `claude -p --model <m> --effort <e>`. Plugin-launched agents (`agentLaunch: 'plugin'`): model only, since `$.agent.spawn` has no effort |
| 3 | **Shift+Tab** cycles Auto / Planning / Manual / Accept Edits from the HUD | Partly: the API cannot set the current mode on demand | Person's choice: the HUD **shows** the current mode, and **permission prompts appear in the HUD** with Allow / *Allow and switch to <mode>* / Deny. Shift+Tab in the HUD picks the mode to switch to; it is applied with the next prompt answered there |
| 4 | A **resumed** conversation shows its history in the HUD | Yes | `$.session.messages()` returns the conversation's rows; the plugin turns them into HUD messages and pushes one `history` event |

### Facts checked in the API (Claude Code 2.1.310 types)

- `$.command.run({ command, args? })` runs a slash command as if typed; `$.command.list()` lists what can run now.
- `$.config.list()` / `$.config.set({ key, value })` change `/config` rows; the keys are only known at run time.
- There is **no** call that sets the session's permission mode. A mode change only rides on a `classic.PermissionRequest` answer: `{ decision: { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] } }`.
- Every classic hook input carries `permission_mode` (BaseHookInput), so the current mode can be read at each tool call or prompt.
- A hook's own time is capped at **10 s**, but time inside any `$` call does not count. A hook can wait minutes for the person by awaiting `$.http.fetch` to the HUD server.
- In **auto mode** the classifier settles most calls without a prompt, so a switch the person picked in the HUD may wait until the next prompt comes. The HUD says so.
- `AgentSpawnInput` has `model` but no `effort`; the Agent **tool** input has both.
- The CLI has `--effort <level>`, `--model <model>` and `--permission-mode <mode>`.
- `session.start`'s input has `isInteractive`; it does not say whether the session was resumed. A resumed session has rows in `$.session.messages()` at start.

### Decisions (from the person)

- Mode switching: show the mode, answer prompts in the HUD, Shift+Tab picks the next mode.
- Model lists: aliases plus Default (`''`, `opus`, `sonnet`, `haiku`, `fable`). Effort levels: `low`, `medium`, `high`, `xhigh`, `max`, plus Default (`''`).

## 2. What already exists (the scaffold, committed before the agents start)

**HUD modules.** `web/index.html` loads `web/hud/session.js`, `web/hud/tasks.js` and `web/hud/permissions.js` (served by `web/server.mjs` from `web/hud/`, by plain name, with the token). A module is a plain browser script that talks to the HUD only through `window.HUD`:

```js
HUD.command(cmd)            // POST /api/command; resolves true when accepted
HUD.state()                 // the live state S: tasks, projects, plus snapshot fields
HUD.on(type, fn)            // fn(event) for every SSE event of `type` ('*' = all), after the HUD's own handling
HUD.onDrawer(fn)            // fn(task, slotEl) whenever the task drawer draws; the slot is emptied first
HUD.setDispatchExtras(obj)  // fields merged into every dispatch command (e.g. { model, effort })
HUD.slot(name)              // mount points: 'header', 'dispatch', 'drawer', 'settings', 'overlay'
HUD.toast(text, level)      // level: undefined | 'error'
HUD.esc(text)               // HTML-escape
HUD.token                   // the session token (for module-owned fetches to the HUD server)
```

`snapshot` events carry the whole state; a module reads its fields with `HUD.on('snapshot', s => …)` and on the initial `hello` event (`HUD.on('hello', m => m.snapshot …)`).

**Server.** `web/server.mjs` accepts the new commands (`session-model`, `session-effort`, `task-config`, `history-load`) and keeps a `history` event as the new message history.

**Types.** `hooks/hud.ts` `HudCommand` has the new commands and `dispatch.effort`. `OrchTask.effort?: string`. `OrchSettings` has `isHudPermissionsOn` (default true) and `hudPermissionWaitSec` (default 60). Shape tags: settings `orch-settings-7`, tasks `orch-tasks-4`.

## 3. Snapshot fields the wiring adds (agents code against these)

```ts
// in every 'snapshot' event (hudSnapshot in register.tsx), added at wiring:
session: {
  model: string          // the main session's model id now ($.session.model())
  effort: string         // its effort level, '' when unknown
  canSetEffort: boolean  // whether setSessionEffort can work in this build
  mode: string           // the current permission mode: 'auto' | 'plan' | 'default' | 'acceptEdits' | ...
}
choices: {
  models: { id: string; label: string }[]   // MODEL_CHOICES
  efforts: string[]                          // EFFORT_LEVELS (without '')
}
tasks: [{ ...existing fields, effort: string }]
settings fields: isHudPermissionsOn: boolean, hudPermissionWaitSec: number
```

## 4. Units

Every unit: work only in its worktree, edit only the files it owns, write tests (`*.test.ts` with `claude-code/testing`), run `claude plugin validate .` and `claude plugin test .`, type-check with `node C:/Users/AnthonyPC/AppData/Roaming/npm/node_modules/vercel/node_modules/typescript/lib/tsc.js -p . --noEmit` (copy `.claude-plugin/types` from the main repo if the worktree lacks it, and do not commit it), and commit to its branch. Do **not** edit `hooks/register.tsx`, `web/index.html`, `hooks/hud.ts`, `types/index.d.ts` or `hooks/memory/*`: the main session wires everything. Hooks-module code (`hooks/**`) has no Node and no DOM, no `require`, no dynamic `import()`; it may pass `$` only to functions it names directly (named imports, never `ns.fn($)`), and may write a state atom only in the file that defines it. Browser modules (`web/hud/*.js`) are plain scripts with no build step and no imports: wrap in an IIFE, use only `window.HUD` and the DOM, and style with a `<style>` element of their own using the HUD's existing CSS variables (`--amber`, `--green`, `--red`, `--slate`, `--muted`, and the cyan `#5ce1ff`).

### Unit S: orchestrator model and effort

Owns `hooks/controls/session.ts` (+ `session.test.ts`) and `web/hud/session.js`.

```ts
export type Choice = { id: string; label: string }
export const MODEL_CHOICES: readonly Choice[]   // [{ id: '', label: 'Default' }, opus, sonnet, haiku, fable]
export const EFFORT_LEVELS: readonly string[]   // ['low', 'medium', 'high', 'xhigh', 'max']
export type SessionInfo = { model: string; effort: string; canSetEffort: boolean }
export async function sessionInfo($: E): Promise<SessionInfo>
/** '' = back to the default model. Runs /model through $.command.run. */
export async function setSessionModel($: E, model: string): Promise<{ ok: boolean; text: string }>
/** Runs the effort command when this build has one; otherwise { ok: false, text: why }. */
export async function setSessionEffort($: E, effort: string): Promise<{ ok: boolean; text: string }>
```

- Validate input against the lists; never pass free text to a command.
- Find out from the types (`.claude-plugin/types/claude-code/index.d.ts`) how to read the current effort (a config row, a settings key such as `effortLevel`, or nothing), and how `/model` reports success. Cache the `$.command.list()` lookup.
- `session.js`: in the `header` slot, a compact **MODEL** select and **EFFORT** select showing `snapshot.session`; a change sends `session-model` / `session-effort` and shows a toast. When `canSetEffort` is false, the effort select is disabled with a tooltip saying why.

### Unit T: each task's model and effort

Owns `hooks/launch.ts` (+ `launch.test.ts`), `hooks/controls/tasks.ts` (+ `tasks.test.ts`) and `web/hud/tasks.js`.

```ts
// hooks/controls/tasks.ts
export function normalizeEffort(x: unknown): string   // '' or one of EFFORT_LEVELS (copy the list; do not import unit S)
export function normalizeModel(x: unknown): string    // trimmed, '' allowed, aliases or a model id ([A-Za-z0-9._:\-\[\]], ≤ 80)
/** Flags for a process task: ['--model', m] and/or ['--effort', e]; none for ''. */
export function processModelArgs(model: string, effort: string): string[]
/** Only queued tasks can change model or effort. */
export function canConfigure(task: { status: string }): boolean
```

- `launch.ts`: `LaunchSpec` gains `effort: string`; the request gives `- effort: <level>` (left out when '') and tells the session to pass it as the Agent tool's `effort`. Keep every existing line and test.
- `tasks.js`:
  - In the `dispatch` slot, a **⚙ MODEL/EFFORT** button opening a small popover with a model select (from `snapshot.choices.models`) and an effort select (Default + `choices.efforts`). The choice persists in `localStorage` and is sent with every dispatch through `HUD.setDispatchExtras({ model, effort })`. Hide the free-text `#dModel` input (the select replaces it) by adding a style rule, not by editing `index.html`.
  - In the `drawer` slot: the task's model and effort, and, for a **queued** task, selects plus **Save**, which sends `task-config`.
  - A label next to the button shows the current choice (e.g. `SONNET · HIGH`).

### Unit P: permission prompts and mode in the HUD

Owns `hooks/controls/permissions.ts` (+ `permissions.test.ts`), the permission routes in `web/server.mjs`, and `web/hud/permissions.js`.

```ts
export const MODE_CYCLE = ['auto', 'plan', 'default', 'acceptEdits'] as const
export const MODE_LABEL: Record<string, string>   // auto: 'Auto Mode', plan: 'Planning Mode', default: 'Manual Mode', acceptEdits: 'Accept Edits On', plus bypassPermissions, dontAsk
/** Remembers the mode a classic hook input reports; true when it changed. */
export function noteMode(input: { permission_mode?: unknown }): boolean
export function currentMode(): string             // '' until seen
export type HudAnswer = { behavior: 'allow' | 'deny'; mode?: string; message?: string }
/** A one-line, secret-free summary of a tool call for the prompt card. */
export function summarizeCall(tool: string, input: unknown): string
/**
 * Puts a permission prompt to the HUD and waits (inside $.http.fetch, so the
 * hook's 10 s budget does not run) for the person's answer. undefined when no
 * HUD tab is open, on timeout, or on any error: the terminal prompt then shows.
 */
export async function askInHud($: E, opts: {
  baseUrl: string; token: string; waitMs: number
  request: { id: string; tool: string; summary: string; mode: string }
}): Promise<HudAnswer | undefined>
/** The classic.PermissionRequest answer for a HUD answer (setMode on 'session' when a mode is chosen). */
export function toDecision(a: HudAnswer): unknown
```

- **Server** (`web/server.mjs`, only new routes plus what they need):
  - `POST /api/permission` (header token, from the plugin): if no SSE client is connected, answer `{ answer: null, reason: 'no-hud' }` at once. Otherwise broadcast `{ type: 'permission', id, tool, summary, mode, until }` and hold the response until the browser answers or `waitMs` passes. Then answer `{ answer }` or `{ answer: null, reason: 'timeout' }` and broadcast `{ type: 'permission-closed', id }`.
  - `POST /api/permission/answer` (header token, from the browser): `{ id, behavior, mode? }`.
  - Keep pending prompts in the hello event, so a refreshed tab sees them.
- **`permissions.js`:**
  - In the `header` slot, a mode badge (`MODE_LABEL` of `snapshot.session.mode`) and, when picked, a **next: <mode>** chip.
  - **Shift+Tab** anywhere in the HUD (preventDefault) cycles the next mode through `MODE_CYCLE`, and Esc clears it. The pick persists in `localStorage`. A small note says it applies at the next permission prompt (in auto mode, prompts are rare).
  - Each `permission` event shows a card in the `overlay` slot: tool, summary, countdown, and buttons **Allow**, **Allow and switch to <next>** (only when a next mode is picked), **Deny**. Keys 1, 2 and 3 press them.
  - In the `settings` slot, a section with an on/off switch for `isHudPermissionsOn` and a wait-time stepper (`hudPermissionWaitSec`, 15–300), sent as a `settings` command.
- Read the types for the exact `classic.PermissionRequest` input and answer and for `$.http.fetch` (method, headers, body, timeout). Note which classic events carry `permission_mode`, so the wiring knows where to call `noteMode`.

### Unit H: resumed history

Owns `hooks/controls/history.ts` (+ `history.test.ts`).

```ts
export type HudMsg = { type: 'msg'; role: 'user' | 'assistant' | 'system'; text: string; at: number; source: 'history' }
/** Pure: the conversation's rows as HUD messages, oldest first, at most `cap`. */
export function rowsToMessages(rows: readonly unknown[], cap?: number): HudMsg[]
/** Reads $.session.messages() and converts; [] on any error. */
export async function historyMessages($: E, cap?: number): Promise<HudMsg[]>
/** Whether the session looks resumed: it already has user or assistant rows. */
export async function isResumed($: E): Promise<boolean>
```

- Read `SessionMessage` in the types.
  - Keep the person's prompts and the model's text replies.
  - Show `[orchestrator]` plugin prompts as `system`.
  - Leave out tool calls and results, meta and injected rows, thinking, and empty rows.
  - Clip each text to 4,000 characters, and use each row's own time for `at`.
- Match what the HUD already draws: read how `register.tsx` builds `msg` events (roles and `source` values) and do the same.

## 5. Wiring (main session, after the merge)

- `register.tsx`:
  - **Snapshot and choices:** add the `session` and `choices` snapshot fields, plus `effort` on tasks.
  - **HUD commands:** handle `session-model`, `session-effort`, `task-config` and `history-load`.
  - **Dispatch:** `dispatch` (tool and HUD) takes `effort`.
  - **Launch effort:** the launch request and process argv carry effort.
  - **Permission hooks:** `classic.PermissionRequest` → `askInHud` → `toDecision`, when `isHudPermissionsOn` and the HUD is up. Call `noteMode` on the classic events that carry the mode.
  - **History:** push `history` when the HUD starts, on `history-load`, and at `session.start` when resumed.
- Docs: the HUD page in `hooks/docs.ts`, the README, and this plan's status.
- Live checks:
  - `/model` from the HUD switches the session.
  - Effort works, or is disabled with a reason.
  - A queued task's model and effort apply.
  - A prompt answered in the HUD runs, and the mode switch applies.
  - The terminal prompt still shows when no HUD tab is open.
  - `claude --resume` fills Comms.

## 6. Build status

Built by four Sonnet agents in parallel (units S, T, P, H), then merged and wired by the main session. 174 tests pass, the project type-checks, `claude plugin validate` passes, and every browser script parses.

**Smoke test in a real browser** (a throwaway HUD server fed a sample snapshot; Playwright):
- All three modules loaded with no console errors.
- The header showed the MODEL and EFFORT pickers (effort disabled, with its reason), plus the mode badge.
- Shift+Tab cycled the next mode, and Esc cleared it.
- The ⚙ popover opened from the Dispatch row.
- A queued task's drawer offered model and effort with SAVE.
- A permission prompt posted to the server showed as a card. Pressing **2** returned `{ behavior: 'allow', mode: 'plan' }` to the waiting request.
- The pushed history filled Comms.
- Fixed during the smoke test: the header controls wrapped onto a second line, and history rows were labelled "TERMINAL" (now "EARLIER").

**Differences from the plan:**
- Mode and effort are read on `classic.UserPromptSubmit`, `classic.Stop` and `classic.PermissionRequest`. Under this API, `classic.PreToolUse` receives the tool call, not the classic input.
- The types show no `/effort` command. Setting effort is tried at run time: the `effort` command, then a config row; otherwise the picker is disabled with its reason.
- `SessionMessage` has no timestamp or meta flag. History rows have `at: 0`, and injected rows are recognized by their text.
- A refused HUD command comes back as an error toast, since `HUD.command` only confirms the server accepted it.

**Still to verify live:**
- [ ] `/model <alias>` from the HUD switches the main session.
- [ ] Whether effort can be set in this build.
- [ ] A queued task's model and effort reach its Agent call or `claude -p`.
- [ ] A prompt answered in the HUD runs, and **Allow and switch** changes the mode.
- [ ] With no HUD tab open, the terminal prompt shows at once.
- [ ] `claude --resume` fills Comms.
