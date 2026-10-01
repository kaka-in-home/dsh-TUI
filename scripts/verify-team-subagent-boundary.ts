/**
 * Observe the real Team kernel's spawn request and durable member transitions.
 * The subagent provider is stubbed: this gate proves the provider/session-id
 * join used by the TUI, not what every upstream catalog schema may contain.
 * Run: node --import tsx/esm scripts/verify-team-subagent-boundary.ts
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TeamKernel from '@deepseek-ai/dsh-experimental-agent-team'

/** What the kernel asked the subagent layer for, verbatim. */
const spawnCalls = []

const root = new Context()
root.baseUrl = new URL('../cordis.patch.yml', import.meta.url).href

/** A Lead session: the kernel appends team events to it and flushes it. */
const appended = []
const leadSession = {
  id: 'session-lead',
  seq: 0,
  header: { id: 'session-lead' },
  inheritedEventCount: 0,
  snapshotEvents: () => [],
  append(type, data) {
    appended.push({ type, data, seq: this.seq })
    this.seq += 1
  },
  eventAt(seq) {
    return appended.find(entry => entry.seq === seq)
  },
}

const leadAgent = { id: 'session-lead', session: leadSession, ctx: root }

/**
 * The child Session the subagent provider would create. The kernel does not
 * make it; in a real host `startContinuable` does. Its only job here is to
 * accept the initial prompt the kernel then checkpoints.
 */
let childSessionId = ''
const childSession = {
  id: 'session-child',
  inheritedEventCount: 0,
  snapshotEvents: () => [],
}

try {
  await root.plugin(ctx => {
    ctx.provide('agents', { list: () => [leadAgent], get: id => (id === 'session-lead' ? leadAgent : undefined) })
    ctx.provide('sessions', {
      flush: async () => {},
      // The child session the spawn created is live in a real host; here it is
      // only needed for the initial-prompt checkpoint, which reads the prompt
      // message the provider accepted.
      get: id => (id === childSessionId ? childSession : undefined),
    })
    ctx.provide('sessionPersistence', {
      // Only reached when the child Session is NOT live; a real store would
      // answer with the persisted log.
      async open() {
        return {
          header: { id: 'session-child' },
          inheritedEventCount: 0,
          async read() { return { events: [] } },
          async close() {},
        }
      },
    })
    ctx.provide('tools', { register: () => () => {} })
    ctx.provide('systemPrompt', {})
    // The subagent registry the kernel drives. `startContinuable` is the ONLY
    // call it makes to create a teammate.
    ctx.provide('subagents', {
      async startContinuable(options) {
        spawnCalls.push(options)
        childSessionId = options.childId
        childSession.id = options.childId
        // A real provider appends the accepted user message; the kernel waits
        // for exactly that acknowledgement before the member turns active.
        childSession.snapshotEvents = () => [{
          type: 'user/message',
          seq: 0,
          data: { id: 'message-1', source: { kind: 'user' }, content: options.request.prompt },
        }]
        return { messageId: 'message-1' }
      },
      async drainContinuableChildren() {},
      interrupt() {},
    })
  })
  await root.plugin(SessionProjectionRegistry)

  const kernelFiber = await root.plugin(TeamKernel)
  const service = root.get('agentTeams')
  const result = await service.spawnTeammate(leadAgent, {
    name: 'reviewer',
    description: 'Reviews the diff',
    prompt: [{ type: 'text', text: 'Read the diff and report' }],
    context: 'fresh',
    provider: 'spawn',
    signal: new AbortController().signal,
  })

  // ── what the SUBAGENT layer was asked for ────────────────────────────────
  assert.equal(spawnCalls.length, 1, 'the kernel creates a teammate through the subagent registry')
  const call = spawnCalls[0]
  assert.equal(call.provider, 'spawn', 'the Team `freshProvider` config names the subagent provider')
  assert.equal(call.label, 'Reviews the diff', 'the subagent layer receives the member DESCRIPTION as the label')
  assert.equal(call.request.parent, leadAgent, 'the Lead is the delegating parent, so the child is scopable to it')
  assert.equal(typeof call.childId, 'string')

  // ── what the TEAM layer publishes for the same member ───────────────────
  assert.equal(result.member.name, 'reviewer')
  assert.equal(result.member.role, 'teammate')
  assert.equal(
    result.member.id,
    call.childId,
    'the roster row id IS the subagent child session id — the join key the TUI uses',
  )
  assert.equal(result.member.description, 'Reviews the diff',
    'and the label the subagent layer got is the same string as the member description')

  // ── what actually landed in the Lead log ─────────────────────────────────
  const teamEvents = appended.filter(entry => entry.type.startsWith('team/'))
  // Two writes: the `provisioning` member, then its `active` settlement.
  assert.deepEqual(teamEvents.map(entry => entry.type), ['team/member', 'team/member'],
    'the roster is a durable Lead-log fact, written whole on every phase change')
  assert.deepEqual(teamEvents.map(entry => entry.data.member.phase), ['provisioning', 'active'])
  assert.equal(teamEvents[0].data.member.name, 'reviewer')
  assert.equal(teamEvents[0].data.member.id, call.childId)
  assert.equal(teamEvents[0].data.teamId, 'session-lead')
  // The kernel itself writes its member transitions to the Lead log. This
  // provider stub only accepts the child prompt; it does not write a catalog.
  assert.ok(!appended.some(entry => entry.type.startsWith('subagent/')),
    'the kernel emits no subagent/catalog entry of its own: that is the subagent provider\'s job')

  await kernelFiber.dispose()
} finally {
  await root.fiber.dispose()
}

console.log('verify-team-subagent-boundary OK (real kernel spawn request, provider/session join, durable provisioning/active member transitions)')
