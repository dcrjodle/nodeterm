import {
  isPipelineKind,
  isSatelliteKind,
  type CanvasNodeState,
  type ConnectorService,
  type DecisionRule,
  type PipelineEdge,
  type PipelineIssue,
  type PipelineNodeKind,
  type PipelineSatelliteKind
} from '@shared/types'

/**
 * Pure pipeline logic — the deterministic half of the loop factory. Everything here is a
 * function of (nodes, edges, issues); the engine (state/pipeline.ts) is the only place with
 * timers and side effects. See docs/superpowers/specs/2026-08-13-weave-loop-factory.md.
 */

/** The minimal node shape the pipeline reads — satisfied by both CanvasNodeState and the live
 *  React Flow node's (id, kind ≙ type, data) once adapted via `stationOf`. */
export interface Station {
  id: string
  kind: PipelineNodeKind
  title: string
  /** Mirrored as a kanban column? Default true; the node right-click toggles it. */
  kanbanColumn: boolean
  agentId?: string
  /** agent station: managed Claude account, resolved once at creation (immutable). */
  accountId?: string
  cwd?: string
  /** agent station: the session id nodeterm minted at the first CLI launch (persisted on the
   *  node) — the engine's resume fallback when no hook ever delivered one. */
  agentSessionId?: string
  criteria?: string
  rules?: DecisionRule[]
  decisionMode?: 'auto' | 'manual'
  service?: ConnectorService
  envVar?: string
  customLabel?: string
}

/** Adapts a persisted node state to a Station; null for non-pipeline kinds. */
export function stationOf(n: CanvasNodeState): Station | null {
  if (!isPipelineKind(n.kind)) return null
  return {
    id: n.id,
    kind: n.kind,
    title: n.title || 'Untitled',
    kanbanColumn: n.kanbanColumn !== false,
    // Agent stations always run Claude Code — a persisted pre-rework station that chose another
    // CLI is coerced (the picker is gone; nodeStatesToFlow applies the same rule to node data).
    agentId: n.kind === 'agent' ? 'claude' : n.agentId,
    accountId: n.accountId,
    cwd: n.cwd,
    agentSessionId: n.agentSessionId,
    criteria: n.criteria,
    rules: n.rules,
    decisionMode: n.decisionMode,
    service: n.service,
    envVar: n.envVar,
    customLabel: n.customLabel
  }
}

export function stationsOf(nodes: CanvasNodeState[]): Station[] {
  return nodes.map(stationOf).filter((s): s is Station => s !== null)
}

/** A pipeline satellite — an `assignment` or `sandbox` card wired INTO an agent station by a
 *  `cfg-` edge. Config only: never part of the chain, never a kanban column. */
export interface Satellite {
  id: string
  kind: PipelineSatelliteKind
  /** assignment: the standing instructions text. */
  text?: string
  /** sandbox: the folder the station's CLI starts in. */
  cwd?: string
}

export function satelliteOf(n: CanvasNodeState): Satellite | null {
  if (!isSatelliteKind(n.kind)) return null
  return { id: n.id, kind: n.kind, text: n.text, cwd: n.cwd }
}

export function satellitesOf(nodes: CanvasNodeState[]): Satellite[] {
  return nodes.map(satelliteOf).filter((s): s is Satellite => s !== null)
}

/** The satellites wired into `stationId`, in edge array order (= connect order). */
export function satellitesInto(
  stationId: string,
  edges: PipelineEdge[],
  satellites: Satellite[]
): Satellite[] {
  const byId = new Map(satellites.map((s) => [s.id, s]))
  return edges
    .filter((e) => e.to === stationId)
    .map((e) => byId.get(e.from))
    .filter((s): s is Satellite => s !== undefined)
}

/** The folder a station's CLI starts in: the LAST connected sandbox with a folder wins
 *  (onConnect keeps one sandbox edge per station, so "last" only breaks ties among stale data).
 *  Undefined = no sandbox → the caller falls back to the project folder. */
export function sandboxCwdFor(
  stationId: string,
  edges: PipelineEdge[],
  satellites: Satellite[]
): string | undefined {
  const boxes = satellitesInto(stationId, edges, satellites).filter(
    (s) => s.kind === 'sandbox' && s.cwd?.trim()
  )
  return boxes.length ? boxes[boxes.length - 1].cwd : undefined
}

/** A station's standing assignment: every connected assignment card's text, in connect order. */
export function assignmentTextFor(
  stationId: string,
  edges: PipelineEdge[],
  satellites: Satellite[]
): string {
  return satellitesInto(stationId, edges, satellites)
    .filter((s) => s.kind === 'assignment')
    .map((s) => s.text?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n')
}

/** The one deterministic message that carries a station's assignment into its CLI. Used as the
 *  launch's initial prompt (fresh start) and as the one-shot push when an assignment card is
 *  connected to an already-running station. Empty assignment → empty string (nothing owed). */
export function composeAssignmentPrompt(text: string): string {
  const t = text.trim()
  if (!t) return ''
  return `Standing assignment for this station (context for every issue that follows — acknowledge briefly and wait for work):\n\n${t}`
}

/** Drops edges whose endpoints are no longer pipeline stations (deleted / re-kinded nodes). */
export function liveEdges(edges: PipelineEdge[], stations: Station[]): PipelineEdge[] {
  const ids = new Set(stations.map((s) => s.id))
  return edges.filter((e) => ids.has(e.from) && ids.has(e.to))
}

/**
 * The chain order: a stable walk of the pipeline graph, used by the kanban column strip and
 * the sessions sidebar. Starts from every station with no incoming edge (canvas order breaks
 * ties), follows outgoing edges in array order, and visits each station once — so cycles (the
 * whole point of a loop) terminate, and disconnected stations append in canvas order.
 */
export function chainOrder(stations: Station[], edges: PipelineEdge[]): Station[] {
  const live = liveEdges(edges, stations)
  const byId = new Map(stations.map((s) => [s.id, s]))
  const hasIncoming = new Set(live.map((e) => e.to))
  const hasOutgoing = new Set(live.map((e) => e.from))
  // Chain heads (no incoming, at least one outgoing) lead; isolated stations follow in canvas
  // order — a lone unconnected station must not displace the chain's first column.
  const heads = stations.filter((s) => !hasIncoming.has(s.id) && hasOutgoing.has(s.id))
  const seen = new Set<string>()
  const out: Station[] = []
  const visit = (id: string) => {
    if (seen.has(id)) return
    const s = byId.get(id)
    if (!s) return
    seen.add(id)
    out.push(s)
    for (const e of live) if (e.from === id) visit(e.to)
  }
  for (const h of heads) visit(h.id)
  for (const s of stations) if (hasIncoming.has(s.id) || hasOutgoing.has(s.id)) visit(s.id)
  for (const s of stations) visit(s.id)
  return out
}

/** The station a fresh issue enters: the first station in chain order (undefined = no pipeline). */
export function firstStation(stations: Station[], edges: PipelineEdge[]): Station | undefined {
  return chainOrder(stations, edges)[0]
}

export function outgoing(edges: PipelineEdge[], nodeId: string): PipelineEdge[] {
  return edges.filter((e) => e.from === nodeId)
}

/** The default forward edge out of a station: the first unlabeled outgoing edge, else the
 *  first outgoing edge at all (a lone labeled branch still counts as "next"). */
export function nextEdge(edges: PipelineEdge[], nodeId: string): PipelineEdge | undefined {
  const out = outgoing(edges, nodeId)
  return out.find((e) => !e.label) ?? out[0]
}

/** Where the issue came from: the last history hop for a DIFFERENT station (skips re-entries). */
export function previousStationId(issue: PipelineIssue, currentId: string): string | undefined {
  for (let i = issue.history.length - 1; i >= 0; i--) {
    const hop = issue.history[i]
    if (hop.nodeId !== currentId) return hop.nodeId
  }
  return undefined
}

export type DecisionRoute =
  | { kind: 'next'; edge: PipelineEdge }
  | { kind: 'back'; toNodeId: string }
  | { kind: 'branch'; edge: PipelineEdge; label: string }
  | { kind: 'wait'; reason: 'manual' | 'no-rule' | 'no-route' }

/**
 * Deterministic decision routing. First rule whose `match` is a case-insensitive substring of
 * the issue's title+body+notes wins:
 *   - route 'next'  → the default forward edge
 *   - route 'back'  → the station the issue came from (history)
 *   - anything else → the outgoing edge whose LABEL matches, else whose TARGET STATION TITLE
 *     matches (case-insensitive) — titles are what the user sees on the card
 * No matching rule → 'next' when a forward edge exists (mode 'auto'), else wait.
 * Mode 'manual' always waits for a human route.
 */
export function resolveDecision(
  station: Station,
  issue: PipelineIssue,
  edges: PipelineEdge[],
  stations: Station[]
): DecisionRoute {
  if ((station.decisionMode ?? 'auto') === 'manual') return { kind: 'wait', reason: 'manual' }
  const hay = `${issue.title}\n${issue.body}\n${issue.notes}`.toLowerCase()
  const rules = station.rules ?? []
  const matched = rules.find((r) => r.match.trim() && hay.includes(r.match.trim().toLowerCase()))
  const route = matched?.route
  if (!route || route === 'next') {
    // 'auto' with no matching rule falls forward — a decision that cannot decide must not
    // silently swallow the issue.
    const edge = nextEdge(edges, station.id)
    return edge ? { kind: 'next', edge } : { kind: 'wait', reason: matched ? 'no-route' : 'no-rule' }
  }
  if (route === 'back') {
    const prev = previousStationId(issue, station.id)
    return prev ? { kind: 'back', toNodeId: prev } : { kind: 'wait', reason: 'no-route' }
  }
  const want = route.trim().toLowerCase()
  const byTitle = new Map(stations.map((s) => [s.title.trim().toLowerCase(), s.id]))
  const edge = outgoing(edges, station.id).find(
    (e) => e.label?.trim().toLowerCase() === want || byTitle.get(want) === e.to
  )
  return edge
    ? { kind: 'branch', edge, label: route }
    : { kind: 'wait', reason: 'no-route' }
}

/** Issues never hop more than this many times — a mis-wired always-back loop must surface as a
 *  WAITING issue with a loop-limit note, never spin forever. */
export const MAX_ISSUE_HOPS = 50

// ---- Kanban mirroring -------------------------------------------------------------------------

export const ISSUE_COLUMN_PREFIX = 'pipe:'
export const ISSUE_QUEUE_COLUMN = 'pipe:queue'
export const ISSUE_DONE_COLUMN = 'pipe:done'

export interface IssueColumn {
  id: string
  title: string
  /** The station this column mirrors; undefined for the standing Queue / Done columns. */
  nodeId?: string
  kind?: PipelineNodeKind
}

/** Derived at render time, never persisted — the stations ARE the columns, so the two views
 *  cannot drift (same rule as the session board's Ungrouped column). */
export function issueColumns(stations: Station[], edges: PipelineEdge[]): IssueColumn[] {
  const chain = chainOrder(stations, edges).filter((s) => s.kanbanColumn)
  return [
    { id: ISSUE_QUEUE_COLUMN, title: 'Queue' },
    ...chain.map((s) => ({
      id: `${ISSUE_COLUMN_PREFIX}${s.id}`,
      title: s.title,
      nodeId: s.id,
      kind: s.kind
    })),
    { id: ISSUE_DONE_COLUMN, title: 'Done' }
  ]
}

/** Which issue column an issue renders in. A station with its column toggled off maps to the
 *  nearest surviving upstream column in chain order (fallback: Queue). */
export function issueColumnId(
  issue: PipelineIssue,
  stations: Station[],
  edges: PipelineEdge[]
): string {
  if (issue.status === 'done') return ISSUE_DONE_COLUMN
  if (!issue.atNodeId) return ISSUE_QUEUE_COLUMN
  const chain = chainOrder(stations, edges)
  const idx = chain.findIndex((s) => s.id === issue.atNodeId)
  if (idx === -1) return ISSUE_QUEUE_COLUMN
  for (let i = idx; i >= 0; i--) {
    if (chain[i].kanbanColumn) return `${ISSUE_COLUMN_PREFIX}${chain[i].id}`
  }
  return ISSUE_QUEUE_COLUMN
}

// ---- Prompt composition -------------------------------------------------------------------------

/** Connector stations upstream of `nodeId` (walking edges backwards, each visited once) —
 *  the integrations whose context an agent prompt carries. */
export function upstreamConnectors(
  nodeId: string,
  stations: Station[],
  edges: PipelineEdge[]
): Station[] {
  const live = liveEdges(edges, stations)
  const byId = new Map(stations.map((s) => [s.id, s]))
  const seen = new Set<string>()
  const found: Station[] = []
  const visit = (id: string) => {
    if (seen.has(id)) return
    seen.add(id)
    for (const e of live) {
      if (e.to !== id) continue
      const from = byId.get(e.from)
      if (!from) continue
      if (from.kind === 'connector') found.push(from)
      visit(e.from)
    }
  }
  visit(nodeId)
  return found
}

export function connectorContextLine(c: Station): string {
  const name = c.service === 'custom' ? c.customLabel || c.title : (c.service ?? c.title)
  const auth =
    c.envVar && c.envVar.trim()
      ? `api key in env var ${c.envVar.trim()} (never print its value)`
      : 'authenticated via its CLI/oauth on this machine'
  return `- ${name}: ${auth}`
}

/** The ONE deterministic prompt an agent station receives per issue. Composition, not
 *  generation: same issue + same station config = byte-identical prompt. The station's standing
 *  assignment is deliberately NOT here — it is delivered once, when the CLI starts
 *  (`composeAssignmentPrompt`), so every issue prompt stays lean. */
export function composeIssuePrompt(
  issue: PipelineIssue,
  station: Station,
  connectors: Station[]
): string {
  const parts: string[] = [`[nodeterm issue ${issue.id.slice(-6)}] ${issue.title}`]
  if (issue.body.trim()) parts.push(issue.body.trim())
  if (issue.notes.trim()) parts.push(`Notes so far:\n${issue.notes.trim()}`)
  if (connectors.length)
    parts.push(`Available connectors:\n${connectors.map(connectorContextLine).join('\n')}`)
  parts.push('When you are done, summarize what you did in one line.')
  return parts.join('\n\n')
}

// ---- Issue transforms (pure; the store wraps them in set()) -------------------------------------

let issueSeq = 0

export function newIssue(title: string, body: string, now: number): PipelineIssue {
  issueSeq = (issueSeq + 1) % 1000
  return {
    id: `iss-${now.toString(36)}-${issueSeq.toString(36)}`,
    title: title.trim() || 'Untitled issue',
    body,
    notes: '',
    status: 'queued',
    history: [],
    createdAt: now
  }
}

/** Moves an issue to a station (or to done with nodeId undefined), closing the open hop. */
export function issueMovedTo(
  issue: PipelineIssue,
  nodeId: string | undefined,
  route: string,
  now: number
): PipelineIssue {
  const history = issue.history.map((h, i) =>
    i === issue.history.length - 1 && h.leftAt === undefined ? { ...h, leftAt: now, route } : h
  )
  if (nodeId === undefined) {
    return { ...issue, status: 'done', atNodeId: undefined, history }
  }
  return {
    ...issue,
    status: 'queued',
    atNodeId: nodeId,
    history: [...history, { nodeId, enteredAt: now }]
  }
}

export function hopCount(issue: PipelineIssue): number {
  return issue.history.length
}
