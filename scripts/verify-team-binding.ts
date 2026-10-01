/** Real Channel adoption + official Session/projection regression. No credentials or model calls. */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import ProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TeamKernel from '@deepseek-ai/dsh-experimental-agent-team'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createChannel } from '../src/dsh-adapter/channel.js'
import { createTeamStore } from '../src/dsh-adapter/team-store.js'
import { TeamInboxStore } from '../src/dsh-adapter/team-inbox.js'
import { createSubagentProjection } from '../src/dsh-adapter/channel/subagent-projection.js'
import { createChannelOwner } from '../src/dsh-adapter/channel/owner.js'

const root = new Context()
root.baseUrl = new URL('../cordis.patch.yml', import.meta.url).href
const live = new Map()
const sessions = new Map()
let readCloses = 0
const owner = createChannelOwner()
let channel

function makeSession(id, parent) {
  const key = SessionId(id)
  const base = Session.create(key)
  const session = Session.create(key, [], { ...base.header, cwd: '/tmp', ...(parent === undefined ? {} : { parentSession: SessionId(parent) }) })
  sessions.set(id, session)
  return session
}
function makeAgent(session, model = 'fixture-model') {
  const agent = {
    id: session.id, session, status: 'idle', options: { provider: 'fixture', model },
    ctx: root.extend(), followup() {}, steer() {}, cancel() {}, inbox: { remove: () => true },
  }
  live.set(String(session.id), agent)
  return agent
}
function receive(session, id, senderName) {
  const message = createUserMessage({ content: [{ type: 'text', text: `message-${id}` }], source: { kind: 'team-message', teamId: 'leader', messageId: id, senderName } })
  return session.append('user/message', message, { surfaceOp: 'append' })
}
try {
  await root.plugin(ctx => {
    ctx.provide('agents', { list: () => [...live.values()], get: id => live.get(String(id)) })
    ctx.provide('sessions', { get: id => sessions.get(String(id)), flush: async () => {} })
    ctx.provide('subagents', { async drainContinuableChildren() {} })
    ctx.provide('sessionPersistence', {
      async list() { return [] },
      async open(id) {
        const session = sessions.get(String(id))
        assert.ok(session, 'only existing logs may be read')
        return {
          header: session.header, inheritedEventCount: session.inheritedEventCount,
          async read() { return { events: session.snapshotEvents() } },
          async close() { readCloses++ },
        }
      },
    })
    ctx.provide('llm', { listConfigurableProviders: () => [], discoverModels: async () => [] })
  })
  await root.plugin(ProjectionRegistry)
  await root.plugin(TeamKernel)
  const leader = makeSession('leader')
  const member = makeSession('member', 'leader')
  const ordinary = makeSession('ordinary-child', 'leader')
  const record = { id: 'member', name: 'reviewer', description: 'Reviews changes', provider: 'spawn', context: 'fresh' }
  leader.append('team/member', { version: 2, teamId: 'leader', member: { ...record, phase: 'provisioning' } })
  leader.append('team/member', { version: 2, teamId: 'leader', member: { ...record, phase: 'active' } })
  receive(leader, 'lead-mail', 'reviewer')
  receive(member, 'member-mail', 'lead')
  const leadAgent = makeAgent(leader)
  const memberAgent = makeAgent(member, 'member-model')
  const ordinaryAgent = makeAgent(ordinary)
  const store = createTeamStore(root)
  const inbox = new TeamInboxStore()
  channel = createChannel(root, leadAgent, { model: 'fixture-model', provider: 'fixture', cwd: '/tmp', activity: false, teamStore: store, teamInbox: inbox })
  const initialized = Date.now() + 1000
  while (channel.team === undefined && Date.now() < initialized) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(channel.team.members.length, 2)
  assert.equal(channel.team.members.find(m => m.current).sessionId, 'leader')
  assert.deepEqual(channel.teamMessages.map(m => m.id), ['lead-mail'], 'initial replay survives subsequent binding')

  let notifications = 0
  const off = store.subscribe(() => { notifications++ })
  assert.equal((await channel.attachToAgent('member')).ok, true)
  assert.equal(channel.sessionId, 'member')
  assert.equal(channel.team.members.find(m => m.current).sessionId, 'member')
  assert.deepEqual(channel.teamMessages.map(m => m.id), ['member-mail'], 'member inbox never contains the Lead inbox')
  const stable = channel.team
  channel.refreshTeamProjection()
  assert.equal(channel.team, stable, 'unchanged manual refresh keeps the published reference')
  member.append('request/context', { provider: 'fixture', model: 'effective-member-model' })
  memberAgent.status = 'running'
  root.emit('agent/status', { agent: memberAgent, status: 'running' })
  assert.equal(channel.team.members.find(m => m.sessionId === 'member').model, 'effective-member-model', 'model display follows the actual request context')
  assert.equal(channel.team.members.find(m => m.sessionId === 'member').turn, 'running', 'live member state refreshes after adoption')
  memberAgent.status = 'idle'
  root.emit('agent/status', { agent: memberAgent, status: 'idle' })
  assert.equal((await channel.attachToAgent('leader')).ok, true)
  assert.deepEqual(channel.teamMessages.map(m => m.id), ['lead-mail'], 'returning to Lead rebuilds its own inbox')
  assert.equal(channel.team.members.find(m => m.current).sessionId, 'leader')
  assert.equal((await channel.attachToAgent('ordinary-child')).ok, true)
  assert.equal(channel.team.members.some(m => m.role === 'teammate'), false, 'ordinary children do not inherit the parent Team')

  assert.equal((await channel.attachToAgent('member')).ok, true)
  live.delete('leader')
  store.clear('leader')
  channel.refreshTeamProjection()
  const deadline = Date.now() + 1500
  while (channel.team?.members.length !== 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(channel.team.members.length, 2, 'offline Lead is restored read-only from its durable log')
  assert.ok(readCloses > 0, 'persisted read handles are closed')
  assert.ok(notifications < 50, 'session changes and unchanged refreshes never produce a notification loop')
  off()

  // Stable projection subscriptions survive store replacement and retain parked parents.
  let agent = leadAgent
  const state = { rows: [], subagents: [], subagentCost: [], emit() {}, emitStream() {} }
  const sub = createSubagentProjection(() => state, { rowIds: { value: 0 }, agent: () => agent, subagents: () => undefined, lookupChild: () => undefined })
  let changes = 0
  const stop = sub.subscribe(() => changes++)
  const old = sub.store
  sub.park(leadAgent)
  agent = memberAgent
  sub.reset()
  sub.store.onSpawned('new-child', 'spawn', 'fixture-model', { sessionId: 'new-child-session' })
  assert.ok(changes > 0, 'replacement stores still notify the stable subscription')
  old.onSpawned('parked-child', 'spawn', 'fixture-model', { sessionId: 'parked-child-session' })
  assert.equal(sub.findBySessionId('parked-child-session').agentId, 'parked-child', 'parked parent metadata remains readable')
  sub.dispose()
  stop()
  const beforeLate = changes
  old.patch('parked-child', { status: 'completed' })
  assert.equal(changes, beforeLate, 'teardown removes every forwarded subscription')
  const forkId = SessionId('fork-member')
  const fork = Session.create(forkId, leader.snapshotEvents(), {
    ...Session.create(forkId).header, parentSession: leader.id, isSeeded: true, cwd: '/tmp',
  }, leader.seq)
  sessions.set(String(forkId), fork)
  const forkRecord = { ...record, id: String(forkId), name: 'fork-reviewer', context: 'fork' }
  leader.append('team/member', { version: 2, teamId: 'leader', member: { ...forkRecord, phase: 'provisioning' } })
  leader.append('team/member', { version: 2, teamId: 'leader', member: { ...forkRecord, phase: 'active' } })
  receive(fork, 'own-fork-mail', 'lead')
  live.set('leader', leadAgent)
  const forkAgent = makeAgent(fork)
  channel.releaseContributions()
  channel = createChannel(root, forkAgent, { model: 'fixture-model', provider: 'fixture', cwd: '/tmp', activity: false, teamStore: store, teamInbox: new TeamInboxStore() })
  assert.equal(channel.team.members.find(m => m.current).sessionId, 'fork-member')
  assert.deepEqual(channel.teamMessages.map(m => m.id), ['own-fork-mail'], 'a fork member never reports inherited Lead deliveries as its own inbox')
  console.log('verify-team-binding OK (real Session/registry/Channel; Lead→member→Lead, own recipient replay/fork prefix, unchanged seeds, ordinary child, offline Lead, replacement subscriptions)')
} finally {
  channel?.releaseContributions()
  owner.dispose()
  await root.fiber.dispose()
}
