import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// eslint-disable-next-line no-restricted-imports
import { registerPluginLocales } from '@/i18n/plugin-i18n'

import type * as KanbanApi from './api'
import { en, KANBAN_LOCALES } from './i18n'
import { KanbanCount } from './plugin'
import type { KanbanBoard } from './types'

const NOW_S = Math.floor(new Date('2026-09-16T18:00:00Z').getTime() / 1000)

const mkBoard = (opts: {
  running?: number
  ready?: number
  needsInput?: number
}): KanbanBoard => ({
  columns: [
    { name: 'triage', tasks: [] },
    {
      name: 'ready',
      tasks: Array.from({ length: opts.ready ?? 0 }, (_, i) => ({
        id: `t_ready${i}`,
        title: `Ready ${i}`,
        status: 'ready'
      }))
    },
    {
      name: 'running',
      tasks: Array.from({ length: opts.running ?? 0 }, (_, i) => ({
        id: `t_run${i}`,
        title: `Running ${i}`,
        status: 'running',
        started_at: NOW_S - 60,
        last_heartbeat_at: NOW_S - 5
      }))
    },
    {
      name: 'blocked',
      tasks: [
        ...Array.from({ length: opts.needsInput ?? 0 }, (_, i) => ({
          id: `t_ni${i}`,
          title: `Needs input ${i}`,
          status: 'blocked',
          block_kind: 'needs_input' as const
        })),
        { id: 't_depblock', title: 'Dep block', status: 'blocked', block_kind: 'dependency' }
      ]
    },
    { name: 'done', tasks: [] }
  ],
  tenants: [],
  assignees: [],
  latest_event_id: 0,
  now: NOW_S
})

vi.mock('./api', async importOriginal => {
  const orig = await importOriginal<typeof KanbanApi>()

  return {
    ...orig,
    fetchBoard: vi.fn(async () => mkBoard({ running: 1, ready: 2, needsInput: 1 })),
    fetchActiveWorkers: vi.fn(async () => ({
      workers: [
        {
          run_id: 1,
          task_id: 't_run0',
          task_title: 'Running 0',
          profile: 'alpha',
          started_at: NOW_S - 60,
          last_heartbeat_at: NOW_S - 5,
          step_key: null,
          latest_event: null
        }
      ],
      count: 1,
      checked_at: NOW_S
    }))
  }
})

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

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <KanbanCount />
    </QueryClientProvider>
  )

describe('KanbanCount', () => {
  it('renders nothing when running, ready, and needs-input are all zero', async () => {
    const { fetchBoard } = await import('./api')
    vi.mocked(fetchBoard).mockResolvedValueOnce(mkBoard({ running: 0, ready: 0, needsInput: 0 }))

    const { container } = mount()

    await vi.advanceTimersByTimeAsync(100)

    expect(container.innerHTML).toBe('')
  })

  it('is visible when only needs-input tasks exist (no running/ready)', async () => {
    const { fetchBoard } = await import('./api')
    vi.mocked(fetchBoard).mockResolvedValueOnce(mkBoard({ running: 0, ready: 0, needsInput: 2 }))

    mount()

    const pill = await screen.findByRole('button', { name: /needs input/i })

    expect(pill).toBeTruthy()
  })

  it('click opens the labelled popover, aria-expanded toggles, Escape closes', async () => {
    mount()

    const pill = await screen.findByRole('button', { name: /kanban/i })

    expect(pill.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(pill)

    expect(pill.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByLabelText(en.workersPanelTitle)).toBeTruthy()

    fireEvent.keyDown(pill, { key: 'Escape' })

    expect(pill.getAttribute('aria-expanded')).toBe('false')
  })
})
