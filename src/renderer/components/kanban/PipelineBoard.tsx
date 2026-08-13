import { useMemo, useState } from 'react'
import type { PipelineIssue } from '@shared/types'
import { useProjects } from '../../state/projects'
import {
  addIssue,
  advanceIssueManually,
  deleteIssue,
  engineCtx,
  moveIssueManually,
  routeWaitingIssue,
  updateIssue
} from '../../state/pipeline'
import {
  ISSUE_DONE_COLUMN,
  ISSUE_QUEUE_COLUMN,
  chainOrder,
  issueColumnId,
  issueColumns,
  liveEdges,
  nextEdge,
  stationsOf,
  type Station
} from '../../lib/pipeline'
import { promptDialog } from '../promptDialog'

/**
 * The loop-factory strip of the board: Queue → one column per chained station → Done, with
 * ISSUE cards flowing left to right (and back — loops are the point). Fully self-contained:
 * reads the live station list through the engine context Canvas publishes, issues/edges from
 * the projects store, and every mutation goes through the engine's actions, so the canvas
 * badges, the board and the engine can never disagree.
 */

const STATION_GLYPHS: Record<string, string> = { agent: '▣', decision: '◇', connector: '⬡' }

const STATUS_LABEL: Record<PipelineIssue['status'], string> = {
  queued: 'Queued',
  active: 'Active',
  waiting: 'Waiting',
  done: 'Done'
}

export function PipelineBoard({ onFocusNode }: { onFocusNode: (nodeId: string) => void }): JSX.Element | null {
  // Re-render on any pipeline change (edges/issues) — a cheap primitive signature.
  const sig = useProjects((s) => {
    const p = s.projects.find((x) => x.id === s.activeProjectId)?.pipeline
    if (!p) return ''
    return `${p.edges.map((e) => e.id).join(',')}#${p.issues
      .map((i) => `${i.id}@${i.atNodeId ?? ''}:${i.status}:${i.title}`)
      .join(',')}`
  })
  const [modalIssueId, setModalIssueId] = useState<string | null>(null)
  const [dragIssueId, setDragIssueId] = useState<string | null>(null)
  const [dropCol, setDropCol] = useState<string | null>(null)

  const ctx = engineCtx()
  const derived = useMemo(() => {
    if (!ctx) return null
    const stations = ctx.getStations()
    if (!stations.length) return null
    const store = useProjects.getState()
    const pipeline = store.getProject(ctx.projectId)?.pipeline ?? { edges: [], issues: [] }
    const cols = issueColumns(stations, pipeline.edges)
    const cards = new Map<string, PipelineIssue[]>()
    for (const i of pipeline.issues) {
      const col = issueColumnId(i, stations, pipeline.edges)
      const list = cards.get(col) ?? []
      list.push(i)
      cards.set(col, list)
    }
    return { stations, pipeline, cols, cards }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, sig])

  if (!ctx || !derived) return null
  const { stations, pipeline, cols, cards } = derived

  const dropTarget = (colId: string): string | 'done' | 'queue' | null => {
    if (colId === ISSUE_DONE_COLUMN) return 'done'
    if (colId === ISSUE_QUEUE_COLUMN) return 'queue'
    const nodeId = cols.find((c) => c.id === colId)?.nodeId
    return nodeId ?? null
  }

  const newIssueAt = async (colId: string): Promise<void> => {
    const title = await promptDialog({ message: 'New issue — one line describing the work:' })
    if (!title?.trim()) return
    const nodeId = cols.find((c) => c.id === colId)?.nodeId
    addIssue(ctx, { title: title.trim(), ...(nodeId ? { atNodeId: nodeId } : {}) })
  }

  const modalIssue = modalIssueId ? pipeline.issues.find((i) => i.id === modalIssueId) : undefined

  return (
    <div className="pipe-board">
      <div className="pipe-board__title">
        <span className="pipe-board__badge">LOOP</span>
        Issues flow Queue → stations → Done; decisions can send them back.
      </div>
      <div className="pipe-board__columns">
        {cols.map((col) => {
          const list = cards.get(col.id) ?? []
          return (
            <div
              key={col.id}
              className={`pipe-col${dropCol === col.id ? ' is-drop' : ''}`}
              onDragOver={(e) => {
                if (!dragIssueId) return
                e.preventDefault()
                if (dropCol !== col.id) setDropCol(col.id)
              }}
              onDragLeave={() => setDropCol((c) => (c === col.id ? null : c))}
              onDrop={(e) => {
                e.preventDefault()
                setDropCol(null)
                const target = dropTarget(col.id)
                if (dragIssueId && target) moveIssueManually(ctx, dragIssueId, target)
                setDragIssueId(null)
              }}
            >
              <div
                className="pipe-col__head"
                onClick={() => col.nodeId && onFocusNode(col.nodeId)}
                title={col.nodeId ? 'Show this station on the canvas' : undefined}
              >
                {col.kind && <span className="pipe-col__glyph">{STATION_GLYPHS[col.kind]}</span>}
                <span className="pipe-col__name">{col.title}</span>
                <span className="pipe-col__count">{list.length}</span>
              </div>
              <div className="pipe-col__cards">
                {list.map((i) => (
                  <div
                    key={i.id}
                    className={`pipe-card pipe-card--${i.status}`}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move'
                      setDragIssueId(i.id)
                    }}
                    onDragEnd={() => {
                      setDragIssueId(null)
                      setDropCol(null)
                    }}
                    onClick={() => setModalIssueId(i.id)}
                  >
                    <div className="pipe-card__title">{i.title}</div>
                    <div className="pipe-card__meta">
                      <span className={`pipe-card__status pipe-card__status--${i.status}`}>
                        {i.status === 'active' && <span className="pipe-card__spin" />}
                        {STATUS_LABEL[i.status]}
                      </span>
                      {i.history.length > 1 && (
                        <span className="pipe-card__hops">{i.history.length} hops</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {col.id !== ISSUE_DONE_COLUMN && (
                <button className="pipe-col__add" onClick={() => void newIssueAt(col.id)}>
                  + Add issue
                </button>
              )}
            </div>
          )
        })}
      </div>
      {modalIssue && (
        <IssueModal
          issue={modalIssue}
          stations={stations}
          edges={pipeline.edges}
          onClose={() => setModalIssueId(null)}
          onFocusNode={onFocusNode}
        />
      )}
    </div>
  )
}

function IssueModal({
  issue,
  stations,
  edges,
  onClose,
  onFocusNode
}: {
  issue: PipelineIssue
  stations: Station[]
  edges: { id: string; from: string; to: string; label?: string }[]
  onClose: () => void
  onFocusNode: (nodeId: string) => void
}): JSX.Element {
  const ctx = engineCtx()
  const titleOf = (nodeId: string): string =>
    stations.find((s) => s.id === nodeId)?.title ?? 'deleted station'
  const atStation = issue.atNodeId ? stations.find((s) => s.id === issue.atNodeId) : undefined
  const live = liveEdges(edges, stations)
  const routes: string[] = []
  if (issue.status === 'waiting' && issue.atNodeId) {
    if (nextEdge(live, issue.atNodeId)) routes.push('next')
    routes.push('back')
    const byId = new Map(stations.map((s) => [s.id, s.title]))
    for (const e of live.filter((e) => e.from === issue.atNodeId)) {
      const label = e.label || byId.get(e.to) || ''
      if (label && label !== 'next' && !routes.includes(label)) routes.push(label)
    }
  }
  const chain = chainOrder(stations, edges)
  return (
    <div className="issue-modal__scrim" onClick={onClose}>
      <div className="issue-modal" onClick={(e) => e.stopPropagation()}>
        <div className="issue-modal__head">
          <input
            className="issue-modal__title"
            defaultValue={issue.title}
            onBlur={(e) => ctx && updateIssue(ctx, issue.id, { title: e.currentTarget.value.trim() || issue.title })}
          />
          <span className={`pipe-card__status pipe-card__status--${issue.status}`}>
            {STATUS_LABEL[issue.status]}
            {atStation ? ` · ${atStation.title}` : ''}
          </span>
          <button className="issue-modal__close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="issue-modal__body">
          <label className="station__label">description</label>
          <textarea
            className="issue-modal__text"
            defaultValue={issue.body}
            placeholder="What needs to happen — injected into the agent prompt with the title."
            onBlur={(e) => ctx && updateIssue(ctx, issue.id, { body: e.currentTarget.value })}
          />
          <label className="station__label">notes</label>
          <textarea
            className="issue-modal__text issue-modal__text--notes"
            defaultValue={issue.notes}
            placeholder="Anything decisions should route on — rules match title + description + notes."
            onBlur={(e) => ctx && updateIssue(ctx, issue.id, { notes: e.currentTarget.value })}
          />
          {routes.length > 0 && (
            <div className="issue-modal__routes">
              <label className="station__label">waiting — route it</label>
              <div className="station__row station__row--wrap">
                {routes.map((r) => (
                  <button
                    key={r}
                    className="station__btn station__btn--route"
                    onClick={() => {
                      if (ctx) routeWaitingIssue(ctx, issue.id, r)
                      onClose()
                    }}
                  >
                    {r === 'next' ? '⏭ next' : r === 'back' ? '↩ back' : r}
                  </button>
                ))}
              </div>
            </div>
          )}
          <label className="station__label">journey</label>
          <div className="issue-modal__history">
            {issue.history.length === 0 && <span className="station__hint">Not started yet.</span>}
            {issue.history.map((h, k) => (
              <div key={k} className="issue-modal__hop">
                <button className="issue-modal__hop-name" onClick={() => onFocusNode(h.nodeId)}>
                  {titleOf(h.nodeId)}
                </button>
                <span className="issue-modal__hop-time">
                  {new Date(h.enteredAt).toLocaleTimeString()}
                  {h.route ? ` → ${h.route}` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="issue-modal__actions">
          {issue.status !== 'done' && (
            <button
              className="station__btn"
              title="Move this issue along its next edge now"
              onClick={() => ctx && advanceIssueManually(ctx, issue.id)}
            >
              ⏭ Advance
            </button>
          )}
          <select
            className="station__select"
            value=""
            onChange={(e) => {
              if (!ctx || !e.target.value) return
              moveIssueManually(ctx, issue.id, e.target.value)
            }}
          >
            <option value="">Move to…</option>
            <option value="queue">Queue</option>
            {chain.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
            <option value="done">Done</option>
          </select>
          <button
            className="station__btn issue-modal__delete"
            onClick={() => {
              if (ctx) deleteIssue(ctx, issue.id)
              onClose()
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
