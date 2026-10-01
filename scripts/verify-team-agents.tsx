/**
 * Headless verification for the Agent-Team surface — the official
 * `agentTeam` Session projection read into the TUI, and the panel built on it.
 * The TUI owns no Team preset and no `/team` command: the official runtime is
 * composed by `@deepseek-ai/dsh-experimental-agent-team-profile` (a profile
 * layer), and this plugin only reads what that layer publishes.
 *
 * Contracts:
 *  1. `projectTeamView` narrows the official wire value, drops malformed rows,
 *     and attaches the local turn/subagent cross-reference;
 *  2. `TeamStore` keeps per-Lead values, publishes on the change feed, seeds a
 *     cold session from the registry snapshot, and re-projects when the
 *     runtime resolver changes without a team event;
 *  3. `leadSessionIdOf` walks a teammate session to its Lead (the same walk the
 *     official Web UI performs) and falls back to the session itself;
 *  4. the inbox folds `team-message`-sourced durable user events, de-duplicates
 *     a replayed log, and rejects ordinary messages;
 *  5. `TeamPanel` renders roster / task / inbox vocabulary and its empty
 *     states, `taskRowLine` keeps Claude Code's `TaskList` row format, and the
 *     panel consumes every key it owns so none leaks into the turn;
 *  6. no `/team` command exists, and the roster key (Ctrl+A) routes on the
 *     durable teammate record: teammates present → the team panel, nobody
 *     spawned → the subagent dashboard;
 *  7. `teammateCount` is the single predicate the routing and the status-line
 *     chip share, and neither path interrupts a running turn.
 *
 * Follows smoke.tsx / verify-btw.tsx: FakeStdout/FakeStderr/FakeStdin + a
 * plainText ANSI wash. Run with `node --import tsx/esm`.
 */
import assert from 'node:assert/strict'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'
// This script mounts several full screens in one process; each mount adds a
// signal listener, so raise the cap instead of printing a leak warning that
// is an artifact of the harness, not of the code under test.
process.setMaxListeners(0)

const [
  { PassThrough, Writable },
  React,
  { render },
  { TeamPanel },
  { TeamStore, projectTeamView, teammateCount, leadSessionIdOf, createTeamFeed },
  { TeamInboxStore, asTeamMessage },
  { LOCAL_COMMANDS },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('../src/ui.js'),
  import('../src/components/TeamPanel.js'),
  import('../src/dsh-adapter/team-store.js'),
  import('../src/dsh-adapter/team-inbox.js'),
  import('../src/commands.js'),
])

class FakeStdout extends Writable {
  columns = 100
  rows = 30
  isTTY = true
  frames: string[] = []
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    this.frames.push(String(chunk))
    callback()
  }
}

class FakeStderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    callback()
  }
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() {
    return this
  }
  ref() {
    return this
  }
  unref() {
    return this
  }
}

const plainText = (frames: string[]) => frames
  .join('')
  .replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(Number(n)))
  .replace(/\x1b\[[0-9?]*[a-zA-Z]/g, '')

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// ── 1. projection narrowing ─────────────────────────────────────────────────

const officialValue = {
  members: [
    { id: 'session-lead', name: 'lead', role: 'lead', phase: 'active' },
    { id: 'session-rev', name: 'reviewer', role: 'teammate', phase: 'active' },
    { id: 'session-broken', name: 'broken', role: 'teammate', phase: 'failed', error: 'spawn failed' },
    // Malformed rows the projection must drop rather than render half-formed.
    { name: 'no-id', role: 'teammate', phase: 'active' },
    { id: 'session-no-name', role: 'teammate', phase: 'active' },
  ],
  tasks: [
    { id: '3', revision: 2, subject: 'Ship it', description: 'cd', status: 'pending', blockedBy: ['1', '2'], writeScopes: ['src/'], ownerName: 'reviewer', ready: false, writeScopeWarnings: ['src overlaps'] },
    { id: '4', revision: 1, subject: 'Format', description: '', status: 'bogus', blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] },
  ],
}

const enriched = projectTeamView(
  officialValue,
  sessionId => sessionId === 'session-rev' ? { agentId: 'agent-7', turn: 'running', model: 'deepseek-v4.1-flash' } : undefined,
  'session-rev',
)
assert.ok(enriched !== undefined)
assert.deepEqual(enriched.members.map(member => member.sessionId), ['session-lead', 'session-rev', 'session-broken'],
  'rows without an id or name are dropped')
assert.equal(enriched.members[1].turn, 'running', 'the local resolver supplies live turn status')
assert.equal(enriched.members[1].agentId, 'agent-7')
assert.equal(enriched.members[1].current, true, 'the visible session marks its own row')
assert.equal(enriched.members[0].turn, 'unknown', 'a cold roster row reports unknown, never a guessed idle')
assert.equal(enriched.members[2].phase, 'failed')
assert.equal(enriched.members[2].error, 'spawn failed')
assert.deepEqual(enriched.tasks.map(task => task.id), ['3'], 'unknown task statuses are dropped')
assert.equal(enriched.tasks[0].ready, false)
assert.deepEqual(enriched.tasks[0].blockedBy, ['1', '2'])
assert.deepEqual(enriched.tasks[0].writeScopeWarnings, ['src overlaps'])
assert.equal(projectTeamView({ members: [] }), undefined, 'a value without both arrays is not a team view')
assert.equal(projectTeamView(null), undefined)
assert.deepEqual(projectTeamView({ members: [{ id: 'unknown', name: 'unknown', role: 'other-role', phase: 'active' }], tasks: [] }).members, [],
  'unknown roles must not invent teammate membership')
assert.equal(projectTeamView({ members: [], tasks: [], failure: 'bad row' }).failure, 'bad row')

// ── 2. store: feed, seed, resolver, current session ─────────────────────────

const store = new TeamStore()
const feed = createTeamFeed(store)
const leadSession = { id: 'session-lead' }
const teammateSession = { id: 'session-rev', header: { parentSession: 'session-lead' }, subagent: { address: { parentSessionId: 'session-lead' } } }
let storeNotifications = 0
const off = store.subscribe(() => { storeNotifications += 1 })

// The feed carries the whole wire value for the Lead only (the projection
// lives in the Lead's log), which is why nothing is stored for the teammate.
feed(leadSession, 'agentTeam', officialValue)
assert.equal(store.get('session-lead').members.length, 3)
feed(teammateSession, 'agentTeam', officialValue)
assert.equal(store.get('session-rev').members.length, 3, 'a value is keyed by the session it arrived for')
assert.ok(store.get('session-rev').tasks.length > 0, 'and carries the shared board')
store.clear('session-rev')
assert.equal(store.get('session-rev'), undefined, 'clear() drops one session only')
assert.equal(store.get('session-lead').members.length, 3)
assert.equal(storeNotifications, 3, 'each landed value publishes once (lead, teammate, clear)')

// A malformed value must not clear what is already there.
feed(leadSession, 'agentTeam', { nope: true })
assert.equal(store.get('session-lead').members.length, 3, 'a malformed value is ignored, not applied')
feed(leadSession, 'workingActivity', { phase: 'idle', line: '' })
assert.equal(storeNotifications, 3, 'another unit\'s key never reaches this store')

// Runtime enrichment without a team event: the same value re-projects.
store.setRuntimeResolver(sessionId => sessionId === 'session-rev' ? { agentId: 'agent-7', turn: 'running' } : undefined)
assert.equal(store.get('session-lead').members[1].turn, 'running')
assert.equal(storeNotifications, 4, 'a runtime-only change still repaints')

// A cold session (resume) is seeded from the registry snapshot.
let snapshotKeys
const registryStore = new TeamStore()
registryStore.attachRegistry({
  onChanged: () => () => {},
  snapshot: (session, keys) => {
    snapshotKeys = keys
    // The registry answers per session: a session whose log carries no team
    // yields no key, which is what a teammate/dead session looks like.
    const id = String((session as { id: unknown }).id)
    return { values: id === 'session-lead' ? { agentTeam: officialValue } : {} }
  },
})
registryStore.seed(leadSession)
assert.deepEqual(snapshotKeys, ['agentTeam'], 'the seed reads exactly the team key')
assert.equal(registryStore.get('session-lead').members.length, 3)
registryStore.seed({ id: 'session-empty' })
assert.equal(registryStore.get('session-empty'), undefined, 'a session without a team has no value')
registryStore.seed({ id: 'session-lead' })
assert.equal(registryStore.get('session-empty'), undefined, 'and seeding another session does not resurrect it')

// Current-session marking is a re-projection, not a second state owner.
store.setCurrentSession('session-rev')
assert.equal(store.get('session-lead').members[1].current, true)
const beforeOff = storeNotifications
off()
feed(leadSession, 'agentTeam', { ...officialValue, failure: undefined })
assert.equal(storeNotifications, beforeOff, 'an unsubscribed listener is never called again')

// ── 3. Lead walk ────────────────────────────────────────────────────────────

const teamOf = (id: string) => registryStore.get(id)
assert.equal(leadSessionIdOf(teammateSession, teamOf), 'session-lead')
assert.equal(leadSessionIdOf(leadSession), 'session-lead')
assert.equal(leadSessionIdOf(undefined), undefined,
  'a missing session resolves nothing')
// The REAL Session shape, and the field the official kernel itself walks:
// `header.parentSession`. Reading the subagent catalog's field instead (or
// nothing at all) silently returns the teammate's OWN id, whose log carries no
// team — which is exactly the "panel turns into the subagent dashboard as soon
// as you open a member" bug. Pin both, and pin that the header wins.
assert.equal(leadSessionIdOf({ id: 'session-rev', header: { parentSession: 'session-lead' } }, teamOf), 'session-lead',
  'a real teammate Session resolves to its Lead through header.parentSession')
assert.equal(leadSessionIdOf({ id: 'session-rev', header: {} }), 'session-rev',
  'a root Session resolves to itself')
assert.equal(
  leadSessionIdOf({ id: 'session-rev', header: { parentSession: 'session-lead' }, subagent: { address: { parentSessionId: 'session-other' } } }, teamOf),
  'session-lead',
  'the session header is authoritative over the subagent catalog record',
)

assert.equal(leadSessionIdOf({ id: 'ordinary-fork', header: { parentSession: 'session-lead' } }, teamOf), 'ordinary-fork',
  'parent lineage alone cannot make an ordinary child a Team member')
let repeatedSeeds = 0
const stopRepeated = registryStore.subscribe(() => {
  repeatedSeeds++
  assert.ok(repeatedSeeds < 3, 'an unchanged snapshot must not recursively notify')
  registryStore.seed(leadSession)
})
registryStore.seed(leadSession)
assert.equal(repeatedSeeds, 0, 're-reading the same projection is silent')
stopRepeated()

// ── 4. inbox ────────────────────────────────────────────────────────────────

const delivery = {
  id: 'msg-1',
  source: { kind: 'team-message', teamId: 't', messageId: 'msg-1', senderId: 'session-rev', senderName: 'reviewer' },
  content: [{ type: 'text', text: 'The diff needs a test' }],
}
assert.deepEqual(asTeamMessage(delivery), { id: 'msg-1', senderName: 'reviewer', text: 'The diff needs a test' })
assert.equal(asTeamMessage({ id: 'x', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }), undefined,
  'an ordinary user message is not an inbox row')
assert.equal(asTeamMessage({ id: 'x', source: { kind: 'team-message' }, content: [] }), undefined,
  'an empty delivery is dropped')
const inbox = new TeamInboxStore()
let inboxNotifications = 0
inbox.subscribe(() => { inboxNotifications += 1 })
assert.equal(inbox.noteEvent(delivery), true)
assert.equal(inbox.noteEvent(delivery), false, 'a replayed log must not duplicate the message')
assert.equal(inbox.snapshot().length, 1)
assert.equal(inboxNotifications, 1)
assert.equal(inbox.unread(), 1, 'a live delivery counts as unread')
inbox.markRead()
assert.equal(inbox.unread(), 0)
assert.equal(inbox.noteEvent({ ...delivery, source: { ...delivery.source, messageId: 'msg-2' }, id: 'msg-2' }, { silent: true }), true)
assert.equal(inbox.unread(), 0, 'a replayed delivery is folded silently: a resume must not re-announce history')
assert.equal(inbox.snapshot().length, 2, 'but it is still recorded, so the inbox is complete')
assert.equal(inbox.lastSender(), 'reviewer')
inbox.setCurrentSession('session-other')
assert.equal(inbox.snapshot().length, 0, 'rebinding to another Lead clears the page')
assert.equal(inbox.unread(), 0, 'and the unread marking')
const noteCount = inboxNotifications
inbox.setCurrentSession('session-other')
assert.equal(inboxNotifications, noteCount, 'an unchanged binding is a no-op')

// ── 5. panel rendering ──────────────────────────────────────────────────────

const panelTeam = projectTeamView(officialValue, () => undefined, 'session-lead')
const messages = [{ id: 'msg-1', senderName: 'reviewer', text: 'The diff needs a test', at: Date.now() }]

/** Every mounted instance, unmounted at the end so the process can exit. */
const mountedInstances = []

async function renderPanel(props) {
  const stdout = new FakeStdout()
  const stdin = new FakeStdin()
  const element = React.createElement(TeamPanel, {
    team: panelTeam,
    messages,
    page: 'members',
    focusIndex: 0,
    onPage: () => {},
    onFocus: () => {},
    onClose: () => {},
    onOpenMember: () => {},
    onRefresh: () => {},
    ...props,
  })
  const instance = await render(element, { stdout, stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false })
  mountedInstances.push(instance)
  await delay(220)
  const text = plainText(stdout.frames)
  return { text, stdin, instance, stdout }
}

{
  const { text } = await renderPanel({})
  assert.ok(text.includes('团队'), 'the panel title renders')
  assert.ok(text.includes('reviewer'), 'the roster shows teammates')
  assert.ok(text.includes('lead'), 'and the Lead')
  assert.ok(text.includes('Lead'), 'with its role marker')
  assert.ok(text.includes('↑/↓ 选择'), 'and the member key hints')
  assert.ok(!text.includes('这个会话还没有队伍'), 'a populated team shows the roster, not the empty state')
}
{
  const { text } = await renderPanel({ page: 'tasks' })
  assert.ok(text.includes('Ship it'), 'the task subject renders')
  assert.ok(text.includes('[pending]'), 'Claude Code task rows keep the [status] field')
  assert.ok(text.includes('阻塞于 1, 2'), 'and the blocked-by list')
  assert.ok(text.includes('阻塞'), 'the derived state word renders for an unready task')
}
{
  const { text } = await renderPanel({ page: 'inbox' })
  assert.ok(text.includes('@reviewer'), 'the inbox attributes each message to its sender')
  assert.ok(text.includes('The diff needs a test'))
}
{
  const { text } = await renderPanel({ team: undefined, messages: [] })
  assert.ok(text.includes('这个会话还没有队伍'), 'an absent team explains itself instead of rendering blank')
  assert.ok(text.includes('spawn_teammate'), 'and names the tool to call')
}
{
  const failureTeam = projectTeamView({ members: [], tasks: [], failure: 'team/member record rejected' })
  const { text } = await renderPanel({ team: failureTeam, messages: [] })
  assert.ok(text.includes('团队投影损坏'), 'a projection failure is surfaced, never hidden')
  assert.ok(text.includes('team/member record rejected'))
}
{
  // The panel is READ-ONLY: the keys that used to mutate the team now do
  // nothing at all. `i` / `n` / `t` / `w` / `s` must not reach any handler, and
  // every key the panel does own still stops immediate propagation so the
  // global Esc/typing handlers never see a panel keystroke.
  const opened = []
  const stdout = new FakeStdout()
  const stdin = new FakeStdin()
  const instance = await render(
    React.createElement(TeamPanel, {
      team: panelTeam, messages, page: 'members', focusIndex: 1,
      onPage: () => {}, onFocus: () => {}, onClose: () => opened.push('close'), onOpenMember: () => {}, onRefresh: () => {},
    }),
    { stdout, stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
  )
  await delay(200)
  for (const key of ['i', 'n', 't', 'w', 's']) {
    stdin.write(key)
    await delay(60)
  }
  const afterKeys = plainText(stdout.frames)
  assert.ok(!afterKeys.includes('打断'), 'the interrupt confirmation is gone with the action')
  assert.deepEqual(opened, [], 'no action key closes or mutates the panel')
  stdin.write('\u001b')
  await delay(200)
  assert.deepEqual(opened, ['close'], 'Esc still closes the panel')
  await instance.unmount()
}

// ── 6. no /team command; the roster key is the way in ──────────────────────

// The panel is a read-only view of the kernel's own projection, so a `/team`
// command family could only duplicate the window that Ctrl+A already opens.
assert.ok(!LOCAL_COMMANDS.some(command => command.name === 'team'),
  'no /team command: the roster key opens the panel')
assert.ok(!LOCAL_COMMANDS.some(command => command.name === 'agent-team'),
  'and no second spelling of it')

const { Chat } = await import('../src/screens/Chat.js')
const { QuestionStore } = await import('../src/dsh-adapter/questions.js')

/** Fake channel in smoke.tsx's shape, carrying a live team. */
function makeChannel() {
  return {
    version: 0,
    whaleIdle: false,
    rows: [],
    status: 'idle',
    sessionTitle: 'probe',
    sessionId: 'session-lead',
    agentId: 'probe',
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    tokens: { input: 120, output: 45 },
    cwd: 'C:/code/demo-project',
    displayCwd: 'C:/code/demo-project',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting',
    mode: { plan: false },
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    lastUserText: '',
    pending: [],
    commandList: LOCAL_COMMANDS,
    commandCompletions: () => [],
    notifications: [],
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    subscribe: () => () => {},
    team: panelTeam,
    teamMessages: messages,
    agentPreset: 'standard',
    subagents: [],
    submitCalls: [],
    notifyCalls: [],
    localCalls: [],
    attachCalls: [],
    submit(text) { this.submitCalls.push(text) },
    steer() {},
    cancel() {},
    clear() {},
    notify(text) { this.notifyCalls.push(text) },
    pushLocal(title, lines) { this.localCalls.push({ title, lines }) },
    attachToAgent(sessionId) { this.attachCalls.push(sessionId); return Promise.resolve({ ok: true }) },
    refreshTeamProjection() { this.refreshed = (this.refreshed ?? 0) + 1 },
    markTeamRead() { this.readMarks = (this.readMarks ?? 0) + 1 },
    listModels: () => Promise.resolve([]),
    listSubagents: () => Promise.resolve([]),
    listSessions: () => [],
    setResumeTarget: () => {},
    doctorInfo: () => [],
  }
}

/** Mount the real Chat screen against a fake channel and return both. */
async function mountChat(channel) {
  const stdout = new FakeStdout()
  const stdin = new FakeStdin()
  const instance = await render(
    React.createElement(Chat, { channel: channel, questionStore: new QuestionStore() }),
    { stdout, stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
  )
  mountedInstances.push(instance)
  await delay(300)
  return { channel, stdin, stdout }
}

// ── 8. the roster key routes on the durable teammate record ────────────────

{
  // A session that merely CARRIES a team value is not a team: the kernel
  // publishes the Lead-only value in every session of a Team deployment, and its
  // `tryMembership` hands every non-subagent the Lead role. The durable record —
  // the `team/member` events only `spawn_teammate` writes — is what routes, so a
  // Lead with nobody spawned under it gets the subagent dashboard.
  const channel = makeChannel()
  channel.team = { members: [{ name: 'lead', role: 'lead', phase: 'active', current: true, turn: 'idle' }], tasks: [] }
  const { stdin, stdout } = await mountChat(channel)
  stdin.write('\u0001') // Ctrl+A
  await delay(400)
  const text = plainText(stdout.frames)
  assert.ok(text.includes('子代理面板') || text.includes('Subagent'),
    'Ctrl+A falls back to the subagent dashboard when the roster has no teammate')
  assert.ok(!text.includes('还没有收到队友消息'), 'and does not open the team panel')
}

{
  // Opening it must never touch the turn: the panel is a read-only view, so Esc
  // in the panel cannot interrupt a running turn (the old Ctrl+A sharing made
  // this a real bug once).
  const channel = makeChannel()
  channel.working = true
  channel.cancels = 0
  channel.cancel = function () { this.cancels += 1 }
  const { stdin, stdout } = await mountChat(channel)
  stdin.write('\u0001') // Ctrl+A
  await delay(400)
  const withPanel = plainText(stdout.frames)
  assert.ok(withPanel.includes('团队'), 'Ctrl+A opens the panel while a turn runs')
  assert.ok(channel.readMarks >= 1, 'and opening it marks the inbox read')
  assert.ok(withPanel.includes('reviewer'), 'and the roster is on screen')
  stdin.write('\u001b') // Esc
  await delay(400)
  assert.equal(channel.cancels, 0, 'Esc in the panel must not interrupt the running turn')
}

{
  // The predicate is the count the routing and the status-line chip SHARE, so
  // the two can never disagree about whether a team exists.
  assert.equal(teammateCount(undefined), 0, 'no value → no team')
  assert.equal(teammateCount({ members: [{ name: 'lead', role: 'lead', phase: 'active', current: true, turn: 'idle' }], tasks: [] }), 0,
    'a synthesized Lead alone is not a team')
  assert.equal(teammateCount(panelTeam), 2,
    'a real teammate is: the fixture carries reviewer and broken, and a failed member is still a member')
  assert.equal(teammateCount({ members: [...panelTeam.members, { name: 'x', role: 'teammate', phase: 'active', current: false, turn: 'idle' }], tasks: [] }), 3,
    'and every teammate counts')
}

for (const instance of mountedInstances) await instance.unmount()
console.log('verify-team-agents OK (projection narrowing, store feed/seed/resolver, Lead walk, inbox de-dup, read-only panel, no /team command, roster key routes on the durable teammate record and does not interrupt)')
