import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// eslint-disable-next-line no-restricted-imports
import { registerPluginLocales } from '@/i18n/plugin-i18n'

import type * as KanbanApi from './api'
import { en, KANBAN_LOCALES } from './i18n'
import type { ActiveWorker, ActiveWorkersResponse, KanbanBoard } from './types'
import { WorkerStatusPanel } from './worker-status'

const NOW_S = Math.floor(new Date('2026-09-16T18:00:00Z').getTime() / 1000)

const baseWorker: ActiveWorker = {
  run_id: 1,
  task_id: 't_abc123def456',
  task_title: 'Build widgets',
  task_assignee: 'alpha',
  profile: 'alpha',
  started_at: NOW_S - 90,
  last_heartbeat_at: NOW_S - 5,
  max_runtime_seconds: null,
  step_key: 'compile',
  latest_event: { kind: 'heartbeat', created_at: NOW_S - 5, note: 'compiling src' }
}

const emptyBoard: KanbanBoard = {
  columns: [
    { name: 'triage', tasks: [] },
    { name: 'ready', tasks: [] },
    { name: 'running', tasks: [] },
    { name: 'blocked', tasks: [] },
    { name: 'done', tasks: [] }
  ],
  tenants: [],
  assignees: [],
  latest_event_id: 0,
  now: NOW_S
}

const workersResponse = (workers: ActiveWorker[]): ActiveWorkersResponse => ({
  workers,
  count: workers.length,
  checked_at: NOW_S
})

vi.mock('./api', async importOriginal => ({
  ...(await importOriginal<typeof KanbanApi>()),
  fetchActiveWorkers: vi.fn(async () => workersResponse([baseWorker]))
}))

let disposeLocales: () => void

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2026-09-16T18:00:00Z'))
  disposeLocales = registerPluginLocales('kanban', KANBAN_LOCALES)
})

afterEach(() => {
  cleanup()
  disposeLocales()
  vi.useRealTimers()
})

const mount = (board?: KanbanBoard) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <WorkerStatusPanel board={board ?? emptyBoard} open scope="test" slug="default" />
    </QueryClientProvider>
  )

describe('WorkerStatusPanel', () => {
  it('shows profile name, title, short id, phase chip, elapsed, and latest note', async () => {
    mount()

    expect(await screen.findByText('alpha')).toBeTruthy()
    expect(screen.getByText('Build widgets')).toBeTruthy()
    expect(screen.getByText('abc123')).toBeTruthy()
    expect(screen.getByText('compile')).toBeTruthy()
    expect(screen.getByText(/1m/)).toBeTruthy()
    expect(screen.getByText('compiling src')).toBeTruthy()
  })

  it('renders no-heartbeat phase when heartbeat is stale', async () => {
    const { fetchActiveWorkers } = await import('./api')

    const stale: ActiveWorker = {
      ...baseWorker,
      last_heartbeat_at: NOW_S - 200,
      step_key: 'compile'
    }

    vi.mocked(fetchActiveWorkers).mockResolvedValueOnce(workersResponse([stale]))
    mount()

    expect(await screen.findByText(en.noHeartbeat)).toBeTruthy()
  })

  it('shows needs-input tasks from the board blocked column', async () => {
    const { fetchActiveWorkers } = await import('./api')
    vi.mocked(fetchActiveWorkers).mockResolvedValueOnce(workersResponse([]))

    const board: KanbanBoard = {
      ...emptyBoard,
      columns: emptyBoard.columns.map(c =>
        c.name === 'blocked'
          ? {
              ...c,
              tasks: [
                { id: 't_needsinput1', title: 'Awaiting review', status: 'blocked', block_kind: 'needs_input' },
                { id: 't_depblocked1', title: 'Dep blocked', status: 'blocked', block_kind: 'dependency' }
              ]
            }
          : c
      )
    }

    mount(board)

    expect(await screen.findByText('Awaiting review')).toBeTruthy()
    expect(screen.queryByText('Dep blocked')).toBeNull()
  })

  it('renders no-activity-yet when latest_event is absent', async () => {
    const { fetchActiveWorkers } = await import('./api')
    const noEvent: ActiveWorker = { ...baseWorker, latest_event: null }

    vi.mocked(fetchActiveWorkers).mockResolvedValueOnce(workersResponse([noEvent]))
    mount()

    expect(await screen.findByText(en.noActivityYet)).toBeTruthy()
  })

  it('worker row has a localized accessible label with the task title', async () => {
    mount()

    const btn = await screen.findByRole('button', { name: en.openTaskLabel('Build widgets') })

    expect(btn).toBeTruthy()
  })

  it('needs-input row has a localized accessible label with the task title', async () => {
    const { fetchActiveWorkers } = await import('./api')
    vi.mocked(fetchActiveWorkers).mockResolvedValueOnce(workersResponse([]))

    const board: KanbanBoard = {
      ...emptyBoard,
      columns: emptyBoard.columns.map(c =>
        c.name === 'blocked'
          ? { ...c, tasks: [{ id: 't_ni1', title: 'Review me', status: 'blocked', block_kind: 'needs_input' }] }
          : c
      )
    }

    mount(board)

    const btn = await screen.findByRole('button', { name: en.openTaskLabel('Review me') })

    expect(btn).toBeTruthy()
  })

  it('renders gracefully when step_key and latest_event are missing (older backend)', async () => {
    const { fetchActiveWorkers } = await import('./api')

    const legacy: ActiveWorker = {
      run_id: 2,
      task_id: 't_legacy00',
      task_title: 'Legacy task',
      task_assignee: 'beta',
      profile: null,
      started_at: NOW_S - 60,
      last_heartbeat_at: NOW_S - 3,
      max_runtime_seconds: null
    }

    vi.mocked(fetchActiveWorkers).mockResolvedValueOnce(workersResponse([legacy]))
    mount()

    expect(await screen.findByText('Legacy task')).toBeTruthy()
    expect(screen.getByText(en.working)).toBeTruthy()
    expect(screen.getByText(en.noActivityYet)).toBeTruthy()
  })
})
