import { create } from 'zustand'
import type { NodeTerminalApi, PipelineIssue, ProjectPipeline } from '@shared/types'
import { resumeCommand } from '@shared/agents/config'
import { withPermissionMode } from '@shared/agents/approval-mode'
import {
  MAX_ISSUE_HOPS,
  assignmentTextFor,
  chainOrder,
  composeAssignmentPrompt,
  composeIssuePrompt,
  firstStation,
  hopCount,
  issueMovedTo,
  liveEdges,
  newIssue,
  nextEdge,
  resolveDecision,
  sandboxCwdFor,
  stationsOf,
  upstreamConnectors,
  type Satellite,
  type Station
} from '../lib/pipeline'
import { hasMountLaunch } from '../terminal/launch-ledger'
import { createAgentNode, prefixLaunchWithCd } from './workspace'
import { ensureActivePermissionMode } from './permissionMode'
import { useAgentStatus } from './agentStatus'
import { useProjects } from './projects'
import { markWorkspaceDirty } from './workspaceDirty'

/**
 * The loop engine — the one impure home of the pipeline (state/pipeline.ts). Everything it
 * decides comes from the pure lib/pipeline.ts; this file owns timers, the station launch
 * choreography, and the agentStatus subscription that advances issues when an agent's turn
 * completes.
 *
 * Contract with the rest of the app:
 *  - Issues/edges PERSIST on `project.pipeline` (via useProjects.setProjectPipeline +
 *    markWorkspaceDirty — the same debounced save path kanban edits ride).
 *  - The engine acts on the ACTIVE project only (React Flow is the live node source of truth,
 *    and station config is read through `EngineCtx.getStations`, fed by Canvas from live nodes).
 *  - A station's pty session uses persistKey = node id — the SAME contract terminal nodes
 *    follow, so tmux continuity, the session-memory panel, and the kanban modal all see it.
 *  - The engine SPAWNS NOTHING. An agent station is a mounted terminal node (TerminalNode owns
 *    the pty + xterm exactly as for any terminal); the engine only decides WHEN the Claude CLI
 *    is launched into that pane — via `pty.sendText` at a shell — and what rides the launch:
 *    `cd` into the connected sandbox folder, and the connected assignment as the initial
 *    prompt. Everything the engine types is pane-guarded (a shell would EXECUTE a multi-line
 *    prompt), and every wait is bounded — the engine must never hang the canvas.
 */

export interface EngineCtx {
  api: NodeTerminalApi
  projectId: string
  getStations: () => Station[]
  /** The assignment/sandbox satellite cards, read live like stations. */
  getSatellites: () => Satellite[]
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

/** One in-flight launch/ensure per station — a ▶ Start click and an arriving issue must not
 *  both type a launch line into the same pane. */
const stationLaunches = new Map<string, Promise<void>>()

/** Agent stations whose CURRENT issue was injected and now awaits a working→done transition. */
const awaitTurn = new Map<string, { issueId: string; sawWorking: boolean }>()

/** Issues mid-injection (async) — the tick must not start them twice. */
const injecting = new Set<string>()

/** Dwell timers per issue so decisions/connectors advance once, visibly. */
const dwellTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Deliberately BROADER than shared/agents/pane's `isShellCommand` (it excludes nu/pwsh by
 *  design for the restart flow): here "looks like a shell" gates whether the engine may TYPE
 *  into the pane, and over-matching refuses an injection — the safe direction. */
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
 *  station. With no stations at all it PARKS in the Queue column — Queue is a deliberate holding
 *  pen (issues moved there by hand stay put), so entering a later-built chain is a manual drag. */
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
  clearDwell(issueId)
  injecting.delete(issueId)
  for (const [nodeId, wait] of awaitTurn) if (wait.issueId === issueId) awaitTurn.delete(nodeId)
  writePipeline(ctx.projectId, { ...p, issues: p.issues.filter((i) => i.id !== issueId) })
}

/** Permanent station delete (Canvas): drop every engine hold for the node. The node's terminal
 *  (TerminalNode) and Canvas's delete path own the pty client + `transport.destroy`; this only
 *  releases what the ENGINE holds, so a deleted station can't keep a wait or launch lock alive. */
export function releaseStationHolds(nodeId: string): void {
  awaitTurn.delete(nodeId)
  stationLaunches.delete(nodeId)
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

/** Station/satellite nodes were deleted: drop their edges (chain AND `cfg-` config edges);
 *  issues stranded at a deleted station return to the Queue. */
export function prunePipeline(ctx: EngineCtx): void {
  const p = useProjects.getState().getProject(ctx.projectId)?.pipeline
  if (!p) return
  const stations = ctx.getStations()
  const ids = new Set(stations.map((s) => s.id))
  // Config edges' FROM side is a satellite, never a station — without this set a satellite's
  // edge would be pruned the tick after it was drawn.
  const live = new Set([...ids, ...ctx.getSatellites().map((s) => s.id)])
  const edges = p.edges.filter((e) => live.has(e.from) && live.has(e.to))
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
    // Self-heal: `active` is engine-held state, but the holds (injecting/awaitTurn/dwell) are
    // in-memory — an app restart or a project switch mid-turn loses them, and an active head
    // with no holder would block its station FOREVER (tick only starts `queued` heads). An
    // orphaned active issue re-queues so the engine re-injects; a duplicate turn is visible
    // and recoverable, a silently dead station is neither.
    if (head.status === 'active' && !engineHolds(head.id, st.id)) {
      patchIssue(ctx.projectId, head.id, (i) => ({ ...i, status: 'queued' }))
      scheduleTick(ctx)
      continue
    }
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

/** Whether the engine currently OWNS this issue's `active` status (see the tick self-heal). */
function engineHolds(issueId: string, stationId: string): boolean {
  return (
    injecting.has(issueId) ||
    awaitTurn.get(stationId)?.issueId === issueId ||
    dwellTimers.has(issueId)
  )
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
  advanceIssueIn(ctx, ctx.projectId, issueId, toNodeId, route, viaEdgeId, now)
}

/** The projectId-explicit core: the hook-driven advance may fire for a project the user has
 *  switched away from (the tmux session and its hooks don't pause with the tab), and the write
 *  must land on the OWNING project's pipeline, never the active one's. */
function advanceIssueIn(
  ctx: EngineCtx,
  projectId: string,
  issueId: string,
  toNodeId: string | undefined,
  route: string,
  viaEdgeId: string | undefined,
  now: number
): void {
  clearDwell(issueId)
  patchIssue(projectId, issueId, (i) => {
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

const ENGINE_NOTES: Record<string, string> = {
  'ssh-project':
    '[engine] pipeline stations are local-only in v1 — this is an SSH project, so no local session was spawned. Run the pipeline from a local project.',
  'agent-not-up':
    '[engine] the Claude CLI never came up in this station — a shell owns the pane, so the issue prompt was NOT injected (typed into a shell it would execute line by line). Check the station terminal, then re-queue the card.'
}

async function startAgentIssue(ctx: EngineCtx, st: Station, issue: PipelineIssue): Promise<void> {
  injecting.add(issue.id)
  patchIssue(ctx.projectId, issue.id, (i) => ({ ...i, status: 'active' }))
  try {
    // Local-only v1: an SSH project's station would launch a LOCAL CLI for a remote cwd — the
    // class the "a remote node is NEVER spawned locally" invariant forbids. Canvas disables
    // station creation on SSH projects; this is the backstop.
    if (useProjects.getState().getProject(ctx.projectId)?.ssh) throw new Error('ssh-project')
    await ensureStationAgent(ctx, st)
    // Injection guard: the prompt is multi-line, and typed at a bare shell each line would
    // EXECUTE (the note-push rule). A live pane owned by a shell refuses regardless of any
    // stale status; an unknown pane with no status ever seen refuses too (fail-closed —
    // `waitForAgentUp` resolves on timeout, so reaching this line proves nothing by itself).
    const pane = await ctx.api.pty.paneCommand(st.id).catch(() => null)
    const hasStatus = !!useAgentStatus.getState().byId[st.id]?.state
    if ((pane && SHELLS.has(pane.toLowerCase())) || (!pane && !hasStatus)) {
      throw new Error('agent-not-up')
    }
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
  } catch (e) {
    awaitTurn.delete(st.id)
    const note =
      (e instanceof Error && ENGINE_NOTES[e.message]) ||
      '[engine] could not reach the agent session — check the station, then Advance or retry by moving the card.'
    patchIssue(ctx.projectId, issue.id, (i) => appendNote({ ...i, status: 'waiting' }, note))
  } finally {
    injecting.delete(issue.id)
  }
}

/** ▶ Start on a station's terminal (or an issue arriving): make sure the Claude CLI is running
 *  in the station's pane. Public so the node's Start action shares the issue path's launch lock. */
export function startStationAgent(ctx: EngineCtx, stationId: string): void {
  const st = ctx.getStations().find((s) => s.id === stationId)
  if (!st || st.kind !== 'agent') return
  if (useProjects.getState().getProject(ctx.projectId)?.ssh) return
  void ensureStationAgent(ctx, st).catch(() => {
    // The pane guard in startAgentIssue is the reporting path; a manual Start that could not
    // launch leaves the terminal exactly as it was, in view.
  })
}

/** One-shot assignment push, used when an assignment card is CONNECTED to a station whose CLI
 *  is already running (a fresh launch instead carries the assignment as its initial prompt).
 *  Pane-guarded like every engine write: typed at a shell the text would execute, so a station
 *  whose CLI is not up gets nothing — its next launch resolves the assignment anyway. */
export async function pushAssignmentToStation(ctx: EngineCtx, stationId: string): Promise<void> {
  const pane = await ctx.api.pty.paneCommand(stationId).catch(() => null)
  if (!pane || SHELLS.has(pane.toLowerCase())) return
  if (!useAgentStatus.getState().byId[stationId]?.state) return
  const p = pipelineOf(ctx.projectId)
  const msg = composeAssignmentPrompt(assignmentTextFor(stationId, p.edges, ctx.getSatellites()))
  if (!msg) return
  void ctx.api.pty.sendText(stationId, msg)
}

/**
 * Ensure the station's pane runs the Claude CLI, launching it if a shell owns the pane. The
 * engine types the launch with `pty.sendText` — the station's terminal node owns the pty itself.
 * Serialized per station (`stationLaunches`), and deferred to TerminalNode whenever ITS mount
 * launch is still in flight (`hasMountLaunch` — cold-restore resume writes race the first issue,
 * and two launch lines at one shell would feed the second into the CLI as typed input).
 */
async function ensureStationAgent(ctx: EngineCtx, st: Station): Promise<void> {
  const prev = stationLaunches.get(st.id)
  if (prev) return prev
  const run = (async () => {
    if (hasMountLaunch(st.id)) {
      await waitForAgentUp(st.id, AGENT_UP_TIMEOUT_MS)
      await sleep(AGENT_SETTLE_MS)
      return
    }
    let pane = await ctx.api.pty.paneCommand(st.id).catch(() => null)
    if (pane === null) {
      // No session yet — the node's terminal is still spawning (a just-created station's first
      // issue). Give the mount a bounded window, then look again.
      pane = await waitForPane(ctx, st.id, PANE_WAIT_MS)
      if (pane === null) throw new Error('agent-not-up')
    }
    if (!SHELLS.has(pane.toLowerCase())) {
      // The CLI (or something that is not a shell) already owns the pane — nothing to type.
      // If its hooks have not reported yet (launch still warming), give them the usual window.
      if (!useAgentStatus.getState().byId[st.id]?.state) {
        await waitForAgentUp(st.id, AGENT_UP_TIMEOUT_MS)
        await sleep(AGENT_SETTLE_MS)
      }
      return
    }
    const launch = await composeStationLaunch(ctx, st)
    const ok = await ctx.api.pty.sendText(st.id, launch)
    if (!ok) throw new Error('agent-not-up')
    await waitForAgentUp(st.id, AGENT_UP_TIMEOUT_MS)
    await sleep(AGENT_SETTLE_MS)
  })()
  stationLaunches.set(st.id, run)
  try {
    await run
  } finally {
    if (stationLaunches.get(st.id) === run) stationLaunches.delete(st.id)
  }
}

/**
 * The launch line typed at the station's shell. Resume when any session id is known — the
 * resumed conversation already carries its assignment. Fresh start otherwise: the same composed
 * launch a new Claude agent node gets (session-id mint persisted onto the station, permission
 * mode resolved through the probe-aware path), with the CONNECTED assignment as the initial
 * prompt. Both shapes are prefixed with `cd` into the resolved sandbox folder (else the project
 * folder the station carries) — the pane's shell may have been spawned before the sandbox was
 * connected, so the cwd is entered explicitly, single-quoted (user-picked text on a shell line).
 */
async function composeStationLaunch(ctx: EngineCtx, st: Station): Promise<string> {
  const p = pipelineOf(ctx.projectId)
  const satellites = ctx.getSatellites()
  const cwd = sandboxCwdFor(st.id, p.edges, satellites) ?? st.cwd
  const mode = await ensureActivePermissionMode('claude')
  const known = useAgentStatus.getState().byId[st.id]?.sessionId || st.agentSessionId
  if (known) {
    const resume = resumeCommand('claude', known)
    if (resume) return prefixLaunchWithCd(withPermissionMode(resume, 'claude', mode), cwd)
  }
  const assignment = composeAssignmentPrompt(assignmentTextFor(st.id, p.edges, satellites))
  const proto = createAgentNode(
    'claude',
    0,
    cwd,
    undefined,
    assignment || undefined,
    undefined,
    // The station's accountId was resolved at creation (resolveNewNodeAccount — explicit pick →
    // project default → system), the same immutable contract terminal agent nodes follow.
    st.accountId,
    mode
  )
  const minted = proto.data.agentSessionId
  if (minted) ctx.updateNodeData(st.id, { agentSessionId: minted })
  return prefixLaunchWithCd(proto.data.initialCommand as string, cwd)
}

const PANE_WAIT_MS = 10_000

function waitForPane(ctx: EngineCtx, nodeId: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const started = Date.now()
    const poll = (): void => {
      void ctx.api.pty
        .paneCommand(nodeId)
        .then((pane) => {
          if (pane) return resolve(pane)
          if (Date.now() - started > timeoutMs) return resolve(null)
          setTimeout(poll, 500)
        })
        .catch(() => {
          if (Date.now() - started > timeoutMs) return resolve(null)
          setTimeout(poll, 500)
        })
    }
    poll()
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
 *  (the previous conversation ending) and must not advance anything.
 *
 *  The transition may land while the user is on ANOTHER project (hooks POST by node id and the
 *  tmux session doesn't pause with the tab), so the issue is resolved in its OWNING project —
 *  serialized nodes are authoritative for a non-active project (the PipelineStrip rule) — and
 *  the advance writes THERE. The moved issue starts at its next station when that project is
 *  active again (tick reads live nodes of the active project only). */
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
        const owner = issueOwner(wait.issueId, ctx)
        if (!owner) continue
        const issue = owner.pipeline.issues.find((i) => i.id === wait.issueId)
        if (!issue || issue.atNodeId !== nodeId || issue.status !== 'active') continue
        const edges = liveEdges(owner.pipeline.edges, owner.stations)
        const edge = nextEdge(edges, nodeId)
        advanceIssueIn(
          ctx,
          owner.projectId,
          issue.id,
          edge?.to,
          edge ? 'next' : 'done',
          edge?.id,
          Date.now()
        )
      }
    }
  })
}

/** The project whose pipeline holds the issue, with that project's station view: live React
 *  Flow nodes for the active project, serialized store nodes otherwise. */
function issueOwner(
  issueId: string,
  ctx: EngineCtx
): { projectId: string; stations: Station[]; pipeline: ProjectPipeline } | null {
  for (const p of useProjects.getState().projects) {
    if (!p.pipeline?.issues.some((i) => i.id === issueId)) continue
    return {
      projectId: p.id,
      stations: p.id === ctx.projectId ? ctx.getStations() : stationsOf(p.nodes),
      pipeline: p.pipeline
    }
  }
  return null
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
