// The pane: the `ui.render` body as a function.

import type { EngineInterface } from 'claude-code'

import type {
  OrchDraft as Draft,
  OrchProject as Project,
  OrchSettings as Settings,
  OrchTab as Tab,
  OrchStatus as TaskStatus,
} from '../../types'
import { DOCS } from '../docs'
import { MODEL_CHOICES, EFFORT_LEVELS } from '../controls/session'
import {
  consolidateNow as memConsolidateNow,
  clearProject as memClearProject,
  deleteFact as memDeleteFact,
  keepFact as memKeepFact,
  setMemoryView as memSetMemoryView,
  tabData as memTabData,
} from '../memory/harness'
import { memorySettingsRows, memoryTab } from '../memory/pane'
import { startHud } from './hud-bridge'
import { addTasks, applySettings, killTask, retryTask } from './queue'
import { resumeByHand } from './standby'
import {
  DEFAULT_SETTINGS,
  getDraft,
  getHudOn,
  getLimit,
  getProjects,
  getSettings,
  getTasks,
  getView,
  isLimitedNow,
  saveProjects,
  updateDraft,
  updateProjects,
  updateTasks,
  updateView,
} from './state'
import { clip, fmtDuration, isAbsPath, nameOf, uid } from './util'

type E = EngineInterface
type PaneEvent = Parameters<E['ui']['resolve']>[0] & {
  surface?: string
  viewport?: { rows?: number }
}

const GLYPH: Record<TaskStatus, string> = {
  queued: '.',
  running: '>',
  done: '+',
  failed: 'x',
  killed: '-',
}
const COLOR: Record<TaskStatus, string> = {
  queued: 'gray',
  running: 'yellow',
  done: 'green',
  failed: 'red',
  killed: 'gray',
}

export async function renderPane($: E, e: PaneEvent) {
  const { Box, Text, Button, Markdown } = $.ui.resolve(e)
  // Mobile has neither; `hasForms` keeps them out of its tree.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Input, Select } = $.ui.resolve(e) as unknown as { Input: any; Select: any }
  const hasForms = e.surface !== 'mobile'

  const [v, list, projs, cfg, d] = await Promise.all([
    getView($),
    getTasks($),
    getProjects($),
    getSettings($),
    getDraft($),
  ])
  const now = await $.clock.now()
  const isHudOn = await getHudOn($)
  const lim = await getLimit($)
  const room = Math.max(4, (e.viewport?.rows ?? 24) - 8)

  const setTab = (tab: Tab) => updateView($, x => ({ ...x, tab }))
  const setDraft = (patch: Partial<Draft>) =>
    updateDraft($, x => ({ ...x, ...patch }))
  const toast = (text: string) => void $.ui.toast(text)

  const tabs: Array<[Tab, string]> = [
    ['sessions', 'Sessions'],
    ['new', 'New'],
    ['projects', 'Projects'],
    ['memory', 'Memory'],
    ['settings', 'Settings'],
    ['docs', 'Docs'],
  ]

  const projectName = (id: string) =>
    projs.find(p => p.id === id)?.name ?? 'missing'

  // ---- Sessions -------------------------------------------------------
  const sessions = () => {
    const count = (s: TaskStatus) => list.filter(t => t.status === s).length
    const selected = list.find(t => t.id === v.selected)
    const rows = [...list].reverse().slice(0, Math.max(3, Math.floor(room / 2)))
    return (
      <Box flexDirection="column">
        {lim.isLimited && (
          <Box>
            <Text color="red" bold>
              USAGE LIMIT{' '}
            </Text>
            <Text color="red">
              {cfg.isStandbyOnLimit === false ? 'reached, standby off' : 'standby'}
              {lim.until ? `, resets in ${fmtDuration(lim.until - now)}` : ', checking every few minutes'}{' '}
            </Text>
            <Button key="resume" plain onPress={() => void resumeByHand($)}>
              [resume now]
            </Button>
          </Box>
        )}
        <Text>
          <Text color="yellow">{count('running')} running</Text>
          {'  '}
          <Text dimColor>{count('queued')} queued</Text>
          {'  '}
          <Text color="green">{count('done')} done</Text>
          {'  '}
          <Text color="red">{count('failed')} failed</Text>
          {'  '}
          <Text dimColor>limit {cfg.maxParallel}</Text>
        </Text>
        {list.length === 0 && (
          <Text dimColor>
            No sessions yet. Open New to queue a task, or ask Claude to dispatch some.
          </Text>
        )}
        {rows.map(t => (
          <Button
            key={`row-${t.id}`}
            plain
            onPress={() => updateView($, x => ({ ...x, selected: t.id }))}
          >
            {t.id === v.selected ? '> ' : '  '}
            <Text color={COLOR[t.status]}>{GLYPH[t.status]}</Text> {t.title}{' '}
            <Text dimColor>
              {projectName(t.projectId)} {t.backend}{' '}
              {t.startedAt ? fmtDuration((t.endedAt ?? now) - t.startedAt) : ''}
            </Text>
          </Button>
        ))}
        {selected && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>
              {selected.title} <Text dimColor>[{selected.status}] {selected.id}</Text>
            </Text>
            <Text dimColor>{clip(selected.prompt, 240)}</Text>
            <Text>
              {selected.output
                ? selected.output.split('\n').slice(-room).join('\n')
                : '(no output yet)'}
            </Text>
            <Box>
              {(selected.status === 'running' || selected.status === 'queued') && (
                <Button key="kill" onPress={() => void killTask($, selected.id)}>
                  Kill
                </Button>
              )}
              {selected.backend === 'agent' && selected.agentId && (
                <Button
                  key="open"
                  onPress={() => void $.ui.view({ agentId: selected.agentId })}
                >
                  Open
                </Button>
              )}
              {selected.status !== 'running' && selected.status !== 'queued' && (
                <Button
                  key="retry"
                  onPress={async () => {
                    await retryTask($, selected)
                  }}
                >
                  Retry
                </Button>
              )}
              {selected.status !== 'running' && (
                <Button
                  key="remove"
                  onPress={async () => {
                    await updateTasks($, l => l.filter(t => t.id !== selected.id))
                    await updateView($, x => ({ ...x, selected: '' }))
                  }}
                >
                  Remove
                </Button>
              )}
            </Box>
          </Box>
        )}
        {list.some(t => t.status !== 'running' && t.status !== 'queued') && (
          <Button
            key="clear"
            plain
            onPress={() =>
              updateTasks($, l =>
                l.filter(t => t.status === 'running' || t.status === 'queued'),
              )
            }
          >
            Clear finished
          </Button>
        )}
      </Box>
    )
  }

  // ---- New ------------------------------------------------------------
  const create = () => {
    if (!hasForms) return <Text dimColor>Forms need the terminal or desktop surface.</Text>
    if (projs.length === 0) {
      return (
        <Box flexDirection="column">
          <Text>Add a project first.</Text>
          <Button key="to-projects" onPress={() => setTab('projects')}>
            Go to Projects
          </Button>
        </Box>
      )
    }
    const projectId = d.projectId || projs[0]?.id || ''
    return (
      <Box flexDirection="column">
        <Select
          key="project"
          label="Project"
          value={projectId}
          options={projs.map(p => ({ value: p.id, label: `${p.name}  ${p.path}` }))}
          onSelect={(value: string) => setDraft({ projectId: value })}
        />
        <Select
          key="backend"
          label="Backend"
          value={d.backend}
          options={[
            { value: 'agent', label: 'agent (subagent of this session)' },
            { value: 'process', label: 'process (separate claude -p)' },
          ]}
          onSelect={(value: string) =>
            setDraft({ backend: value === 'process' ? 'process' : 'agent' })
          }
        />
        <Select
          key="mode"
          label="Mode"
          value={d.isBatch ? 'batch' : 'single'}
          options={[
            { value: 'single', label: 'single task' },
            { value: 'batch', label: 'batch (one task per line)' },
          ]}
          onSelect={(value: string) => setDraft({ isBatch: value === 'batch' })}
        />
        {!d.isBatch && (
          <Input
            key="title"
            label="Title"
            placeholder="short label"
            value={d.title}
            onInput={(value: string) => setDraft({ title: value })}
            onSubmit={(value: string) => setDraft({ title: value })}
          />
        )}
        <Input
          key="prompt"
          label={d.isBatch ? 'Prompts (one per line)' : 'Prompt'}
          placeholder="what should the session do?"
          rows={4}
          value={d.prompt}
          onInput={(value: string) => setDraft({ prompt: value })}
          onSubmit={(value: string) => setDraft({ prompt: value })}
        />
        <Input
          key="model"
          label="Model (optional, e.g. haiku, sonnet)"
          value={d.model}
          onInput={(value: string) => setDraft({ model: value })}
          onSubmit={(value: string) => setDraft({ model: value })}
        />
        {d.backend === 'agent' && (
          <Select
            key="agent-type"
            label="Agent type"
            value={d.agentType}
            options={[
              { value: 'general-purpose', label: 'general-purpose' },
              { value: 'Explore', label: 'Explore (read-only search)' },
              { value: 'Plan', label: 'Plan (design only)' },
            ]}
            onSelect={(value: string) => setDraft({ agentType: value })}
          />
        )}
        <Button
          key="queue"
          variant="primary"
          onPress={async () => {
            const lines = d.isBatch
              ? d.prompt.split('\n').map(s => s.trim()).filter(Boolean)
              : [d.prompt.trim()].filter(Boolean)
            if (lines.length === 0) return toast('Write a prompt first.')
            const ids = await addTasks(
              $,
              lines.map(prompt => ({
                projectId,
                title: d.isBatch ? prompt.slice(0, 40) : d.title.trim() || prompt.slice(0, 40),
                prompt,
                backend: d.backend,
                model: d.model.trim(),
                agentType: d.agentType,
                isNotify: false,
              })),
            )
            await updateDraft($, x => ({ ...x, title: '', prompt: '' }))
            await updateView($, x => ({ ...x, tab: 'sessions' as const, selected: ids[0] ?? '' }))
            toast(`Queued ${ids.length} task${ids.length === 1 ? '' : 's'}.`)
          }}
        >
          Queue
        </Button>
      </Box>
    )
  }

  // ---- Projects -------------------------------------------------------
  const projectsTab = () => (
    <Box flexDirection="column">
      {projs.length === 0 && <Text dimColor>No projects yet.</Text>}
      {projs.map(p => (
        <Box key={`proj-${p.id}`}>
          <Text>
            {p.name} <Text dimColor>{p.path}</Text>
          </Text>
          <Button
            key={`rm-${p.id}`}
            plain
            onPress={async () => {
              await updateProjects($, l => l.filter(x => x.id !== p.id))
              await saveProjects($)
            }}
          >
            {' '}
            remove
          </Button>
        </Box>
      ))}
      {hasForms ? (
        <Box flexDirection="column" marginTop={1}>
          <Input
            key="proj-name"
            label="Name"
            placeholder="api"
            value={d.projName}
            onInput={(value: string) => setDraft({ projName: value })}
            onSubmit={(value: string) => setDraft({ projName: value })}
          />
          <Input
            key="proj-path"
            label="Absolute folder path"
            placeholder="/home/me/code/api"
            value={d.projPath}
            onInput={(value: string) => setDraft({ projPath: value })}
            onSubmit={(value: string) => setDraft({ projPath: value })}
          />
          <Button
            key="proj-add"
            variant="primary"
            onPress={async () => {
              const path = d.projPath.trim()
              if (!isAbsPath(path)) return toast('Use an absolute path, like /home/me/api or C:\\code\\api.')
              try {
                await $.fs.stat(path)
              } catch {
                return toast(`Folder not found: ${path}`)
              }
              const made: Project = {
                id: uid(),
                name: d.projName.trim() || nameOf(path),
                path,
              }
              await updateProjects($, l => [...l, made])
              await saveProjects($)
              await setDraft({ projName: '', projPath: '' })
            }}
          >
            Add project
          </Button>
        </Box>
      ) : (
        <Text dimColor>Adding projects needs the terminal or desktop surface.</Text>
      )}
    </Box>
  )

  // ---- Settings -------------------------------------------------------
  const setSettings = (patch: Partial<Settings>) => applySettings($, patch)
  const settingsTab = () =>
    hasForms ? (
      <Box flexDirection="column">
        <Select
          key="max-parallel"
          label="Max parallel sessions"
          value={String(cfg.maxParallel)}
          options={[1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16].map(n => ({ value: String(n), label: String(n) }))}
          onSelect={(value: string) => void setSettings({ maxParallel: Number(value) })}
        />
        <Select
          key="agent-launch"
          label="Start agent tasks"
          value={cfg.agentLaunch === 'plugin' ? 'plugin' : 'session'}
          options={[
            { value: 'session', label: 'from the main session (works in auto mode)' },
            { value: 'plugin', label: 'from the plugin (not in auto mode)' },
          ]}
          onSelect={(value: string) => void setSettings({ agentLaunch: value === 'plugin' ? 'plugin' : 'session' })}
        />
        <Select
          key="default-task-model"
          label="Default task model"
          value={cfg.defaultTaskModel ?? ''}
          options={MODEL_CHOICES.map(c => ({ value: c.id, label: c.id ? c.label : "Claude Code's default" }))}
          onSelect={(value: string) => void setSettings({ defaultTaskModel: value })}
        />
        <Select
          key="default-task-effort"
          label="Default task effort"
          value={cfg.defaultTaskEffort ?? ''}
          options={[{ value: '', label: "Claude Code's default" }, ...EFFORT_LEVELS.map(x => ({ value: x, label: x }))]}
          onSelect={(value: string) => void setSettings({ defaultTaskEffort: value })}
        />
        <Select
          key="report-words"
          label="Task report length"
          value={String(cfg.reportWords ?? 150)}
          options={[
            { value: '100', label: 'at most 100 words' },
            { value: '150', label: 'at most 150 words' },
            { value: '300', label: 'at most 300 words' },
            { value: '0', label: 'no limit' },
          ]}
          onSelect={(value: string) => void setSettings({ reportWords: Number(value) })}
        />
        <Select
          key="throttle-at"
          label="Slow down near the usage limit"
          value={String(cfg.throttleAtPercent ?? 80)}
          options={[
            { value: '70', label: 'at 70% of a window' },
            { value: '80', label: 'at 80% of a window' },
            { value: '90', label: 'at 90% of a window' },
            { value: '0', label: 'off' },
          ]}
          onSelect={(value: string) => void setSettings({ throttleAtPercent: Number(value) })}
        />
        <Select
          key="throttled-parallel"
          label="Tasks at once when slowed"
          value={String(cfg.throttledParallel ?? 2)}
          options={[1, 2, 3, 4].map(n => ({ value: String(n), label: String(n) }))}
          onSelect={(value: string) => void setSettings({ throttledParallel: Number(value) })}
        />
        <Select
          key="large-read"
          label="Agents' whole-file reads"
          value={String(cfg.largeReadKB ?? 40)}
          options={[
            { value: '20', label: 'refuse over 20 KB' },
            { value: '40', label: 'refuse over 40 KB' },
            { value: '80', label: 'refuse over 80 KB' },
            { value: '0', label: 'allow any size' },
          ]}
          onSelect={(value: string) => void setSettings({ largeReadKB: Number(value) })}
        />
        <Select
          key="standby"
          label="When the usage limit is reached"
          value={cfg.isStandbyOnLimit === false ? 'off' : 'on'}
          options={[
            { value: 'on', label: 'standby: hold tasks until the limit resets' },
            { value: 'off', label: 'keep going: tasks fail' },
          ]}
          onSelect={(value: string) => void setSettings({ isStandbyOnLimit: value !== 'off' })}
        />
        <Select
          key="diff-view"
          label="HUD code changes"
          value={cfg.isDiffViewOn === false ? 'off' : 'on'}
          options={[
            { value: 'on', label: 'pop up each change beside its agent' },
            { value: 'off', label: 'list only (open from Comms)' },
          ]}
          onSelect={(value: string) => void setSettings({ isDiffViewOn: value !== 'off' })}
        />
        <Select
          key="ping"
          label="When all work is done"
          value={cfg.isPingOn === false ? 'off' : 'on'}
          options={[
            { value: 'on', label: 'ping' },
            { value: 'off', label: 'stay quiet' },
          ]}
          onSelect={(value: string) => void setSettings({ isPingOn: value !== 'off' })}
        />
        <Input
          key="claude-bin"
          label="Claude binary (process backend)"
          value={cfg.claudeBin}
          onInput={(value: string) => void setSettings({ claudeBin: value })}
          onSubmit={(value: string) => void setSettings({ claudeBin: value })}
        />
        <Input
          key="process-args"
          label="Process args (process backend)"
          value={cfg.processArgs}
          onInput={(value: string) => void setSettings({ processArgs: value })}
          onSubmit={(value: string) => void setSettings({ processArgs: value })}
        />
        {memorySettingsRows({ Box, Text, Button, Select, Input }, cfg, patch => void setSettings(patch))}
        <Button
          key="reset"
          plain
          onPress={() => void setSettings({ ...DEFAULT_SETTINGS })}
        >
          Reset defaults
        </Button>
      </Box>
    ) : (
      <Text dimColor>Settings need the terminal or desktop surface.</Text>
    )

  // ---- Docs -----------------------------------------------------------
  const page = DOCS.find(p => p.id === v.docPage) ?? DOCS[0]!
  // ---- Memory ---------------------------------------------------------
  const memData = v.tab === 'memory' ? await memTabData($, projs) : undefined
  const redraw = () => $.ui.invalidate('ui.render')
  const memoryTabView = () => {
    if (!memData) return null
    const projectOf = (key: string): Project | undefined => {
      const p = memData.projects.find(x => x.key === key)
      return p && p.path ? { id: '', name: p.name, path: p.path } : undefined
    }
    return memoryTab(
      { Box, Text, Button, Select, Input },
      memData,
      {
        setView: patch => void memSetMemoryView($, patch),
        deleteFact: (key, id) => void memDeleteFact($, key, id).then(redraw),
        keepFact: (key, id) => void memKeepFact($, key, id).then(text => (toast(text), redraw())),
        consolidate: key => {
          const project = projectOf(key)
          if (!project) return toast('This project has no folder on record to check facts against.')
          toast('Consolidating…')
          void memConsolidateNow($, key, project, cfg, isLimitedNow($)).then(r => {
            toast(r.status === 'done' ? `Consolidated: ${r.kept} kept, ${r.dropped} dropped, ${r.stale} possibly stale.` : `Not consolidated: ${r.reason}`)
            redraw()
          })
        },
        clearProject: key =>
          void memClearProject($, key).then(text => {
            toast(text)
            void memSetMemoryView($, { selected: '' })
            redraw()
          }),
      },
      { isMemoryOn: cfg.isMemoryOn !== false, hasForms, rows: room },
    )
  }

  const docsTab = () => (
    <Box flexDirection="column">
      <Box>
        {DOCS.map(p => (
          <Button
            key={`doc-${p.id}`}
            plain
            onPress={() => updateView($, x => ({ ...x, docPage: p.id }))}
          >
            {p.id === page.id ? `[${p.title}]` : p.title}{' '}
          </Button>
        ))}
      </Box>
      <Markdown key="doc-body" text={page.body} />
    </Box>
  )

  return (
    <Box flexDirection="column">
      <Box>
        {tabs.map(([id, label]) => (
          <Button key={`tab-${id}`} plain onPress={() => setTab(id)}>
            {v.tab === id ? `[${label}]` : label}{' '}
          </Button>
        ))}
        <Button
          key="tab-hud"
          plain
          onPress={async () => {
            try {
              toast(await startHud($, true))
            } catch (err) {
              toast(`Could not start the HUD: ${String(err)}`)
            }
          }}
        >
          <Text color="cyan">{isHudOn ? 'HUD*' : 'HUD'}</Text>
        </Button>
      </Box>
      {v.tab === 'sessions' && sessions()}
      {v.tab === 'new' && create()}
      {v.tab === 'projects' && projectsTab()}
      {v.tab === 'memory' && memoryTabView()}
      {v.tab === 'settings' && settingsTab()}
      {v.tab === 'docs' && docsTab()}
    </Box>
  )
}
