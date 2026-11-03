/**
 * Kanban — the founding plugin use case, now pure SDK-consumer work: a
 * first-class `/kanban` board page + sidebar nav row + a live statusbar count,
 * all reusing the existing `plugins/kanban/dashboard/plugin_api.py` REST router
 * through `ctx.rest` (namespace-scoped to `/api/plugins/kanban`). No new
 * backend, no core edits.
 *
 * Ships OFF by default (`defaultEnabled: false`): it inventories in
 * Capabilities ▸ Plugins and registers nothing until the user flips the switch.
 */

import './kanban.css'

import {
  cn,
  Codicon,
  type HermesPlugin,
  host,
  type KeybindContribution,
  KEYBINDS_AREA,
  PALETTE_AREA,
  type PaletteContribution,
  Popover,
  PopoverContent,
  PopoverTrigger,
  type RouteContribution,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  type SidebarNavContribution,
  STATUSBAR_AREAS,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { useState } from 'react'

import { $boardSlug, bindApi, boardKey, fetchBoard, useKanbanScope } from './api'
import { KanbanBoardPage } from './board'
import { KANBAN_LOCALES } from './i18n'
import { $newTaskLane, useKanban } from './ui'
import { WorkerStatusPanel } from './worker-status'

// Live "N running / ready" pill with a worker-status popover — one glance at
// fleet activity from anywhere. Shares the board query (one cache, one poll
// with the page); hidden when nothing is in flight (or unloaded).
export function KanbanCount() {
  const k = useKanban()
  const scope = useKanbanScope()
  const slug = useValue($boardSlug)
  const [open, setOpen] = useState(false)

  const { data: board } = useQuery({
    queryFn: () => fetchBoard(false),
    queryKey: boardKey(scope, slug, false),
    refetchInterval: 60_000
  })

  if (!board) {
    return null
  }

  const count = (name: string) => board.columns.find(col => col.name === name)?.tasks.length ?? 0
  const running = count('running')
  const ready = count('ready')

  const needsInput =
    board.columns.find(c => c.name === 'blocked')?.tasks.filter(t => t.block_kind === 'needs_input').length ?? 0

  const active = running + ready

  if (active === 0 && needsInput === 0) {
    return null
  }

  const trigger = (
    <PopoverTrigger asChild>
      <button
        aria-label={k.countTip(running, ready, needsInput)}
        className={cn(
          'inline-flex h-full items-center gap-1 rounded-none px-1.5 text-[0.6875rem] tabular-nums transition-colors',
          'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
        )}
        type="button"
      >
        <Codicon name="project" size="0.7rem" />
        <span>{active}</span>
        {needsInput > 0 && (
          <>
            <span className="text-(--ui-text-quaternary)">·</span>
            <span className="inline-flex items-center gap-0.5 text-destructive">
              <Codicon name="debug-breakpoint-data-unverified" size="0.65rem" />
              {needsInput}
            </span>
          </>
        )}
      </button>
    </PopoverTrigger>
  )

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent side="top">{k.countTip(running, ready, needsInput)}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent
        align="end"
        aria-label={k.workersPanelTitle}
        side="top"
        variant="menu"
      >
        <WorkerStatusPanel board={board} open={open} scope={scope} slug={slug} />
      </PopoverContent>
    </Popover>
  )
}

const plugin: HermesPlugin = {
  id: 'kanban',
  name: 'Kanban',
  description: 'Multi-agent task board — board page, sidebar entry, and a live in-flight count in the status bar.',
  defaultEnabled: false,
  register(ctx) {
    ctx.i18n.register(KANBAN_LOCALES)
    ctx.onDispose(bindApi(ctx.rest, ctx.storage, ctx.socket, { os: ctx.os, t: ctx.i18n.t }))

    // The plugin command pattern: ONE action id (`kanban.newTask`) wired into
    // two areas — a keybind (dispatch + rebindable panel row) and a palette row
    // whose `action` field points back at it, so ⌘K shows the live combo. The
    // handler is route-independent: it navigates to the page and parks the
    // request in `$newTaskLane`, so the hotkey works from anywhere, not just
    // while the board happens to be mounted.
    //
    // ⌘⌥N / Ctrl+Alt+N: `mod+n` is `session.new` and `mod+shift+n` is
    // `session.newWindow`, both core built-ins a plugin can't shadow. Adding
    // Alt keeps the "N for new" mnemonic on a chord core leaves free — it uses
    // `alt` only for the `mod+alt+1…9` profile slots, never with a letter. That
    // makes ⌘⌥<letter> the natural namespace for plugin commands.
    const newTask = () => {
      $newTaskLane.set('triage')
      host.navigate('/kanban')
    }

    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: '/kanban' } satisfies RouteContribution,
        render: () => <KanbanBoardPage />
      },
      {
        id: 'count',
        area: STATUSBAR_AREAS.right,
        order: 80,
        render: () => <KanbanCount />
      }
    ])

    const registerLabels = () =>
      ctx.registerMany([
        {
          id: 'nav',
          area: SIDEBAR_NAV_AREA,
          order: 50,
          data: { codicon: 'project', label: ctx.i18n.t('nav'), path: '/kanban' } satisfies SidebarNavContribution
        },
        {
          id: 'open',
          area: PALETTE_AREA,
          data: {
            id: 'kanban.open',
            label: ctx.i18n.t('openBoard'),
            keywords: ['kanban', 'board', 'tasks', 'agents'],
            run: () => host.navigate('/kanban')
          } satisfies PaletteContribution
        },
        {
          id: 'new-task',
          area: PALETTE_AREA,
          data: {
            id: 'kanban.newTask',
            action: 'kanban.newTask',
            label: ctx.i18n.t('newTaskCommand'),
            keywords: ['kanban', 'task', 'new', 'create', 'triage'],
            run: newTask
          } satisfies PaletteContribution
        },
        {
          id: 'new-task',
          area: KEYBINDS_AREA,
          data: {
            id: 'kanban.newTask',
            category: 'view',
            defaults: ['mod+alt+n'],
            label: ctx.i18n.t('newTaskCommand'),
            run: newTask
          } satisfies KeybindContribution
        }
      ])

    let disposeLabels = registerLabels()
    ctx.i18n.onLocaleChange(() => {
      disposeLabels()
      disposeLabels = registerLabels()
    })
  }
}

export default plugin
