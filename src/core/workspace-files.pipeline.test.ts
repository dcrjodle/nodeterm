import { describe, expect, it } from 'vitest'
import type { Project, ProjectPipeline } from '../shared/types'
import { fileToProject, projectToFile, validPipeline } from './workspace-files'

const pipeline: ProjectPipeline = {
  edges: [{ id: 'pipe-a-b', from: 'a', to: 'b', label: 'escalate' }],
  issues: [
    {
      id: 'iss-1',
      title: 'Fix login',
      body: 'SSO broken',
      notes: '',
      status: 'active',
      atNodeId: 'a',
      history: [{ nodeId: 'a', enteredAt: 1 }],
      createdAt: 1
    }
  ]
}

const project: Project = {
  id: 'p1',
  name: 'Factory',
  color: '#fff',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  pipeline
}

describe('project.pipeline persistence', () => {
  it('rides the project file round trip like kanban does', () => {
    const file = projectToFile(project, 1, 'now')
    expect(file.pipeline).toEqual(pipeline)
    const back = fileToProject(file, {})
    expect(back.pipeline).toEqual(pipeline)
  })

  it('is absent from the file when the project has none', () => {
    const file = projectToFile({ ...project, pipeline: undefined }, 1, 'now')
    expect('pipeline' in file).toBe(false)
  })

  it('drops a hand-mangled shape on load instead of crashing the render', () => {
    const file = projectToFile(project, 1, 'now')
    const mangled = { ...file, pipeline: { edges: 'nope' } } as unknown as typeof file
    expect(fileToProject(mangled, {}).pipeline).toBeUndefined()
  })

  it('validPipeline accepts only the {edges[], issues[]} shape', () => {
    expect(validPipeline(pipeline)).toBe(true)
    expect(validPipeline(undefined)).toBe(false)
    expect(validPipeline({ edges: [] })).toBe(false)
    expect(validPipeline({ edges: [], issues: [] })).toBe(true)
  })
})
