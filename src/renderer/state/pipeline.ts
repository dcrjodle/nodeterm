import { create } from 'zustand'
import type { NodeTerminalApi, PipelineIssue, ProjectPipeline } from '@shared/types'
import { resumeCommand, type AgentId } from '@shared/agents/config'
import { LocalTransport } from '../terminal/local-transport'
import { deliverCommand } from '../terminal/command-delivery'
import {
  MAX_ISSUE_HOPS,
  chainOrder,
  composeIssuePrompt,
  firstStation,
  hopCount,
  issueMovedTo,
  liveEdges,
  newIssue,
  nextEdge,
  resolveDecision,
  upstreamConnectors,
  type Station
} from '../lib/pipeline'
import { createAgentNode } from './workspace'
import { activePermissionMode } from './permissionMode'
import { useAgentStatus } from './agentStatus'
import { useProjects } from './projects'
import { markWorkspaceDirty } from './workspaceDirty'

/**
 * The loop engine — the one impure home of the pipeline (state/pipeline.ts). Everything it
 * decides comes from the pure lib/pipeline.ts; this file owns timers, the station pty clients,
 * and the agentStatus subscription that advances issues when an agent's turn completes.
 *
 * Contract with the rest of the app:
 *  - Issues/edges PERSIST on `project.pipeline` (via useProjects.setProjectPipeline +
 *    markWorkspaceDirty — the same debounced save path kanban edits ride).
 *  - The engine acts on the ACTIVE project only (React Flow is the live node source of truth,
 *    and station config is read through `EngineCtx.getStations`, fed by Canvas from live nodes).
 *  - A station's pty session uses persistKey = node id — the SAME contract terminal nodes
 *    follow, so tmux continuity, the session-memory panel, and the kanban modal all see it.
 */

export interface EngineCtx {
  api: NodeTerminalApi
  projectId: string
  getStations: () => Station[]
  /** Persists engine-minted node facts (agentSessionId) onto the live station node. */
  updateNodeData: (nodeId: string, patch: Record<string, unknown>) => void
}

/** The active project's engine context, published by Canvas so station cards / board cards can
 *  invoke engine actions without prop-drilling through React Flow. Null between projects. */
let currentCtx: EngineCtx | null = null

export function setEngineCtx(ctx: EngineCtx | null): void {
  currentCtx = ctx
}

export function engineCtx(): EngineCtx | null {
  return currentCtx
}

/** Transient engine surface the canvas renders from (edge transit pulses). Never persisted. */
interface PipelineFxState {
  transit: Record<string, number>
  pulse(edgeId: string): void
  sweep(): void
}

export const TRANSIT_MS = 1300

export const usePipelineFx = create<PipelineFxState>((set, get) => ({
  transit: {},
  pulse(edgeId) {
    set((s) => ({ transit: { ...s.transit, [edgeId]: Date.now() + TRANSIT_MS } }))
    setTimeout(() => get().sweep(), TRANSIT_MS + 50)
  },
  sweep() {
    const now = Date.now()
    set((s) => ({
      transit: Object.fromEntries(Object.entries(s.transit).filter(([, until]) => until > now))
    }))
  }
}))

// ---- module singletons ---------------------------------------------------------------------

/** One background pty client per agent station this app run has spawned/attached. The client is
 *  kept for the app's lifetime (killing it on a plain-shell fallback would kill the CLI — the
 *  live-work rule); the tmux session outlives us either way. */
const stationClients = new Map<string, { transport: LocalTransport; sessionId: string }>()

/** Agent stations whose CURRENT issue was injected and now awaits a working→done transition. */
const awaitTurn = new Map<string, { issueId: string; sawWorking: boolean }>()

/** Issues mid-injection (async) — the tick must not start them twice. */
const injecting = new Set<string>()

/** Dwell timers per issue so decisions/connectors advance once, visibly. */
const dwellTimers = new Map<string, ReturnType<typeof setTimeout>>()

const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'nu', 'pwsh', 'powershell'])

const DECISION_DWELL_MS = 450
const CONNECTOR_DWELL_MS = 1200
const AGENT_UP_TIMEOUT_MS = 25_000
const AGENT_SETTLE_MS = 1500

// ---- pipeline read/write helpers ------------------------------------------------------------

function pipelineOf(projectId: string): ProjectPipeline {
  return useProjects.getState().getProject(projectId)?.pipeline ?? { edges: [], issues: [] }
}

function writePipeline(projectId: string, next: ProjectPipeline): void {
  useProjects.getState().setProjectPipeline(projectId, next)
  markWorkspaceDirty()
}

function patchIssue(
  projectId: string,
  issueId: string,
  patch: (i: PipelineIssue) => PipelineIssue
): void {
  const p = pipelineOf(projectId)
  writePipeline(projectId, {
    ...p,
    issues: p.issues.map((i) => (i.id === issueId ? patch(i) : i))
  })
}

function appendNote(i: PipelineIssue, note: string): PipelineIssue {
  return { ...i, notes: i.notes ? `${i.notes}\n${note}` : note }
}

// ---- public actions --------------------------------------------------------------------------

/** Creates an issue. With `atNodeId` it queues at that station; otherwise at the chain's first
 *  station; with no stations at all it sits in the Queue column until one exists. */
export function addIssue(
  ctx: EngineCtx,
  fields: { title: string; body?: string; atNodeId?: string }
): void {
  const now = Date.now()
  const p = pipelineOf(ctx.projectId)
  const stations = ctx.getStations()
  const startAt = fields.atNodeId ?? firstStation(stations, p.edges)?.id
  let issue = newIssue(fields.title, fields.body ?? '', now)
  if (startAt) issue = issueMovedTo(issue, startAt, 'queued', now)
  writePipeline(ctx.projectId, { ...p, issues: [...p.issues, issue] })
  scheduleTick(ctx)
}

export function updateIssue(
  ctx: EngineCtx,
  issueId: string,
  patch: Partial<Pick<PipelineIssue, 'title' | 'body' | 'notes'>>
): void {
  patchIssue(ctx.projectId, issueId, (i) => ({ ...i, ...patch }))
}

export function deleteIssue(ctx: EngineCtx, issueId: string): void {
  const p = pipelineOf(ctx.projectId)
  injecting.delete(issueId)
  for (const [nodeId, wait] of awaitTurn) if (wait.issueId === issueId) awaitTurn.delete(nodeId)
  writePipeline(ctx.projectId, { ...p, issues: p.issues.filter((i) => i.id !== issueId) })
}

/** A human move (kanban drag, issue-card action): to a station, to 'done', or back to 'queue'.
 *  Recorded in history as a manual route; the engine picks the issue up at its new station. */
export function moveIssueManually(
  ctx: EngineCtx,
  issueId: string,
  target: string | 'done' | 'queue'
): void {
  const now = Date.now()
  clearDwell(issueId)
  patchIssue(ctx.projectId, issueId, (i) => {
    const released = releaseEngineHolds(i)
    if (target === 'done') return issueMovedTo(released, undefined, 'manual', now)
    if (target === 'queue')
      return { ...issueMovedTo(released, undefined, 'manual', now), status: 'queued' as const }
    return issueMovedTo(released, target, 'manual', now)
  })
  scheduleTick(ctx)
}

/** A waiting decision's manual override: route is 'next', 'back', or a branch label/title. */
export function routeWaitingIssue(ctx: EngineCtx, issueId: string, route: string): void {
  const p = pipelineOf(ctx.projectId)
  const issue = p.issues.find((i) => i.id === issueId)
  if (!issue?.atNodeId) return
  const stations = ctx.getStations()
  const edges = liveEdges(p.edges, stations)
  const now = Date.now()
  if (route === 'back') {
    const st = stations.find((s) => s.id === issue.atNodeId)
    const prev = st && resolveBack(issue, st.id)
    if (prev) advanceIssue(ctx, issueId, prev, 'manual:back', undefined, now)
    return
  }
  if (route === 'next') {
    const edge = nextEdge(edges, issue.atNodeId)
    if (edge) advanceIssue(ctx, issueId, edge.to, 'manual:next', edge.id, now)
    else advanceIssue(ctx, issueId, undefined, 'manual:done', undefined, now)
    return
  }
  const want = route.trim().toLowerCase()
  const byTitle = new Map(stations.map((s) => [s.title.trim().toLowerCase(), s.id]))
  const edge = edges
    .filter((e) => e.from === issue.atNodeId)
    .find((e) => e.label?.trim().toLowerCase() === want || byTitle.get(want) === e.to)
  if (edge) advanceIssue(ctx, issueId, edge.to, `manual:${route}`, edge.id, now)
}

/** Skip/advance an issue by hand regardless of station kind (the always-available escape). */
export function advanceIssueManually(ctx: EngineCtx, issueId: string): void {
  routeWaitingIssue(ctx, issueId, 'next')
}

/** Station nodes were deleted: drop their edges; issues stranded there return to the Queue. */
export function prunePipeline(ctx: EngineCtx): void {
  const p = useProjects.getState().getProject(ctx.projectId)?.pipeline
  if (!p) return
  const stations = ctx.getStations()
  const ids = new Set(stations.map((s) => s.id))
  const edges = p.edges.filter((e) => ids.has(e.from) && ids.has(e.to))
  const issues = p.issues.map((i) =>
    i.atNodeId && !ids.has(i.atNodeId)
      ? { ...releaseEngineHolds(i), status: 'queued' as const, atNodeId: undefined }
      : i
  )
  if (edges.length !== p.edges.length || issues.some((i, k) => i !== p.issues[k])) {
    writePipeline(ctx.projectId, { edges, issues })
  }
}

// ---- the engine ------------------------------------------------------------------------------

let tickQueued = false

/** Coalesced async tick — every mutation path ends here. */
export function scheduleTick(ctx: EngineCtx): void {
  if (tickQueued) return
  tickQueued = true
  setTimeout(() => {
    tickQueued = false
    try {
      tick(ctx)
    } catch {
      // The engine must never take the canvas down with it; a failed tick retries on the
      // next mutation/status event.
    }
  }, 0)
}

function tick(ctx: EngineCtx): void {
  const p = pipelineOf(ctx.projectId)
  if (!p.issues.length) return
  const stations = ctx.getStations()
  const edges = liveEdges(p.edges, stations)
  const byStation = new Map<string, PipelineIssue[]>()
  for (const i of p.issues) {
    if (i.status === 'done' || !i.atNodeId) continue
    const q = byStation.get(i.atNodeId) ?? []
    q.push(i)
    byStation.set(i.atNodeId, q)
  }
  for (const st of stations) {
    const queue = (byStation.get(st.id) ?? []).sort(
      (a, b) => (a.history[a.history.length - 1]?.enteredAt ?? 0) - (b.history[b.history.length - 1]?.enteredAt ?? 0)
    )
    if (!queue.length) continue
    // One issue at a time per station: an active/waiting head blocks the rest.
    const head = queue[0]
    if (head.status !== 'queued') continue
    if (st.kind === 'agent') {
      if (!injecting.has(head.id)) void startAgentIssue(ctx, st, head)
    } else if (st.kind === 'decision') {
      decideIssue(ctx, st, head, stations)
    } else {
      passConnector(ctx, st, head, edges)
    }
  }
}

function resolveBack(issue: PipelineIssue, currentId: string): string | undefined {
  for (let k = issue.history.length - 1; k >= 0; k--) {
    if (issue.history[k].nodeId !== currentId) return issue.history[k].nodeId
  }
  return undefined
}

function releaseEngineHolds(issue: PipelineIssue): PipelineIssue {
  injecting.delete(issue.id)
  for (const [nodeId, wait] of awaitTurn) if (wait.issueId === issue.id) awaitTurn.delete(nodeId)
  return issue
}

function clearDwell(issueId: string): void {
  const t = dwellTimers.get(issueId)
  if (t) clearTimeout(t)
  dwellTimers.delete(issueId)
}

function advanceIssue(
  ctx: EngineCtx,
  issueId: string,
  toNodeId: string | undefined,
  route: string,
  viaEdgeId: string | undefined,
  now: number
): void {
  clearDwell(issueId)
  patchIssue(ctx.projectId, issueId, (i) => {
    const released = releaseEngineHolds(i)
    if (toNodeId !== undefined && hopCount(released) >= MAX_ISSUE_HOPS) {
      return appendNote(
        { ...released, status: 'waiting' },
        `[loop limit] ${MAX_ISSUE_HOPS} hops reached — move it by hand to resume.`
      )
    }
    return issueMovedTo(released, toNodeId, route, now)
  })
  if (viaEdgeId) usePipelineFx.getState().pulse(viaEdgeId)
  scheduleTick(ctx)
}

// ---- agent stations --------------------------------------------------------------------------

async function startAgentIssue(ctx: EngineCtx, st: Station, issue: PipelineIssue): Promise<void> {
  injecting.add(issue.id)
  patchIssue(ctx.projectId, issue.id, (i) => ({ ...i, status: 'active' }))
  try {
    await ensureAgentSession(ctx, st)
    const p = pipelineOf(ctx.projectId)
    const stations = ctx.getStations()
    const prompt = composeIssuePrompt(
      p.issues.find((i) => i.id === issue.id) ?? issue,
      st,
      upstreamConnectors(st.id, stations, liveEdges(p.edges, stations))
    )
    awaitTurn.set(st.id, { issueId: issue.id, sawWorking: false })
    const ok = await ctx.api.pty.sendText(st.id, prompt)
    if (!ok) throw new Error('sendText refused')
  } catch {
    awaitTurn.delete(st.id)
    patchIssue(ctx.projectId, issue.id, (i) =>
      appendNote(
        { ...i, status: 'waiting' },
        '[engine] could not reach the agent session — check the station, then Advance or retry by moving the card.'
      )
    )
  } finally {
    injecting.delete(issue.id)
  }
}

async function ensureAgentSession(ctx: EngineCtx, st: Station): Promise<void> {
  const agentId = (st.agentId ?? 'claude') as AgentId
  let client = stationClients.get(st.id)
  if (!client) {
    const transport = new LocalTransport(ctx.api)
    const res = await transport.create({
      persistKey: st.id,
      cwd: st.cwd,
      cols: 100,
      rows: 30,
      agentId
    })
    client = { transport, sessionId: res.sessionId }
    stationClients.set(st.id, client)
    const hasStatus = !!useAgentStatus.getState().byId[st.id]?.state
    if (res.fresh || !hasStatus) {
      const launch = await composeLaunch(ctx, st, agentId, res.fresh)
      if (launch) {
        await deliverWhenShellReady(client.transport, client.sessionId, launch)
        await waitForAgentUp(st.id, AGENT_UP_TIMEOUT_MS)
        await sleep(AGENT_SETTLE_MS)
      }
    }
  }
}

/** Fresh session → the same composed launch a new agent node gets (session-id mint included,
 *  persisted onto the station). Warm session → only launch when a SHELL owns the pane (resume
 *  by the known session id when there is one); a live CLI gets nothing typed into it. */
async function composeLaunch(
  ctx: EngineCtx,
  st: Station,
  agentId: AgentId,
  fresh: boolean
): Promise<string | null> {
  if (!fresh) {
    const pane = await ctx.api.pty.paneCommand(st.id).catch(() => null)
    if (pane && !SHELLS.has(pane.toLowerCase())) return null
    const known = knownSessionId(st.id)
    if (known) {
      const resume = resumeCommand(agentId, known)
      if (resume) return resume
    }
  }
  const proto = createAgentNode(
    agentId,
    0,
    st.cwd,
    undefined,
    undefined,
    undefined,
    undefined,
    activePermissionMode(agentId)
  )
  const minted = proto.data.agentSessionId
  if (minted) ctx.updateNodeData(st.id, { agentSessionId: minted })
  return (proto.data.initialCommand as string | undefined) ?? null
}

function knownSessionId(nodeId: string): string | undefined {
  return useAgentStatus.getState().byId[nodeId]?.sessionId ?? undefined
}

function deliverWhenShellReady(
  transport: LocalTransport,
  sessionId: string,
  cmd: string
): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    let timer: ReturnType<typeof setTimeout>
    const fire = (): void => {
      if (done) return
      done = true
      unsub()
      deliverCommand(
        {
          write: (d) => transport.write(sessionId, d),
          onData: (cb) => transport.onData(sessionId, cb)
        },
        cmd,
        () => resolve()
      )
      // deliverCommand is fail-open but its settle callback only fires on delivery paths;
      // resolve on a backstop either way so the engine can never hang on a silent shell.
      setTimeout(resolve, 8000)
    }
    const unsub = transport.onData(sessionId, () => {
      if (done) return
      clearTimeout(timer)
      timer = setTimeout(fire, 200)
    })
    timer = setTimeout(fire, 1500)
  })
}

function waitForAgentUp(nodeId: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now()
    const poll = (): void => {
      if (useAgentStatus.getState().byId[nodeId]?.state) return resolve()
      if (Date.now() - started > timeoutMs) return resolve()
      setTimeout(poll, 500)
    }
    poll()
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ---- decision / connector stations -----------------------------------------------------------

function decideIssue(ctx: EngineCtx, st: Station, issue: PipelineIssue, stations: Station[]): void {
  const p = pipelineOf(ctx.projectId)
  const edges = liveEdges(p.edges, stations)
  const route = resolveDecision(st, issue, edges, stations)
  if (route.kind === 'wait') {
    patchIssue(ctx.projectId, issue.id, (i) => ({ ...i, status: 'waiting' }))
    return
  }
  if (dwellTimers.has(issue.id)) return
  patchIssue(ctx.projectId, issue.id, (i) => ({ ...i, status: 'active' }))
  dwellTimers.set(
    issue.id,
    setTimeout(() => {
      dwellTimers.delete(issue.id)
      if (route.kind === 'back') advanceIssue(ctx, issue.id, route.toNodeId, 'back', undefined, Date.now())
      else if (route.kind === 'next') advanceIssue(ctx, issue.id, route.edge.to, 'next', route.edge.id, Date.now())
      else advanceIssue(ctx, issue.id, route.edge.to, route.label, route.edge.id, Date.now())
    }, DECISION_DWELL_MS)
  )
}

function passConnector(
  ctx: EngineCtx,
  st: Station,
  issue: PipelineIssue,
  edges: ReturnType<typeof liveEdges>
): void {
  if (dwellTimers.has(issue.id)) return
  patchIssue(ctx.projectId, issue.id, (i) => ({ ...i, status: 'active' }))
  const edge = nextEdge(edges, st.id)
  dwellTimers.set(
    issue.id,
    setTimeout(() => {
      dwellTimers.delete(issue.id)
      const via = st.service === 'custom' ? st.customLabel || st.title : (st.service ?? st.title)
      if (edge) advanceIssue(ctx, issue.id, edge.to, `via ${via}`, edge.id, Date.now())
      else advanceIssue(ctx, issue.id, undefined, `via ${via}`, undefined, Date.now())
    }, CONNECTOR_DWELL_MS)
  )
}

// ---- agentStatus subscription ------------------------------------------------------------------

/** Wired once by Canvas: advances an agent station's issue on its working→done transition.
 *  A done that arrives before the injected prompt ever produced `working` is a STALE turn
 *  (the previous conversation ending) and must not advance anything. */
export function wireAgentTransitions(ctx: EngineCtx): () => void {
  return useAgentStatus.subscribe((s, prev) => {
    for (const [nodeId, wait] of awaitTurn) {
      const cur = s.byId[nodeId]?.state
      const was = prev.byId[nodeId]?.state
      if (cur === was) continue
      if (cur === 'working') {
        wait.sawWorking = true
        continue
      }
      if (cur === 'done' && wait.sawWorking) {
        awaitTurn.delete(nodeId)
        const p = pipelineOf(ctx.projectId)
        const issue = p.issues.find((i) => i.id === wait.issueId)
        if (!issue || issue.atNodeId !== nodeId || issue.status !== 'active') continue
        const stations = ctx.getStations()
        const edges = liveEdges(p.edges, stations)
        const edge = nextEdge(edges, nodeId)
        if (edge) advanceIssue(ctx, issue.id, edge.to, 'next', edge.id, Date.now())
        else advanceIssue(ctx, issue.id, undefined, 'done', undefined, Date.now())
      }
    }
  })
}

/** Counts shown as station badges: queued/active/waiting at one station. */
export function stationIssueCounts(
  pipeline: ProjectPipeline | undefined,
  nodeId: string
): { queued: number; active: number; waiting: number } {
  const out = { queued: 0, active: 0, waiting: 0 }
  if (!pipeline) return out
  for (const i of pipeline.issues) {
    if (i.atNodeId !== nodeId || i.status === 'done') continue
    out[i.status]++
  }
  return out
}

/** True while any station's chain order changed enough to warrant a re-derive — cheap signature
 *  for subscribers that only care about column structure. */
export function pipelineSig(pipeline: ProjectPipeline | undefined): string {
  if (!pipeline) return ''
  return `${pipeline.edges.map((e) => `${e.from}>${e.to}:${e.label ?? ''}`).join('|')}#${pipeline.issues
    .map((i) => `${i.id}@${i.atNodeId ?? ''}:${i.status}`)
    .join('|')}`
}

export { chainOrder }
