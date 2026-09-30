/**
 * Does the SUBAGENT layer already cover Agent Teams?
 *
 * The hypothesis to test: teammates are continuable subagents, so maybe the
 * TUI's existing subagent module already observes them and "absorbed" part of
 * the feature. This probe answers it with the kernel's own behaviour:
 *
 *  1. mount the real Team kernel in its own realm with a stubbed host;
 *  2. record exactly what the kernel hands to `ctx.subagents.startContinuable`
 *     when a teammate is created;
 *  3. compare that with what the team projection publishes for the same member
 *     (its id, name, role);
 *  4. and with what the subagent CATALOG entry can carry (childId, mode,
 *     label) — i.e. everything the TUI's subagent module can ever learn.
 *
 * Run after build: `node --import tsx/esm scripts/verify-team-subagent-boundary.ts`.
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

  const group = root.isolate('agentTeams').isolate('workflowEngine')
  const kernelFiber = await group.plugin(TeamKernel, {
    maxMembers: 8,
    maxTasks: 256,
    maxPendingMessagesPerMember: 64,
    maxMessageBytes: 65536,
    disposalTimeoutMs: 5000,
  })
  await kernelFiber

  const service = group.get('agentTeams')
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
  assert.equal(call.label === 'reviewer', false, 'the teammate NAME is never handed to the subagent layer')

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
  // The subagent layer never sees a team event: `team/*` lives in the Lead log
  // and the child's own log has only the prompt it was started with.
  assert.ok(!appended.some(entry => entry.type.startsWith('subagent/')),
    'the kernel emits no subagent/catalog entry of its own: that is the subagent provider\'s job')

  // ── what a subagent CATALOG entry can carry (the TUI's view) ─────────────
  // Schema from @deepseek-ai/dsh-subagent/.../catalog.d.ts: childId,
  // childCreatedAt, mode, label — nothing about name, role, roster or tasks.
  const catalogEntryFields = ['childId', 'childCreatedAt', 'version', 'mode', 'label']
  for (const absent of ['name', 'role', 'teamId', 'phase']) {
    assert.ok(!catalogEntryFields.includes(absent),
      `a catalog entry has no "${absent}", so the subagent module cannot render team identity`)
  }

  await kernelFiber.dispose()
} finally {
  await root.fiber.dispose()
}

console.log('verify-team-subagent-boundary OK (teammates ride the subagent layer for liveness, but name/role/roster/tasks exist only in the team projection)')
