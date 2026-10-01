/**
 * Focused UI regressions for the read-only Team panel.
 * Real Chat/TeamPanel + real decision stores + xterm's visible viewport;
 * channel actions are recorded, so key leakage and navigation failures are
 * observable without model requests or a whole Harness boot.
 * Run: node --import tsx/esm scripts/verify-team-panel.tsx
 */
import assert from 'node:assert/strict'
import type { ComponentProps, ReactElement } from 'react'

process.env.DSH_TUI_LANG = 'zh'
process.env.FORCE_COLOR = '3'
process.setMaxListeners(0)

const [React, { PassThrough, Writable }, { Terminal }, { render, Box, AlternateScreen }, { Chat }, { TeamPanel }, { QuestionStore }, { ApprovalStore }, { settled, sleep, viewportLines }] = await Promise.all([
  import('react'),
  import('node:stream'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/components/TeamPanel.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/approvals.js'),
  import('./lib/term-test.mjs'),
])

const team = {
  members: [
    { sessionId: 'session-lead', name: 'lead', role: 'lead' as const, phase: 'active' as const, turn: 'idle' as const, current: true },
    { sessionId: 'session-reviewer', name: 'reviewer', role: 'teammate' as const, phase: 'active' as const, turn: 'idle' as const, current: false },
  ],
  tasks: [{ id: 'task-1', subject: 'TASK-READY', status: 'pending' as const, revision: 1, description: '', blockedBy: [], writeScopes: [], writeScopeWarnings: [], ready: true }],
}

class Input extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

async function terminalHarness(element: ReactElement, rows = 28) {
  const term = new Terminal({ cols: 100, rows, allowProposedApi: true, scrollback: 1000 })
  const stdin = new Input()
  const stdout = Object.assign(new Writable({
    write(chunk, _encoding, callback) { term.write(String(chunk), callback) },
  }), { columns: term.cols, rows: term.rows, isTTY: true })
  const stderr = Object.assign(new Writable({ write(_chunk, _encoding, callback) { callback() } }), { isTTY: true })
  const app = await render(element, {
    stdout: stdout as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stderr as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  const lines = () => viewportLines(term)
  const has = (text: string) => lines().some(line => line.includes(text))
  const wait = async (predicate: () => boolean, message: string) => {
    assert.ok(await settled(predicate, { timeoutMs: 2000 }), `${message}\n${lines().join('\n')}`)
  }
  return {
    stdin, term, app, lines, has, wait,
    async dispose() { await app.unmount(); term.dispose() },
  }
}

function makeChannel(sessionId = 'session-lead') {
  const listeners = new Set<() => void>()
  return {
    version: 0, whaleIdle: false,
    rows: [{ id: 1, kind: 'assistant', text: 'CHAT-READY', fresh: false }],
    status: 'idle', sessionTitle: 'panel-probe', agentId: sessionId, sessionId,
    model: 'model', provider: 'provider',
    tokens: { input: 0, output: 0 }, cwd: process.cwd(), displayCwd: process.cwd(), gitBranch: 'main',
    working: false, compaction: undefined as { cancellable: boolean } | undefined,
    spinnerMode: 'requesting', mode: { plan: false }, responseChars: 0, activeToolCount: 0,
    turnStart: 0, lastUserText: '', pending: [], commandList: [], commandCompletions: () => [], notifications: [],
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    team, teamMessages: [], agentPreset: 'standard', subagents: [],
    cancels: 0, compactCancels: 0, exits: 0, refreshed: 0,
    attachCalls: [] as string[], notices: [] as string[], rejectAttach: false,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    emit() { this.version++; for (const listener of listeners) listener() },
    submit() {}, steer() {}, clear() {}, pushLocal() {},
    cancel() { this.cancels++ }, cancelCompact() { this.compactCancels++ },
    notify(text: string) { this.notices.push(text) },
    async attachToAgent(id: string) {
      this.attachCalls.push(id)
      if (this.rejectAttach) throw new Error('attach rejected')
      this.sessionId = id
      this.agentId = id
      this.emit()
      return { ok: true }
    },
    refreshTeamProjection() { this.refreshed++ }, markTeamRead() {},
    listModels: async () => [], listSubagents: async () => [], listSessions: () => [],
    setResumeTarget() {}, doctorInfo: () => [],
  }
}

async function mountChat(fullscreen: boolean, channel = makeChannel()) {
  const questions = new QuestionStore()
  const approvals = new ApprovalStore()
  const chat = React.createElement(Chat, {
    channel: channel as unknown as ComponentProps<typeof Chat>['channel'],
    questionStore: questions, approvalStore: approvals, fullscreen, trajectorySeen: true,
    onExit: () => { channel.exits++ },
  })
  const h = await terminalHarness(fullscreen ? React.createElement(AlternateScreen, null, chat) : chat)
  await h.wait(() => h.has('CHAT-READY'), 'chat is ready')
  const roster = () => h.has('←/→ 切页') && h.has('lead')
  const open = async () => { h.stdin.write('\x01'); await h.wait(roster, 'roster opens') }
  return {
    ...h, channel, questions, approvals, roster, open,
    async dispose() { questions.rejectAll(); approvals.settleAll(); await h.dispose() },
  }
}

for (const fullscreen of [false, true]) {
  const mode = fullscreen ? 'fullscreen' : 'inline'
  {
    const channel = makeChannel()
    channel.working = true
    const h = await mountChat(fullscreen, channel)
    try {
      await h.open()
      h.stdin.write('\x12') // Ctrl+R must not open hidden history or refresh.
      await sleep(100) // 固定窗:探针 modified input must not mutate hidden state.
      assert.equal(channel.refreshed, 0)
      h.stdin.write('\x03') // Ctrl+C closes the roster, never cancels a turn.
      await h.wait(() => !h.roster(), 'Ctrl+C closes only the roster')
      assert.equal(channel.cancels, 0, `${mode}: roster Ctrl+C never cancels`)
      assert.equal(channel.exits, 0)
      await h.open()
      h.stdin.write('\x04') // Ctrl+D belongs to the open panel, not app exit.
      await sleep(100) // 固定窗:探针 Ctrl+D must leave the modal and app intact.
      assert.ok(h.roster())
      assert.equal(channel.exits, 0)
    } finally { await h.dispose() }
  }
  {
    const channel = makeChannel()
    channel.compaction = { cancellable: true }
    const h = await mountChat(fullscreen, channel)
    try {
      await h.open()
      h.stdin.write('\x1b')
      await h.wait(() => !h.roster(), 'Esc dismisses the roster during compaction')
      assert.equal(channel.compactCancels, 0, `${mode}: roster Esc never cancels compaction`)
    } finally { await h.dispose() }
  }
  {
    const h = await mountChat(fullscreen)
    try {
      await h.open()
      const asked = h.questions.ask({ questions: [{ id: 'q', question: 'TEAM-QUESTION', options: [{ label: 'YES' }] }] })
        .then(() => 'answered', () => 'cancelled')
      await h.wait(() => h.has('TEAM-QUESTION'), 'pending question replaces the roster')
      assert.ok(!h.roster(), 'roster yields while the question is visible')
      h.stdin.write('\x1b')
      await h.wait(() => h.questions.getSnapshot() === null, 'Esc settles only the question')
      assert.equal(await asked, 'cancelled')
      await h.wait(h.roster, 'roster returns after the question')
      assert.equal(h.channel.cancels, 0)

      const callId = 'approval-1'
      const approval = h.approvals.park({
        agent: { id: h.channel.agentId, session: { events: [{ type: 'tool/call', seq: 1, time: 0, data: { turn: 0, step: 0, callId, name: 'Bash', arguments: '{"command":"APPROVAL-COMMAND"}' } }] } },
        toolName: 'Bash', callId, reason: 'TEAM-APPROVAL',
      } as Parameters<InstanceType<typeof ApprovalStore>['park']>[0])
      await h.wait(() => h.has('TEAM-APPROVAL'), 'pending approval replaces the roster')
      assert.ok(!h.roster(), 'roster yields while approval is visible')
      h.stdin.write('2')
      await h.wait(() => h.approvals.getSnapshot() === null, 'digit 2 decides the approval')
      assert.equal(await approval, 'rejected')
      await h.wait(h.roster, 'roster returns after approval')
    } finally { await h.dispose() }
  }
}

{
  const h = await mountChat(false, makeChannel('session-reviewer'))
  try {
    await h.open()
    h.stdin.write('\r') // Focus starts on Lead: this must really attach back.
    await h.wait(() => h.channel.attachCalls.length === 1 && !h.roster(), 'teammate can return to Lead')
    assert.deepEqual(h.channel.attachCalls, ['session-lead'])
    assert.equal(h.channel.notices.at(-1), '正在查看 Lead')
    await h.open()
    h.stdin.write('j')
    await h.wait(() => h.has('会话 session-reviewer'), 'reviewer focused')
    h.stdin.write('\r')
    await h.wait(() => h.channel.attachCalls.length === 2 && !h.roster(), 'Lead can enter teammate')
    assert.equal(h.channel.notices.at(-1), '正在查看成员 reviewer')
    await h.open() // Must reset retained focus back to Lead.
    await h.wait(() => h.has('会话 session-lead'), 'reopening resets focus')
    h.channel.rejectAttach = true
    h.stdin.write('\r')
    await h.wait(() => h.channel.notices.some(text => text.includes('无法切换')), 'rejected attach is reported')
    assert.ok(h.roster(), 'failed navigation keeps the roster open')
    assert.equal(h.channel.sessionId, 'session-reviewer')
    h.channel.rejectAttach = false
    h.stdin.write('j')
    await h.wait(() => h.has('会话 session-reviewer'), 'current teammate focused')
    const before = h.channel.attachCalls.length
    h.stdin.write('\r')
    await h.wait(() => !h.roster(), 'current session closes the panel without attachment')
    assert.equal(h.channel.attachCalls.length, before)
    assert.equal(h.channel.notices.at(-1), '正在查看成员 reviewer')
  } finally { await h.dispose() }
}

{
  let focus = 0
  let page = 'members'
  let refreshed = 0
  let closed = 0
  const many = { ...team, members: Array.from({ length: 30 }, (_, i) => ({ ...team.members[1], name: `member-${String(i).padStart(2, '0')}`, sessionId: `session-${i}`, agentId: `agent-${i}`, description: 'expanded details' })) }
  function Panel() {
    const [focused, setFocused] = React.useState(0)
    const [activePage, setActivePage] = React.useState<'members' | 'tasks' | 'inbox'>('members')
    return React.createElement(Box, { height: 28, flexDirection: 'column' }, React.createElement(TeamPanel, {
      team: many, messages: [], page: activePage, focusIndex: focused,
      onFocus: index => { focus = index; setFocused(index) },
      onPage: next => { page = next; focus = 0; setFocused(0); setActivePage(next) },
      onRefresh: () => { refreshed++ }, onClose: () => { closed++ }, onOpenMember() {},
    }))
  }
  const h = await terminalHarness(React.createElement(Panel))
  try {
    await h.wait(() => h.has('member-00'), 'standalone panel ready')
    for (const key of ['\x1bh', '\x12', '\x1b[1;3B', '\x1b[1;2B', '\x1b[200~r\x1b[201~']) {
      h.stdin.write(key)
      await sleep(60) // 固定窗:探针 modifiers and paste must not invoke panel actions.
    }
    assert.equal(page, 'members')
    assert.equal(focus, 0)
    assert.equal(refreshed, 0)
    assert.equal(closed, 0)
    h.stdin.write('r')
    await h.wait(() => refreshed === 1, 'plain r refreshes')
    for (let i = 1; i <= 27; i++) {
      h.stdin.write('j')
      await h.wait(() => focus === i, `focus advances to row ${i}`)
    }
    await h.wait(() => h.lines().some(line => line.includes('❯') && line.includes('member-27')), 'deep focused row remains visible')
    h.stdin.write('l')
    await h.wait(() => page === 'tasks' && h.has('TASK-READY'), 'page switch resets scroll to task start')
    h.stdin.write('h')
    await h.wait(() => page === 'members' && h.lines().some(line => line.includes('❯') && line.includes('member-00')), 'returning to members resets scroll and reveals first focus')
    h.stdin.write('\x03')
    await h.wait(() => closed === 1, 'explicit Ctrl+C remains a close action')
  } finally { await h.dispose() }
}
console.log('verify-team-panel OK (modal keys, question/approval interruption, Lead/member navigation, rejected attachment, plain modifiers/paste, focus reset and measured scrolling)')
