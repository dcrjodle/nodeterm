import { describe, expect, it } from 'vitest'
import type { CanvasNodeState, PipelineEdge, PipelineIssue } from '@shared/types'
import {
  assignmentTextFor,
  chainOrder,
  composeAssignmentPrompt,
  composeIssuePrompt,
  firstStation,
  issueColumnId,
  issueColumns,
  issueMovedTo,
  newIssue,
  nextEdge,
  resolveDecision,
  sandboxCwdFor,
  satellitesOf,
  stationOf,
  stationsOf,
  upstreamConnectors,
  type Satellite,
  type Station
} from './pipeline'

const station = (id: string, over: Partial<Station> = {}): Station => ({
  id,
  kind: 'agent',
  title: id,
  kanbanColumn: true,
  ...over
})

const edge = (from: string, to: string, label?: string): PipelineEdge => ({
  id: `pipe-${from}-${to}${label ? `-${label}` : ''}`,
  from,
  to,
  ...(label ? { label } : {})
})

const issueAt = (atNodeId: string | undefined, over: Partial<PipelineIssue> = {}): PipelineIssue => ({
  id: 'iss-t-1',
  title: 'Fix the login bug',
  body: 'Users cannot log in with SSO.',
  notes: '',
  status: atNodeId ? 'active' : 'queued',
  atNodeId,
  history: atNodeId ? [{ nodeId: atNodeId, enteredAt: 1 }] : [],
  createdAt: 1,
  ...over
})

describe('stationOf', () => {
  it('adapts pipeline kinds and rejects everything else', () => {
    const agent = {
      id: 'a1',
      kind: 'agent',
      position: { x: 0, y: 0 },
      size: { width: 1, height: 1 },
      title: 'Builder',
      color: '#fff',
      group: null,
      agentId: 'claude'
    } as CanvasNodeState
    expect(stationOf(agent)?.kind).toBe('agent')
    expect(stationOf({ ...agent, kind: 'terminal' } as CanvasNodeState)).toBeNull()
  })

  it('carries the managed account through to the engine (resolved once at creation)', () => {
    const agent = {
      id: 'a1',
      kind: 'agent',
      position: { x: 0, y: 0 },
      size: { width: 1, height: 1 },
      title: 'Builder',
      color: '#fff',
      group: null,
      agentId: 'claude',
      accountId: 'acct-1'
    } as CanvasNodeState
    expect(stationOf(agent)?.accountId).toBe('acct-1')
  })

  it('defaults kanbanColumn to true and keeps an explicit false', () => {
    const base = {
      id: 'a1',
      kind: 'decision',
      position: { x: 0, y: 0 },
      size: { width: 1, height: 1 },
      title: '',
      color: '#fff',
      group: null
    } as CanvasNodeState
    expect(stationOf(base)?.kanbanColumn).toBe(true)
    expect(stationOf({ ...base, kanbanColumn: false })?.kanbanColumn).toBe(false)
    // An empty title still labels its column.
    expect(stationOf(base)?.title).toBe('Untitled')
  })
})

describe('chainOrder', () => {
  it('walks a linear chain from the root', () => {
    const s = [station('b'), station('a'), station('c')]
    const e = [edge('a', 'b'), edge('b', 'c')]
    expect(chainOrder(s, e).map((x) => x.id)).toEqual(['a', 'b', 'c'])
  })

  it('terminates on cycles — the loop is the point', () => {
    const s = [station('a'), station('b'), station('c')]
    const e = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')]
    // Pure cycle: no root, so canvas order seeds the walk.
    expect(chainOrder(s, e).map((x) => x.id)).toEqual(['a', 'b', 'c'])
  })

  it('appends disconnected stations in canvas order', () => {
    const s = [station('lone'), station('a'), station('b')]
    const e = [edge('a', 'b')]
    expect(chainOrder(s, e).map((x) => x.id)).toEqual(['a', 'b', 'lone'])
  })

  it('ignores edges to deleted stations', () => {
    const s = [station('a')]
    const e = [edge('a', 'ghost')]
    expect(chainOrder(s, e).map((x) => x.id)).toEqual(['a'])
    expect(firstStation(s, e)?.id).toBe('a')
  })
})

describe('resolveDecision', () => {
  const stations = [
    station('d', { kind: 'decision', rules: [{ match: 'sso', route: 'Escalate' }] }),
    station('next-st'),
    station('Escalate')
  ]
  const edges = [edge('d', 'next-st'), edge('d', 'Escalate', 'escalate')]

  it('routes the first matching rule to the branch named by edge label or target title', () => {
    const r = resolveDecision(stations[0], issueAt('d'), edges, stations)
    expect(r.kind).toBe('branch')
    if (r.kind === 'branch') expect(r.edge.to).toBe('Escalate')
  })

  it('matches branch routes by edge label too', () => {
    const s = [station('d', { kind: 'decision', rules: [{ match: 'sso', route: 'escalate' }] }), ...stations.slice(1)]
    const r = resolveDecision(s[0], issueAt('d'), edges, s)
    expect(r.kind).toBe('branch')
  })

  it('falls forward on no matching rule (auto)', () => {
    const clean = issueAt('d', { title: 'Tune the cache', body: '', notes: '' })
    const r = resolveDecision(stations[0], clean, edges, stations)
    expect(r.kind).toBe('next')
    if (r.kind === 'next') expect(r.edge.to).toBe('next-st')
  })

  it('routes back to the previous station from history', () => {
    const d = station('d', { kind: 'decision', rules: [{ match: 'sso', route: 'back' }] })
    const iss = issueAt('d', {
      history: [
        { nodeId: 'builder', enteredAt: 1, leftAt: 2, route: 'next' },
        { nodeId: 'd', enteredAt: 2 }
      ]
    })
    const r = resolveDecision(d, iss, edges, stations)
    expect(r).toEqual({ kind: 'back', toNodeId: 'builder' })
  })

  it('waits in manual mode, on a dead-end route, and on back-with-no-history', () => {
    const manual = station('d', { kind: 'decision', decisionMode: 'manual' })
    expect(resolveDecision(manual, issueAt('d'), edges, stations).kind).toBe('wait')
    const dead = station('d', { kind: 'decision', rules: [{ match: 'sso', route: 'Nowhere' }] })
    expect(resolveDecision(dead, issueAt('d'), edges, stations)).toEqual({
      kind: 'wait',
      reason: 'no-route'
    })
    const back = station('d', { kind: 'decision', rules: [{ match: 'sso', route: 'back' }] })
    expect(resolveDecision(back, issueAt('d'), edges, stations).kind).toBe('wait')
  })

  it('waits rather than falling forward when there is no outgoing edge at all', () => {
    const d = station('end', { kind: 'decision' })
    expect(resolveDecision(d, issueAt('end'), [], [d]).kind).toBe('wait')
  })
})

describe('issue columns', () => {
  const stations = [
    station('a', { title: 'Build' }),
    station('d', { kind: 'decision', title: 'Review' }),
    station('c', { kind: 'connector', title: 'GitHub' })
  ]
  const edges = [edge('a', 'd'), edge('d', 'c')]

  it('derives Queue + one column per station in chain order + Done', () => {
    expect(issueColumns(stations, edges).map((c) => c.title)).toEqual([
      'Queue',
      'Build',
      'Review',
      'GitHub',
      'Done'
    ])
  })

  it('omits stations whose column is toggled off and remaps their issues upstream', () => {
    const toggled = [station('a', { title: 'Build' }), station('d', { kind: 'decision', title: 'Review', kanbanColumn: false }), stations[2]]
    expect(issueColumns(toggled, edges).map((c) => c.title)).toEqual([
      'Queue',
      'Build',
      'GitHub',
      'Done'
    ])
    expect(issueColumnId(issueAt('d'), toggled, edges)).toBe('pipe:a')
  })

  it('maps done → Done, unplaced/unknown → Queue', () => {
    expect(issueColumnId(issueAt(undefined), stations, edges)).toBe('pipe:queue')
    expect(issueColumnId(issueAt('ghost'), stations, edges)).toBe('pipe:queue')
    expect(issueColumnId(issueAt('a', { status: 'done', atNodeId: undefined }), stations, edges)).toBe(
      'pipe:done'
    )
  })
})

describe('prompt composition', () => {
  it('is deterministic and carries connector context (names only) — never the assignment', () => {
    const stations = [
      station('gh', { kind: 'connector', service: 'github' }),
      station('slack', { kind: 'connector', service: 'slack', envVar: 'SLACK_TOKEN' }),
      station('a')
    ]
    const edges = [edge('gh', 'slack'), edge('slack', 'a')]
    const ups = upstreamConnectors('a', stations, edges)
    expect(ups.map((c) => c.service)).toEqual(['slack', 'github'])
    const p1 = composeIssuePrompt(issueAt('a'), stations[2], ups)
    const p2 = composeIssuePrompt(issueAt('a'), stations[2], ups)
    expect(p1).toBe(p2)
    // The assignment is delivered ONCE, when the station's CLI starts (composeAssignmentPrompt)
    // — issue prompts stay lean.
    expect(p1).not.toContain('Assignment')
    expect(p1).toContain('SLACK_TOKEN')
    expect(p1).toContain('never print its value')
    expect(p1).toContain('summarize what you did in one line')
  })

  it('composeAssignmentPrompt frames the text and stays empty for an empty assignment', () => {
    expect(composeAssignmentPrompt('')).toBe('')
    expect(composeAssignmentPrompt('   \n ')).toBe('')
    const p = composeAssignmentPrompt('Fix bugs. Never push to main.')
    expect(p).toContain('Standing assignment')
    expect(p).toContain('Fix bugs. Never push to main.')
  })
})

describe('satellites (assignment / sandbox config)', () => {
  const sat = (id: string, over: Partial<Satellite> = {}): CanvasNodeState =>
    ({
      id,
      kind: over.kind ?? 'assignment',
      position: { x: 0, y: 0 },
      size: { width: 1, height: 1 },
      title: id,
      color: '',
      group: null,
      text: over.text,
      cwd: over.cwd
    }) as CanvasNodeState

  const cfg = (from: string, to: string): PipelineEdge => ({ id: `cfg-${from}-${to}`, from, to })

  it('satellitesOf keeps only assignment/sandbox kinds', () => {
    const nodes = [
      sat('a1'),
      sat('s1', { kind: 'sandbox', cwd: '/work' }),
      { id: 't', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, title: 't', color: '', group: null } as CanvasNodeState
    ]
    expect(satellitesOf(nodes).map((s) => s.id)).toEqual(['a1', 's1'])
  })

  it('sandboxCwdFor picks the connected sandbox and ignores blank/unconnected ones', () => {
    const sats = satellitesOf([
      sat('empty', { kind: 'sandbox', cwd: '  ' }),
      sat('box', { kind: 'sandbox', cwd: '/work/repo' }),
      sat('other', { kind: 'sandbox', cwd: '/elsewhere' })
    ])
    const edges = [cfg('empty', 'st'), cfg('box', 'st'), cfg('other', 'OTHER-STATION')]
    expect(sandboxCwdFor('st', edges, sats)).toBe('/work/repo')
    expect(sandboxCwdFor('st', [], sats)).toBeUndefined()
  })

  it('assignmentTextFor joins connected assignment cards in connect order', () => {
    const sats = satellitesOf([
      sat('a1', { text: 'First.' }),
      sat('a2', { text: '  ' }),
      sat('a3', { text: 'Second.' }),
      sat('box', { kind: 'sandbox', cwd: '/x' })
    ])
    const edges = [cfg('a3', 'st'), cfg('a1', 'st'), cfg('a2', 'st'), cfg('box', 'st')]
    expect(assignmentTextFor('st', edges, sats)).toBe('Second.\n\nFirst.')
    expect(assignmentTextFor('st', [], sats)).toBe('')
  })

  it('stationOf coerces every agent station to claude (the CLI picker is gone)', () => {
    const node = {
      id: 'st',
      kind: 'agent',
      position: { x: 0, y: 0 },
      size: { width: 1, height: 1 },
      title: 'st',
      color: '',
      group: null,
      agentId: 'codex'
    } as CanvasNodeState
    expect(stationOf(node)?.agentId).toBe('claude')
  })
})

describe('issue transforms', () => {
  it('newIssue defaults a blank title and starts queued with no station', () => {
    const i = newIssue('  ', 'body', 42)
    expect(i.title).toBe('Untitled issue')
    expect(i.status).toBe('queued')
    expect(i.atNodeId).toBeUndefined()
    expect(i.history).toEqual([])
  })

  it('issueMovedTo closes the open hop and opens the next; undefined target = done', () => {
    const start = issueMovedTo(issueAt(undefined), 'a', 'queued', 10)
    expect(start.atNodeId).toBe('a')
    expect(start.history).toEqual([{ nodeId: 'a', enteredAt: 10 }])
    const moved = issueMovedTo(start, 'b', 'next', 20)
    expect(moved.history).toEqual([
      { nodeId: 'a', enteredAt: 10, leftAt: 20, route: 'next' },
      { nodeId: 'b', enteredAt: 20 }
    ])
    const done = issueMovedTo(moved, undefined, 'done', 30)
    expect(done.status).toBe('done')
    expect(done.atNodeId).toBeUndefined()
    expect(done.history[1]).toEqual({ nodeId: 'b', enteredAt: 20, leftAt: 30, route: 'done' })
  })

  it('stationsOf filters mixed node lists', () => {
    const nodes = [
      { id: 't', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, title: 't', color: '', group: null },
      { id: 'a', kind: 'agent', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, title: 'a', color: '', group: null }
    ] as CanvasNodeState[]
    expect(stationsOf(nodes).map((s) => s.id)).toEqual(['a'])
  })

  it('nextEdge prefers the unlabeled forward edge', () => {
    const e = [edge('a', 'x', 'branch'), edge('a', 'b')]
    expect(nextEdge(e, 'a')?.to).toBe('b')
    expect(nextEdge([edge('a', 'x', 'only')], 'a')?.to).toBe('x')
  })
})
