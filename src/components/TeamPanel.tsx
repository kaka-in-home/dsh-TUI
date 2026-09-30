import React from 'react'
import { Box, Text, useInput, ScrollBox, type ScrollBoxHandle, useTerminalSize, useAnimationFrame } from '../ui.js'
import type { TeamMemberRow, TeamMessageRow, TeamTaskRow, TeamView } from '../dsh-adapter/channel.js'
import type { Theme } from '../theme.js'
import { t } from '../i18n.js'
import { Divider } from './design-system/Divider.js'
import { ExitButton } from './SubagentDashboard.js'
import { isPlainReturnInput } from '../utils/modifiers.js'
import { isMinimalUiMode } from '../minimalUiMode.js'
import { stringWidth } from '../ink/stringWidth.js'

/** The three pages of the team panel (`←`/`→`). */
export const TEAM_PAGES = ['members', 'tasks', 'inbox'] as const
export type TeamPage = (typeof TEAM_PAGES)[number]

export interface TeamPanelProps {
  team: TeamView | undefined
  messages: readonly TeamMessageRow[]
  page: TeamPage
  focusIndex: number
  onPage: (page: TeamPage) => void
  onFocus: (index: number) => void
  onClose: () => void
  /** Open a member's session view (`Viewing teammate` / `Viewing leader`). */
  onOpenMember: (member: TeamMemberRow) => void
  /** Re-read the projection. */
  onRefresh: () => void
}

function statusInfo(member: TeamMemberRow): { glyph: string; label: string; color: keyof Theme | undefined } {
  const minimalUi = isMinimalUiMode()
  if (member.phase === 'failed') {
    return { glyph: minimalUi ? '×' : '✗', label: t('team-status-failed'), color: minimalUi ? undefined : 'error' }
  }
  if (member.phase === 'provisioning') {
    return { glyph: minimalUi ? '·' : '◌', label: t('team-status-provisioning'), color: minimalUi ? undefined : 'warning' }
  }
  if (member.turn === 'running') {
    return { glyph: minimalUi ? '·' : '●', label: t('team-status-working'), color: minimalUi ? undefined : 'warning' }
  }
  if (member.turn === 'idle') {
    return { glyph: minimalUi ? '·' : '○', label: t('team-status-idle'), color: undefined }
  }
  return { glyph: minimalUi ? '·' : '○', label: t('team-status-inactive'), color: undefined }
}

function taskState(task: TeamTaskRow): { glyph: string; label: string; color: keyof Theme | undefined } {
  const minimalUi = isMinimalUiMode()
  switch (task.status) {
    case 'completed':
      return { glyph: minimalUi ? '✓' : '●', label: t('team-task-completed'), color: minimalUi ? undefined : 'success' }
    case 'in_progress':
      return { glyph: minimalUi ? '·' : '◐', label: t('team-task-in-progress'), color: minimalUi ? undefined : 'warning' }
    default:
      return task.ready
        ? { glyph: minimalUi ? '·' : '○', label: t('team-task-pending'), color: undefined }
        : { glyph: minimalUi ? '·' : '○', label: t('team-task-blocked'), color: minimalUi ? undefined : 'error' }
  }
}

/**
 * Claude-Code `TaskList` row format, kept verbatim in shape:
 * `#<id> [<status>] <subject> (<owner>) [blocked by <ids>]`.
 *
 * DSH task ids already carry their own prefix, so the marker is `#` only when
 * the id is a bare number — the row must never read `##3`.
 */
export function taskRowLine(task: TeamTaskRow): string {
  const marker = /^\d+$/.test(task.id) ? `#${task.id}` : task.id
  const owner = task.ownerName === undefined ? '' : ` (${task.ownerName})`
  const blocked = task.blockedBy.length === 0 ? '' : ` [${t('team-task-blocked-by')} ${task.blockedBy.join(', ')}]`
  return `${marker} [${task.status}] ${task.subject}${owner}${blocked}`
}

/** Hard single-line clip by display width (same rule as the jobs panel). */
function clipLine(text: string, maxWidth: number): string {
  if (maxWidth <= 1) return ''
  let width = 0
  let index = 0
  while (index < text.length) {
    const next = text.codePointAt(index)!
    const char = String.fromCodePoint(next)
    const charWidth = stringWidth(char)
    if (width + charWidth > maxWidth - 1) break
    width += charWidth
    index += char.length
  }
  return index < text.length ? `${text.slice(0, index)}…` : text
}

function timeOf(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** `⬢ name` plus the `current` / `lead` markers and the live turn word. */
function MemberRow({ member, focused, labelWidth }: {
  member: TeamMemberRow
  focused: boolean
  labelWidth: number
}): React.ReactNode {
  const info = statusInfo(member)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text color={focused ? 'accent' : undefined}>{focused ? '❯' : ' '}</Text>
        <Text color={info.color}>{info.glyph}</Text>
        <Text bold={focused || member.role === 'lead'} color={focused ? 'accent' : member.role === 'lead' ? 'planMode' : undefined}>
          {member.name}
        </Text>
        {member.role === 'lead' && <Text dimColor>{t('team-role-lead')}</Text>}
        {member.current && <Text color="accent">{t('team-current')}</Text>}
        <Box flexGrow={1} />
        {member.model !== undefined && <><Text dimColor>·</Text><Text dimColor>{clipLine(member.model, 28)}</Text><Text dimColor>·</Text></>}
        <Text color={info.color}>{info.label}</Text>
      </Box>
      {focused && (
        <Box flexDirection="column">
          <Text dimColor wrap="truncate">
            {`    ${t('team-member-session')} ${member.sessionId}`}
          </Text>
          {member.description !== undefined && member.description !== '' && (
            <Text dimColor wrap="truncate">{`    ${clipLine(member.description, Math.max(10, labelWidth))}`}</Text>
          )}
          {member.agentId !== undefined && (
            <Text dimColor wrap="truncate">{`    ${t('team-member-agent')} ${member.agentId}`}</Text>
          )}
          {member.error !== undefined && (
            <Text color="error" wrap="truncate">{`    ${clipText(member.error, labelWidth)}`}</Text>
          )}
        </Box>
      )}
    </Box>
  )
}

function clipText(text: string, maxWidth: number): string {
  return clipLine(text.replace(/\s+/gu, ' ').trim(), maxWidth)
}

function TaskRow({ task, focused, labelWidth }: {
  task: TeamTaskRow
  focused: boolean
  labelWidth: number
}): React.ReactNode {
  const info = taskState(task)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text color={focused ? 'accent' : undefined}>{focused ? '❯' : ' '}</Text>
        <Text color={info.color}>{info.glyph}</Text>
        <Text bold={focused} color={focused ? 'accent' : undefined} wrap="truncate">
          {clipLine(taskRowLine(task), labelWidth)}
        </Text>
        <Box flexGrow={1} />
        <Text dimColor>{`rev ${task.revision}`}</Text>
        <Text dimColor>·</Text>
        <Text color={info.color}>{info.label}</Text>
      </Box>
      {focused && (
        <Box flexDirection="column">
          {task.description !== '' && (
            <Text dimColor wrap="truncate">{`    ${clipLine(task.description, Math.max(10, labelWidth))}`}</Text>
          )}
          <Text dimColor wrap="truncate">
            {`    ${t('team-task-owner')} ${task.ownerName ?? t('team-task-unowned')}`}
            {task.status === 'pending' ? ` · ${task.ready ? t('team-task-ready') : t('team-task-not-ready')}` : ''}
          </Text>
          {task.writeScopes.length > 0 && (
            <Text dimColor wrap="truncate">{`    ${t('team-task-writes')} ${task.writeScopes.join(', ')}`}</Text>
          )}
          {task.writeScopeWarnings.map((warning, index) => (
            <Text key={`warn-${index}`} color="warning" wrap="truncate">
              {`    ! ${clipLine(warning, Math.max(10, labelWidth))}`}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

/**
 * `/team` overlay panel — the TUI counterpart of the official Web team panel:
 * the roster, the shared task board, and the teammate messages this session
 * received. READ-ONLY by design: the team is created and driven by the model
 * through the official Team tools, exactly as the Web UI does it — the panel
 * observes the `agentTeam` projection, and its only action is opening a
 * member's own session.
 *
 * Keyboard: `←`/`→` switch page, `↑`/`↓` (or `j`/`k`) move the row cursor,
 * `Enter` opens the focused member's session, `r` re-reads, `Esc` closes.
 */
export function TeamPanel({
  team,
  messages,
  page,
  focusIndex,
  onPage,
  onFocus,
  onClose,
  onOpenMember,
  onRefresh,
}: TeamPanelProps): React.ReactNode {
  const scrollRef = React.useRef<ScrollBoxHandle | null>(null)
  const { rows, columns } = useTerminalSize()
  // 1s tick keeps the elapsed column live while the panel is open; the ref
  // rides the root box so a closed panel stops the interval.
  const [clockRef] = useAnimationFrame(team === undefined ? null : 1000)
  const members = team?.members ?? []
  const tasks = team?.tasks ?? []
  const rowCount = page === 'members' ? members.length : page === 'tasks' ? tasks.length : messages.length
  const focus = Math.min(focusIndex, Math.max(0, rowCount - 1))
  const focusedMember = page === 'members' ? members[focus] : undefined
  const labelWidth = Math.max(20, (columns ?? 80) - 24)

  const move = (delta: number): void => {
    const next = Math.min(rowCount - 1, Math.max(0, focus + delta))
    onFocus(next)
    scrollRef.current?.scrollBy(delta)
  }

  useInput((input, key, event) => {
    // The panel is read-only: every branch only moves the cursor, switches the
    // page, opens a session, re-reads, or closes. Team mutations belong to the
    // model through the official Team tools.
    if (key.escape || (key.ctrl && input === 'c')) {
      event.stopImmediatePropagation()
      onClose()
      return
    }
    if (key.upArrow || input === 'k') {
      event.stopImmediatePropagation()
      move(-1)
      return
    }
    if (key.downArrow || input === 'j') {
      event.stopImmediatePropagation()
      move(1)
      return
    }
    if (key.leftArrow || key.rightArrow || input === 'h' || input === 'l') {
      event.stopImmediatePropagation()
      const index = TEAM_PAGES.indexOf(page)
      const next = key.leftArrow || input === 'h'
        ? (index + TEAM_PAGES.length - 1) % TEAM_PAGES.length
        : (index + 1) % TEAM_PAGES.length
      onPage(TEAM_PAGES[next]!)
      return
    }
    if (isPlainReturnInput(input, key)) {
      event.stopImmediatePropagation()
      if (page === 'members' && focusedMember !== undefined) onOpenMember(focusedMember)
      return
    }
    if (input === 'r') {
      event.stopImmediatePropagation()
      onRefresh()
      return
    }
    event.stopImmediatePropagation()
  })

  const teammates = members.filter(member => member.role === 'teammate').length
  const running = members.filter(member => member.role === 'teammate' && member.turn === 'running').length
  // The tab count is the number of rows the page shows, so it must count the
  // WHOLE board. Counting only unfinished tasks read as a bug against the page
  // itself (a completed board said "任务 0" above a visible completed row);
  // the status-line chip is where "how much is still open" belongs.
  const totalTasks = tasks.length

  const pageLabel = (candidate: TeamPage, label: string, count: number): React.ReactNode => (
    <Text
      key={candidate}
      bold={candidate === page}
      color={candidate === page ? 'accent' : undefined}
      dimColor={candidate !== page}
    >
      {`${candidate === page ? '▍' : ''}${label} ${count}`}
    </Text>
  )

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1} ref={clockRef}>
      <Divider color="accent" title={t('team-panel-title')} />

      <Box flexDirection="row" gap={2} marginTop={1}>
        {pageLabel('members', t('team-page-members'), teammates)}
        {pageLabel('tasks', t('team-page-tasks'), totalTasks)}
        {pageLabel('inbox', t('team-page-inbox'), messages.length)}
        <Box flexGrow={1} />
        {running > 0 && <Text color="warning">{t('team-running', { n: String(running) })}</Text>}
        <ExitButton onClick={onClose} />
      </Box>

      {team?.failure !== undefined && (
        <Box marginTop={1}>
          <Text color="error" wrap="truncate">{`! ${t('team-projection-failed')} ${clipText(team.failure, labelWidth)}`}</Text>
        </Box>
      )}

      <Box flexDirection="column" maxHeight={Math.max(8, rows - 12)} marginTop={1}>
        <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1}>
          {rowCount === 0
            ? (
                <Box flexDirection="column" alignItems="center" marginTop={Math.max(1, Math.floor((rows - 18) / 3))}>
                  <Text dimColor>{'⬢'}</Text>
                  <Text dimColor>{t(page === 'members' ? 'team-empty-members' : page === 'tasks' ? 'team-empty-tasks' : 'team-empty-inbox')}</Text>
                  <Box marginTop={1}>
                    <Text dimColor>{t(page === 'members' ? 'team-empty-members-hint' : page === 'tasks' ? 'team-empty-tasks-hint' : 'team-empty-inbox-hint')}</Text>
                  </Box>
                </Box>
              )
            : page === 'members'
              ? members.map((member, index) => (
                  <MemberRow key={member.sessionId} member={member} focused={index === focus} labelWidth={labelWidth} />
                ))
              : page === 'tasks'
                ? tasks.map((task, index) => (
                    <TaskRow key={task.id} task={task} focused={index === focus} labelWidth={labelWidth} />
                  ))
                : messages.map((message, index) => (
                    <Box key={message.id} flexDirection="column">
                      <Box flexDirection="row" gap={1}>
                        <Text color={index === focus ? 'accent' : undefined}>{index === focus ? '❯' : ' '}</Text>
                        <Text bold color={index === focus ? 'accent' : undefined}>{`@${message.senderName}`}</Text>
                        <Text dimColor>{timeOf(message.at)}</Text>
                      </Box>
                      <Text wrap="truncate">{`    ${clipLine(message.text, labelWidth)}`}</Text>
                    </Box>
                  ))}
        </ScrollBox>
      </Box>

      <Divider color="subtle" title="" />
      <Box marginTop={0}>
        <Text dimColor>
          {page === 'members'
            ? t('team-hint-members')
            : page === 'tasks'
              ? t('team-hint-tasks')
              : t('team-hint-inbox')}
        </Text>
      </Box>
    </Box>
  )
}
