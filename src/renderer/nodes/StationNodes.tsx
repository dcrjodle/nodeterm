import { useState } from 'react'
import { Handle, NodeResizer, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { AGENT_CONFIG, BUILTIN_AGENT_IDS, hasHooks, type AgentId } from '@shared/agents/config'
import type { ConnectorService, DecisionRule } from '@shared/types'
import type { CanvasNode } from '../state/workspace'
import { useAgentStatus } from '../state/agentStatus'
import { useProjects } from '../state/projects'
import { useSettings } from '../state/settings'
import { useSession } from '../session/session'
import { advanceIssueManually, engineCtx, routeWaitingIssue } from '../state/pipeline'
import { liveEdges, stationsOf } from '../lib/pipeline'
import { flowToNodeStates } from '../state/workspace'

/**
 * The three pipeline stations (Weave-style cards). Stations are CONFIG surfaces — the loop
 * engine (state/pipeline.ts) owns every side effect; nothing here spawns or writes to a pty.
 * All three share the pipe-in/pipe-out handle contract Canvas's onConnect routes on.
 */

const STATION_GLYPHS = { agent: '▣', decision: '◇', connector: '⬡' } as const

function useStationIssueSig(id: string): { queued: number; active: number; waiting: number } {
  const sig = useProjects((s) => {
    const p = s.projects.find((x) => x.id === s.activeProjectId)?.pipeline
    if (!p) return '0|0|0'
    let q = 0
    let a = 0
    let w = 0
    for (const i of p.issues) {
      if (i.atNodeId !== id || i.status === 'done') continue
      if (i.status === 'queued') q++
      else if (i.status === 'active') a++
      else if (i.status === 'waiting') w++
    }
    return `${q}|${a}|${w}`
  })
  const [queued, active, waiting] = sig.split('|').map(Number)
  return { queued, active, waiting }
}

function IssueBadges({ nodeId }: { nodeId: string }): React.JSX.Element | null {
  const { queued, active, waiting } = useStationIssueSig(nodeId)
  if (!queued && !active && !waiting) return null
  return (
    <div className="station__badges">
      {active > 0 && <span className="station__badge station__badge--active">● {active}</span>}
      {waiting > 0 && <span className="station__badge station__badge--waiting">⏸ {waiting}</span>}
      {queued > 0 && <span className="station__badge station__badge--queued">{queued} queued</span>}
    </div>
  )
}

function StationShell({
  id,
  kind,
  data,
  selected,
  minWidth,
  minHeight,
  headerExtra,
  children
}: {
  id: string
  kind: 'agent' | 'decision' | 'connector'
  data: CanvasNode['data']
  selected?: boolean
  minWidth: number
  minHeight: number
  headerExtra?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const { updateNodeData } = useReactFlow()
  const [editing, setEditing] = useState(false)
  const [before, setBefore] = useState('')
  const title = (data.title as string) || 'Untitled'
  return (
    <div className={`station station--${kind}${selected ? ' selected' : ''}`}>
      <NodeResizer minWidth={minWidth} minHeight={minHeight} isVisible={!!selected} lineStyle={{ opacity: 0 }} />
      <Handle id="pipe-in" type="target" position={Position.Left} className="pipe-handle pipe-handle--in" />
      <Handle id="pipe-out" type="source" position={Position.Right} className="pipe-handle pipe-handle--out" />
      {kind === 'decision' && (
        <Handle id="pipe-alt" type="source" position={Position.Bottom} className="pipe-handle pipe-handle--alt" />
      )}
      <div className="station__header">
        <span className="station__glyph" style={{ color: data.color as string }}>
          {STATION_GLYPHS[kind]}
        </span>
        {editing ? (
          <input
            className="station__title-input nodrag"
            autoFocus
            defaultValue={title}
            onBlur={(e) => {
              setEditing(false)
              const v = e.currentTarget.value.trim()
              if (v && v !== title) updateNodeData(id, { title: v, titleAuto: false })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                e.currentTarget.value = before
                e.currentTarget.blur()
              }
              e.stopPropagation()
            }}
          />
        ) : (
          <span
            className="station__title"
            title="Rename"
            onClick={() => {
              setBefore(title)
              setEditing(true)
            }}
          >
            {title}
          </span>
        )}
        {headerExtra}
        <button
          className="station__close nodrag"
          title="Delete station"
          onClick={() =>
            // Routed through Canvas's deleteNodes (NOT React Flow's deleteElements) so a
            // spawned agent-station session is destroyed and the engine's client released —
            // deleteElements would remove the card and leave the tmux session attached forever.
            window.dispatchEvent(new CustomEvent('nodeterm:delete-station', { detail: { nodeId: id } }))
          }
        >
          ×
        </button>
      </div>
      {children}
      <IssueBadges nodeId={id} />
    </div>
  )
}

// ---- Agent station ----------------------------------------------------------------------------

const AGENT_STATE_LABEL: Record<string, string> = {
  working: 'Running',
  waiting: 'Needs you',
  blocked: 'Needs you',
  done: 'Idle'
}

export function AgentStationNode({ id, data, selected }: NodeProps<CanvasNode>): React.JSX.Element {
  const { updateNodeData } = useReactFlow()
  const { api } = useSession()
  const state = useAgentStatus((s) => s.byId[id]?.state)
  const customAgents = useSettings((s) => s.settings.customAgents ?? [])
  const agentId = (data.agentId as string) ?? 'claude'
  const cwd = (data.cwd as string) ?? ''
  const shortCwd = cwd ? cwd.replace(/^\/(Users|home)\/[^/]+/, '~') : 'Project folder'

  const pickFolder = async (): Promise<void> => {
    const dir = await api.dialog.selectFolder()
    if (dir) updateNodeData(id, { cwd: dir })
  }

  return (
    <StationShell
      id={id}
      kind="agent"
      data={data}
      selected={selected}
      minWidth={280}
      minHeight={260}
      headerExtra={
        <span className={`station__state station__state--${state ?? 'off'}`}>
          {AGENT_STATE_LABEL[state ?? ''] ?? 'Not started'}
        </span>
      }
    >
      <div className="station__body nodrag">
        <div className="station__block">
          <label className="station__label">cli</label>
          <select
            className="station__select"
            value={agentId}
            onChange={(e) => updateNodeData(id, { agentId: e.target.value as AgentId })}
          >
            {BUILTIN_AGENT_IDS.map((a) => (
              <option key={a} value={a}>
                {AGENT_CONFIG[a]?.label ?? a}
              </option>
            ))}
            {customAgents.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label || c.id}
              </option>
            ))}
          </select>
          {!hasHooks(agentId as AgentId) && (
            <div className="station__hint">
              No status hooks — issues will not auto-advance past this station; use the card's
              Advance button.
            </div>
          )}
        </div>
        <div className="station__block station__block--grow">
          <label className="station__label">assignment</label>
          <textarea
            className="station__text nowheel"
            placeholder="Standing instructions injected with every issue that reaches this agent…"
            value={(data.assignment as string) ?? ''}
            onChange={(e) => updateNodeData(id, { assignment: e.target.value })}
          />
        </div>
        <div className="station__block">
          <label className="station__label">sandbox</label>
          <div className="station__row">
            <span className="station__path" title={cwd || 'Uses the project folder'}>
              {shortCwd}
            </span>
            <button className="station__btn" onClick={() => void pickFolder()}>
              Browse
            </button>
            <button
              className="station__btn"
              title="Open a terminal attached to this station's session"
              onClick={() =>
                window.dispatchEvent(new CustomEvent('nodeterm:watch-station', { detail: { nodeId: id } }))
              }
            >
              Watch
            </button>
          </div>
        </div>
      </div>
    </StationShell>
  )
}

// ---- Decision station ---------------------------------------------------------------------------

export function DecisionStationNode({ id, data, selected }: NodeProps<CanvasNode>): React.JSX.Element {
  const { updateNodeData, getNodes } = useReactFlow()
  const rules = (data.rules as DecisionRule[]) ?? []
  const mode = (data.decisionMode as string) ?? 'auto'
  const waitingIssueId = useProjects((s) => {
    const p = s.projects.find((x) => x.id === s.activeProjectId)?.pipeline
    return p?.issues.find((i) => i.atNodeId === id && i.status === 'waiting')?.id ?? ''
  })

  const setRule = (k: number, patch: Partial<DecisionRule>): void => {
    updateNodeData(id, { rules: rules.map((r, i) => (i === k ? { ...r, ...patch } : r)) })
  }

  const routeChoices = (): string[] => {
    const ctx = engineCtx()
    if (!ctx) return ['next', 'back']
    const p = useProjects.getState().getProject(ctx.projectId)?.pipeline
    if (!p) return ['next', 'back']
    const stations = stationsOf(flowToNodeStates(getNodes() as CanvasNode[]))
    const out = liveEdges(p.edges, stations).filter((e) => e.from === id)
    const byId = new Map(stations.map((s) => [s.id, s.title]))
    const branches = out.map((e) => e.label || byId.get(e.to) || '').filter(Boolean)
    return ['next', 'back', ...branches.filter((b) => b !== 'next' && b !== 'back')]
  }

  return (
    <StationShell id={id} kind="decision" data={data} selected={selected} minWidth={280} minHeight={220}>
      <div className="station__body nodrag">
        <div className="station__block">
          <label className="station__label">criteria</label>
          <textarea
            className="station__text station__text--short nowheel"
            placeholder="What this decision is about (documentation for the rules below)…"
            value={(data.criteria as string) ?? ''}
            onChange={(e) => updateNodeData(id, { criteria: e.target.value })}
          />
        </div>
        <div className="station__block station__block--grow">
          <label className="station__label">
            rules · first match wins
            <span className="station__mode">
              <button
                className={`station__mode-btn${mode === 'auto' ? ' on' : ''}`}
                onClick={() => updateNodeData(id, { decisionMode: 'auto' })}
              >
                Auto
              </button>
              <button
                className={`station__mode-btn${mode === 'manual' ? ' on' : ''}`}
                onClick={() => updateNodeData(id, { decisionMode: 'manual' })}
              >
                Manual
              </button>
            </span>
          </label>
          <div className="station__rules nowheel">
            {rules.map((r, k) => (
              <div className="station__rule" key={k}>
                <span className="station__rule-word">contains</span>
                <input
                  className="station__rule-input"
                  placeholder="keyword"
                  value={r.match}
                  onChange={(e) => setRule(k, { match: e.target.value })}
                />
                <span className="station__rule-word">→</span>
                <input
                  className="station__rule-input"
                  placeholder="next · back · station title"
                  value={r.route}
                  onChange={(e) => setRule(k, { route: e.target.value })}
                />
                <button
                  className="station__rule-del"
                  onClick={() => updateNodeData(id, { rules: rules.filter((_, i) => i !== k) })}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              className="station__btn station__btn--add"
              onClick={() => updateNodeData(id, { rules: [...rules, { match: '', route: 'next' }] })}
            >
              + Rule
            </button>
          </div>
        </div>
        {waitingIssueId && (
          <div className="station__block">
            <label className="station__label">waiting — route it</label>
            <div className="station__row station__row--wrap">
              {routeChoices().map((route) => (
                <button
                  key={route}
                  className="station__btn station__btn--route"
                  onClick={() => {
                    const ctx = engineCtx()
                    if (ctx) routeWaitingIssue(ctx, waitingIssueId, route)
                  }}
                >
                  {route === 'next' ? '⏭ next' : route === 'back' ? '↩ back' : route}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </StationShell>
  )
}

// ---- Connector station ----------------------------------------------------------------------------

const SERVICES: Array<{ id: ConnectorService; label: string }> = [
  { id: 'github', label: 'GitHub' },
  { id: 'slack', label: 'Slack' },
  { id: 'gmail', label: 'Gmail' },
  { id: 'custom', label: 'Custom…' }
]

export function ConnectorStationNode({ id, data, selected }: NodeProps<CanvasNode>): React.JSX.Element {
  const { updateNodeData } = useReactFlow()
  const service = (data.service as ConnectorService) ?? 'github'
  const authKind = (data.authKind as string) ?? 'oauth-cli'
  return (
    <StationShell id={id} kind="connector" data={data} selected={selected} minWidth={260} minHeight={170}>
      <div className="station__body nodrag">
        <div className="station__block">
          <label className="station__label">service</label>
          <div className="station__row">
            <select
              className="station__select"
              value={service}
              onChange={(e) => {
                const svc = e.target.value as ConnectorService
                const label = SERVICES.find((s) => s.id === svc)?.label
                updateNodeData(id, {
                  service: svc,
                  ...(label && svc !== 'custom' ? { title: label } : {})
                })
              }}
            >
              {SERVICES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            {service === 'custom' && (
              <input
                className="station__rule-input"
                placeholder="Name"
                value={(data.customLabel as string) ?? ''}
                onChange={(e) => updateNodeData(id, { customLabel: e.target.value, title: e.target.value || 'Connector' })}
              />
            )}
          </div>
        </div>
        <div className="station__block">
          <label className="station__label">auth</label>
          <div className="station__row">
            <span className="station__mode">
              <button
                className={`station__mode-btn${authKind === 'oauth-cli' ? ' on' : ''}`}
                onClick={() => updateNodeData(id, { authKind: 'oauth-cli' })}
              >
                OAuth / CLI
              </button>
              <button
                className={`station__mode-btn${authKind === 'api-key' ? ' on' : ''}`}
                onClick={() => updateNodeData(id, { authKind: 'api-key' })}
              >
                API key
              </button>
            </span>
          </div>
          {authKind === 'api-key' && (
            <input
              className="station__rule-input"
              placeholder="ENV_VAR_NAME (name only — never the value)"
              value={(data.envVar as string) ?? ''}
              onChange={(e) => updateNodeData(id, { envVar: e.target.value })}
            />
          )}
        </div>
        <div className="station__hint">
          Passes context to downstream agents. Secrets stay in your environment — issues carry
          only the variable name.
        </div>
      </div>
    </StationShell>
  )
}

export function stationAdvanceEscape(issueId: string): void {
  const ctx = engineCtx()
  if (ctx) advanceIssueManually(ctx, issueId)
}
