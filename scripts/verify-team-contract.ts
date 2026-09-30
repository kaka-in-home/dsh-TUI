/**
 * The contract this plugin has with the OFFICIAL Agent Teams runtime, in two
 * halves that must both hold:
 *
 * 1. the pinned runtime surface — what the kernel injects, what its Config
 *    schema still defaults to, that the tool plugin still consumes `agentTeams`,
 *    and that the projection key/fields/typed client surface the TUI reads are
 *    unchanged. A rename here breaks the panel at runtime with no compile error.
 * 2. a REAL mount — the official kernel and tool plugin composed in entry-local
 *    realms (the shape the official profile layer composes: `isolate`ted rows)
 *    publish `agentTeams` and register the `agentTeam` Session projection, and
 *    dispose cleanly.
 *
 * The TUI does not own an Agent-Team preset any more: the official composition
 * is `@deepseek-ai/dsh-experimental-agent-team-profile`, a profile layer that
 * inserts these same two rows at the composition root. So there is no preset
 * document left to validate — only what the TUI must keep agreeing with.
 *
 * Host services the kernel injects are stubbed to their smallest honest shape;
 * the projection registry is the REAL one, because the projection is exactly
 * what this gate exists to pin.
 *
 * Run after build: `node --import tsx/esm scripts/verify-team-contract.ts`.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { compositionRoot } from '../src/dsh-adapter/host-access.js'
import TeamKernel from '@deepseek-ai/dsh-experimental-agent-team'
import * as TeamTools from '@deepseek-ai/dsh-experimental-tool-agent-team'

const require = createRequire(import.meta.url)

// ── The pinned runtime surface ──────────────────────────────────────────────
// What the TUI agrees with the official runtime on. Every item here is a silent
// break at runtime if it moves, so it is asserted against the installed package.

// The two halves define the shape of the row pair any composition has to write:
// which host services each one must see, and what the kernel's Config schema
// defaults to. `team-store.ts` reads the projection the kernel publishes, so a
// change here is a change to what this plugin may assume about its host.
assert.equal(typeof TeamKernel, 'function', 'the kernel package is a plugin (a Service class)')
assert.deepEqual(TeamKernel.inject, ['agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'subagents'],
  'the kernel needs exactly these host services; no composing realm may hide one')
assert.deepEqual(TeamTools.inject, ['agents', 'agentTeams', 'tools', 'systemPrompt'],
  'the tool plugin consumes agentTeams, which is why it must share the kernel realm')

const { Config: kernelConfig } = TeamKernel
assert.ok(kernelConfig !== undefined, 'the kernel keeps a validated Config schema')
for (const [field, floor] of [['maxMembers', 8], ['maxTasks', 256], ['maxPendingMessagesPerMember', 64], ['maxMessageBytes', 65536], ['disposalTimeoutMs', 5000]]) {
  const parsed = kernelConfig({})[field]
  assert.equal(typeof parsed, 'number', `Config.${field} stays a number`)
  assert.ok(parsed >= floor, `Config.${field} default (${parsed}) is at or above the documented floor (${floor})`)
}
assert.equal(typeof TeamTools.apply, 'function', 'the tool plugin exposes an apply() the Loader can call')

// The projection key, its fields, and the published client type surface the TUI
// narrows. `team-store.ts` mirrors these by hand, so a rename would compile
// clean and render an empty panel forever.
const { TEAM_PROJECTION_KEY } = await import('../lib/types/dsh-adapter/team-store.js')
const kernelSource = readFileSync(require.resolve('@deepseek-ai/dsh-experimental-agent-team'), 'utf8')
assert.ok(kernelSource.includes(`key: "${TEAM_PROJECTION_KEY}"`),
  `the kernel must still register the "${TEAM_PROJECTION_KEY}" projection unit the TUI reads`)
for (const field of ['members', 'tasks', 'failure']) {
  assert.ok(kernelSource.includes(field), `the agentTeam projection still carries "${field}"`)
}
const clientSurface = readFileSync(
  fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-experimental-agent-team/client')).replace(/\.js$/u, '.d.ts'),
  'utf8',
)
for (const field of ['TeamMemberView', 'TeamTaskView', 'TeamProjection']) {
  assert.ok(clientSurface.includes(field), `the published client type surface still declares ${field}`)
}
// The durable truth the roster is read from: a Lead alone is NOT a member row.
// `buildTeamProjection` synthesizes the lead and appends `state.members`, so an
// empty `members` array is exactly "nobody spawned yet" — the one session-level
// fact that separates a team from every other session in the same deployment.
assert.ok(/members: \[\]/u.test(kernelSource), 'an empty Team state carries no teammate rows')

const root = new Context()
root.baseUrl = new URL('../cordis.patch.yml', import.meta.url).href
// Load the TUI's own root guard BEFORE mounting anything: that is the state the
// real boot is in, and it is the exact condition under which the official Agent
// Teams rows used to fail. `host-access.ts` guards the root fiber's `effect`
// (released, see the comment there) plus `restart`/`dispose`/`update` and the
// registry surface. Mounting the kernel from here now proves the release works;
// putting the `root.effect` guard back MUST fail this gate with
// `root.effect is unavailable from a plugin activation`.
compositionRoot(root)

/** Tool registrations the model-facing plugin publishes. */
const registeredTools = []
const toolsRegistry = {
  register(name, definition) {
    registeredTools.push(name)
    return () => {
      const index = registeredTools.indexOf(name)
      if (index !== -1) registeredTools.splice(index, 1)
    }
  },
}

try {
  await root.plugin(ctx => {
    // Minimal honest shapes for the host services the Team rows inject.
    ctx.provide('agents', { list: () => [], get: () => undefined })
    ctx.provide('sessions', {})
    ctx.provide('sessionPersistence', {})
    ctx.provide('subagents', {})
    ctx.provide('tools', toolsRegistry)
    ctx.provide('systemPrompt', {})
  })
  await root.plugin(SessionProjectionRegistry)

  // The official rows carry `isolate` realms, so they publish into their own
  // composition rather than the process-global root. Reproduce exactly that:
  // a kernel instance the host root must not see.
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
  assert.ok(service !== undefined, 'the kernel publishes `agentTeams`')
  assert.equal(typeof service.listMembers, 'function')
  assert.equal(typeof service.spawnTeammate, 'function')
  assert.equal(typeof service.sendMessage, 'function')
  assert.equal(typeof service.createTask, 'function')
  assert.equal(typeof service.updateTask, 'function')
  assert.equal(typeof service.interrupt, 'function')
  assert.equal(typeof service.waitForChange, 'function')
  // The realm is real: the host root must NOT see this instance.
  assert.equal(root.get('agentTeams'), undefined,
    'an entry-local realm keeps the kernel out of the host root')

  // The projection unit is registered on the ROOT registry (the kernel calls
  // `ctx.root.sessionProjections.register`), which is what makes the TUI's
  // host-plane reader — a different realm entirely — able to see team state.
  // The registry reads a Session's own read face: its seq cursor, the
  // immutable header, the inherited prefix length, and the events.
  const fakeSession = {
    id: 'session-mount-proof',
    seq: 0,
    header: { id: 'session-mount-proof' },
    inheritedEventCount: 0,
    snapshotEvents: () => [],
  }
  const snapshot = root.sessionProjections.snapshot(fakeSession, ['agentTeam'])
  const team = snapshot.values.agentTeam
  assert.ok(team !== undefined, 'the `agentTeam` projection is registered and readable from the host root')
  // A team always contains its Lead: the TUI counts only `teammate` rows when
  // deciding whether a session has a team at all (see team-view helpers).
  assert.deepEqual(team.members.map(member => [member.name, member.role, member.phase]),
    [['lead', 'lead', 'active']], 'an empty log already carries the Lead row')
  assert.deepEqual(team.tasks, [], 'and no tasks')
  assert.equal(team.failure, undefined)

  // The model-facing half installs the Team tools into an exact AGENT scope
  // (its `apply` walks `ctx.agents.list()` and follows `agent/created`), so
  // mounting it registers nothing by itself — the inject list above is the
  // whole plugin-level contract. That is also why a composition enabling teams
  // has to keep the spawn/fork subagent PROVIDERS alive: the teammate's agent
  // scope is what the tools land in.
  //
  // A non-roster agent (one the registry does not own) resolves no
  // membership — the same check the tool plugin performs before installing.
  const stranger = { id: 'agent-stranger', ctx: group }
  assert.equal(service.tryMembership(stranger), undefined,
    'an agent the roster does not own resolves no Team membership')
  assert.equal(registeredTools.length, 0, 'mounting the tool plugin alone publishes no tool')

  // Teardown must dispose both the service and its projection registration.
  await kernelFiber.dispose()
  assert.equal(root.sessionProjections.snapshot(fakeSession, ['agentTeam']).values.agentTeam, undefined,
    'disposal unregisters the projection unit')
  assert.equal(group.get('agentTeams'), undefined, 'and withdraws the service')
} finally {
  await root.fiber.dispose()
}

console.log('verify-team-contract OK (kernel/tool inject lists and Config schema pinned, projection key/fields/client surface pinned, official kernel + tools mount in entry-local realms with agentTeams service and agentTeam projection live and disposable)')
