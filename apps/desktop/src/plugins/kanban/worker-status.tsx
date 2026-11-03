/** Active-worker status panel — compact popover showing who's running, what
 *  phase they're in, how long, and which tasks are blocked waiting for input. */

import { Codicon, host, useQuery } from '@hermes/plugin-sdk'

import { fetchActiveWorkers, workersKey } from './api'
import { useKanban } from './i18n'
import type { ActiveWorker, KanbanBoard, KanbanTask } from './types'
import {
  $openTaskId,
  ago,
  Avatar,
  FIELD_LABEL,
  heartbeatStale,
  shortId,
  useTicking
} from './ui'

// ── workerPhase ─────────────────────────────────────────────────────────────

interface WorkerPhase {
  label: string
  tone: 'default' | 'amber'
}

/** Derive the phase chip for a running worker.
 *
 *  Priority ladder:
 *  1. Stale heartbeat (>120 s) always overrides — the worker may have died.
 *  2. `step_key` (workflow phase the worker reported, e.g. "compile").
 *  3. Fallback to generic "working" label.
 *
 *  When `max_runtime_seconds` is set and elapsed exceeds 80%, a budget suffix
 *  is appended so the operator can see the worker is nearing its time limit. */
function workerPhase(
  w: ActiveWorker,
  workingLabel: string,
  noHeartbeatLabel: string
): WorkerPhase {
  if (heartbeatStale(w.last_heartbeat_at)) {
    return { label: noHeartbeatLabel, tone: 'amber' }
  }

  let label = w.step_key ?? workingLabel

  if (w.max_runtime_seconds && w.max_runtime_seconds > 0) {
    const elapsed = Date.now() / 1000 - w.started_at
    const ratio = elapsed / w.max_runtime_seconds

    if (ratio >= 0.8) {
      const pct = Math.min(Math.round(ratio * 100), 999)
      label = `${label} · ${pct}%`
    }
  }

  return { label, tone: 'default' }
}

// ── per-row elapsed cell (each row ticks independently) ─────────────────────

function ElapsedCell({ label, startedAt }: { label: string; startedAt: number }) {
  const elapsed = useTicking(startedAt)

  if (!elapsed) {
    return null
  }

  return (
    <span className="shrink-0 tabular-nums text-(--ui-text-quaternary)">
      {label} {elapsed}
    </span>
  )
}

// ── worker row ──────────────────────────────────────────────────────────────

function WorkerRow({ worker }: { worker: ActiveWorker }) {
  const k = useKanban()
  const phase = workerPhase(worker, k.working, k.noHeartbeat)
  const profileName = worker.profile ?? worker.task_assignee ?? ''

  const activity = worker.latest_event
    ? worker.latest_event.note ?? k.eventKind(worker.latest_event.kind)
    : null

  const activityAgo = worker.latest_event ? ago(worker.latest_event.created_at) : null

  return (
    <button
      aria-label={k.openTaskLabel(worker.task_title)}
      className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-(--ui-bg-tertiary)"
      onClick={() => {
        $openTaskId.set(worker.task_id)
        host.navigate('/kanban')
      }}
      type="button"
    >
      <Avatar name={profileName} size="1.25rem" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* profile + title + short id */}
        {profileName && (
          <span className="truncate text-[0.625rem] font-medium text-(--ui-text-secondary)">
            {profileName}
          </span>
        )}
        <div className="flex items-baseline gap-1.5">
          <span className="truncate font-medium text-(--ui-text-primary)">{worker.task_title}</span>
          <span className="shrink-0 text-[0.625rem] text-(--ui-text-quaternary)">
            {shortId(worker.task_id)}
          </span>
        </div>
        {/* phase + elapsed */}
        <div className="flex items-center gap-1.5 text-[0.6875rem]">
          <span
            className="shrink-0 rounded px-1 py-px text-[0.625rem] font-semibold uppercase tracking-wide"
            style={{
              backgroundColor:
                phase.tone === 'amber'
                  ? 'color-mix(in srgb, #fbbf24 15%, transparent)'
                  : 'color-mix(in srgb, #34d399 15%, transparent)',
              color: phase.tone === 'amber' ? '#fbbf24' : '#34d399'
            }}
          >
            {phase.label}
          </span>
          <ElapsedCell label={k.elapsed} startedAt={worker.started_at} />
        </div>
        {/* latest activity */}
        <div className="flex items-center gap-1 text-[0.625rem] text-(--ui-text-tertiary)">
          <span className="truncate">{activity ?? k.noActivityYet}</span>
          {activityAgo && <span className="shrink-0">· {activityAgo}</span>}
        </div>
      </div>
    </button>
  )
}

// ── needs-input row ─────────────────────────────────────────────────────────

function NeedsInputRow({ task }: { task: KanbanTask }) {
  const k = useKanban()

  return (
    <button
      aria-label={k.openTaskLabel(task.title)}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-(--ui-bg-tertiary)"
      onClick={() => {
        $openTaskId.set(task.id)
        host.navigate('/kanban')
      }}
      type="button"
    >
      <Codicon
        className="shrink-0"
        name="debug-breakpoint-data-unverified"
        size="0.85rem"
        style={{ color: 'var(--destructive, #f87171)' }}
      />
      <span className="truncate text-destructive">{task.title}</span>
      <span className="shrink-0 text-[0.625rem] text-(--ui-text-quaternary)">
        {shortId(task.id)}
      </span>
    </button>
  )
}

// ── panel ───────────────────────────────────────────────────────────────────

export function WorkerStatusPanel({
  board,
  open,
  scope,
  slug
}: {
  board: KanbanBoard | undefined
  open: boolean
  scope: string
  slug: string
}) {
  const k = useKanban()

  const { data, error, isLoading } = useQuery({
    enabled: open,
    queryFn: fetchActiveWorkers,
    queryKey: workersKey(scope, slug),
    refetchInterval: open ? 5_000 : false
  })

  const needsInput =
    board?.columns
      .find(c => c.name === 'blocked')
      ?.tasks.filter(t => t.block_kind === 'needs_input') ?? []

  const readyCount = board?.columns.find(c => c.name === 'ready')?.tasks.length ?? 0

  // error (no cached data) — query keeps retrying on the interval
  if (error && !data) {
    const raw = error instanceof Error ? error.message : String(error)
    const brace = raw.indexOf('{')
    let detail = raw

    if (brace !== -1) {
      try {
        detail = (JSON.parse(raw.slice(brace)) as { detail?: string }).detail ?? raw
      } catch {
        // not JSON
      }
    }

    return (
      <div className="w-80 p-3 text-[0.75rem] text-destructive">{detail}</div>
    )
  }

  // loading
  if (isLoading || !data) {
    return (
      <div className="w-80 p-3 text-[0.75rem] text-(--ui-text-tertiary)">
        {k.workersLoading}
      </div>
    )
  }

  // empty — no running workers
  if (data.workers.length === 0 && needsInput.length === 0) {
    return (
      <div className="w-80 p-3 text-[0.75rem] text-(--ui-text-tertiary)">
        {k.noWorkersYet(readyCount)}
      </div>
    )
  }

  return (
    <div className="flex w-80 flex-col gap-2 p-3 text-[0.75rem]">
      {/* running workers */}
      {data.workers.length > 0 && (
        <section className="flex flex-col gap-1">
          <div className={FIELD_LABEL}>{k.workersPanelTitle}</div>
          {data.workers.map(w => (
            <WorkerRow key={w.run_id} worker={w} />
          ))}
        </section>
      )}

      {/* needs-input section */}
      {needsInput.length > 0 && (
        <section className="flex flex-col gap-1">
          <div className={FIELD_LABEL} style={{ color: 'var(--destructive, #f87171)' }}>
            {k.needsInputSection(needsInput.length)}
          </div>
          {needsInput.map(t => (
            <NeedsInputRow key={t.id} task={t} />
          ))}
        </section>
      )}
    </div>
  )
}
