import { Handle, NodeResizer, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import type { CanvasNode } from '../state/workspace'
import { useSession } from '../session/session'

/**
 * Pipeline satellites: free-floating config cards wired INTO an agent station by dragging their
 * right-hand port onto the station's top `cfg-in` port (a persisted `cfg-` edge on
 * project.pipeline). Pure config — no session, no engine side effects here:
 *  - assignment: standing instructions, delivered when the station's CLI starts (or pushed
 *    once when connected to a station whose CLI is already running).
 *  - sandbox: the folder the station's CLI starts in (no sandbox → the project folder).
 * They reuse the station card CSS (`.station--assignment` / `.station--sandbox` accents).
 */

const SATELLITE_GLYPHS = { assignment: '✎', sandbox: '▤' } as const

function SatelliteShell({
  id,
  kind,
  data,
  selected,
  minWidth,
  minHeight,
  children
}: {
  id: string
  kind: 'assignment' | 'sandbox'
  data: CanvasNode['data']
  selected?: boolean
  minWidth: number
  minHeight: number
  children: React.ReactNode
}): React.JSX.Element {
  const { deleteElements } = useReactFlow()
  return (
    <div className={`station station--${kind}${selected ? ' selected' : ''}`}>
      <NodeResizer minWidth={minWidth} minHeight={minHeight} isVisible={!!selected} lineStyle={{ opacity: 0 }} />
      <Handle
        id="cfg-out"
        type="source"
        position={Position.Right}
        className="pipe-handle pipe-handle--cfg"
      />
      <div className="station__header">
        <span className="station__glyph" style={{ color: data.color as string }}>
          {SATELLITE_GLYPHS[kind]}
        </span>
        <span className="station__title">{(data.title as string) || 'Untitled'}</span>
        <button
          className="station__close nodrag"
          title={`Delete ${kind}`}
          // No session behind a satellite, so React Flow's ordinary delete is enough — the
          // engine's prunePipeline drops its cfg edges on the next tick.
          onClick={() => void deleteElements({ nodes: [{ id }] })}
        >
          ×
        </button>
      </div>
      {children}
    </div>
  )
}

export function AssignmentNode({ id, data, selected }: NodeProps<CanvasNode>): React.JSX.Element {
  const { updateNodeData } = useReactFlow()
  return (
    <SatelliteShell id={id} kind="assignment" data={data} selected={selected} minWidth={220} minHeight={140}>
      <div className="station__body nodrag">
        <div className="station__block station__block--grow">
          <textarea
            className="station__text nowheel"
            placeholder="Standing instructions for the connected agent station — delivered as context when its Claude CLI starts…"
            value={(data.text as string) ?? ''}
            onChange={(e) => updateNodeData(id, { text: e.target.value })}
          />
        </div>
      </div>
    </SatelliteShell>
  )
}

export function SandboxNode({ id, data, selected }: NodeProps<CanvasNode>): React.JSX.Element {
  const { updateNodeData } = useReactFlow()
  const { api } = useSession()
  const cwd = (data.cwd as string) ?? ''
  const shortCwd = cwd ? cwd.replace(/^\/(Users|home)\/[^/]+/, '~') : 'No folder chosen'
  const pickFolder = async (): Promise<void> => {
    const dir = await api.dialog.selectFolder()
    if (dir) updateNodeData(id, { cwd: dir })
  }
  return (
    <SatelliteShell id={id} kind="sandbox" data={data} selected={selected} minWidth={220} minHeight={100}>
      <div className="station__body nodrag">
        <div className="station__block">
          <div className="station__row">
            <span className="station__path" title={cwd || 'Pick the folder the connected station starts in'}>
              {shortCwd}
            </span>
            <button className="station__btn" onClick={() => void pickFolder()}>
              Browse
            </button>
          </div>
        </div>
      </div>
    </SatelliteShell>
  )
}
