/**
 * Mount the official Team kernel and tools as root rows after the TUI's guard.
 * Read the real projection through the production adapter, then verify that
 * tool/prompt contributions stay in the Agent context and are disposed.
 * The host registry and Session are real; the tool/prompt registries below are
 * minimal registration/disposer stubs. No model or subprocess is started.
 * Run: node --import tsx/esm scripts/verify-team-contract.ts
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import TeamKernel from '@deepseek-ai/dsh-experimental-agent-team'
import * as TeamTools from '@deepseek-ai/dsh-experimental-tool-agent-team'
import { compositionRoot } from '../src/dsh-adapter/host-access.js'
import { projectTeamView, TEAM_PROJECTION_KEY } from '../src/dsh-adapter/team-store.js'

const expectedTools = [
  'spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
  'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update',
].sort()

function registries() {
  const tools = new Map<string, ToolDefinition>()
  const sections = new Map<string, PromptSection>()
  return {
    tools,
    sections,
    toolRegistry: {
      register(definition: ToolDefinition) {
        assert.equal(tools.has(definition.name), false, `duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        return () => { tools.delete(definition.name) }
      },
    },
    promptRegistry: {
      getSectionOrder: () => 100,
      section(section: PromptSection) {
        assert.equal(sections.has(section.name), false, `duplicate section ${section.name}`)
        sections.set(section.name, section)
        return () => { sections.delete(section.name) }
      },
    },
  }
}

const root = new Context()
root.baseUrl = new URL('../cordis.patch.yml', import.meta.url).href
compositionRoot(root)
const agents = new Map<string, Agent>()
const host = registries()

async function makeAgent(id: string) {
  const local = registries()
  let agentContext: Context | undefined
  await root.plugin(ctx => {
    agentContext = ctx.isolate('tools').isolate('systemPrompt')
    agentContext.provide('tools', local.toolRegistry)
    agentContext.provide('systemPrompt', local.promptRegistry)
  })
  assert.ok(agentContext)
  const session = Session.create(SessionId(id))
  // The kernel needs exact registry identity, Session and the Agent's own
  // Context here; executing a model turn is intentionally outside this gate.
  const agent = { id: session.id, session, ctx: agentContext, options: {}, status: 'idle' } as unknown as Agent
  agents.set(id, agent)
  return { agent, session, ...local }
}

try {
  await assert.rejects(async () => {
    await root.plugin(ctx => { ctx.root.effect(() => () => {}, 'forbidden-root-effect') })
  }, /root\.effect is unavailable from a plugin activation/u,
  'ordinary plugins must not attach effects to the root lifecycle')

  await root.plugin(ctx => {
    ctx.provide('agents', { list: () => [...agents.values()], get: (id: string) => agents.get(id) })
    ctx.provide('sessions', { flush: async () => {} })
    ctx.provide('sessionPersistence', {})
    ctx.provide('subagents', { drainContinuableChildren: async () => {} })
    ctx.provide('tools', host.toolRegistry)
    ctx.provide('systemPrompt', host.promptRegistry)
  })
  await root.plugin(SessionProjectionRegistry)
  let getterAttempted = false
  await assert.rejects(async () => {
    await root.plugin(ctx => {
      ctx.root.sessionProjections.register({
        get key() {
          getterAttempted = true
          ctx.root.effect(() => () => {}, 'forbidden-definition-getter')
          return 'forbidden-definition-getter'
        },
      } as never)
    })
  }, /root\.effect is unavailable from a plugin activation/u,
  'caller-owned definition getters must not inherit registry privileges')
  assert.equal(getterAttempted, true, 'the registration exercised the caller-owned getter')
  const delayed = Promise.withResolvers<void>()
  let retainedRegistration: Promise<unknown> | undefined
  const retired = await root.plugin(ctx => {
    retainedRegistration = delayed.promise.then(() => ctx.root.sessionProjections.onChanged(() => {}))
  })
  await retired.dispose()
  delayed.resolve()
  await assert.rejects(retainedRegistration!, /requires a live Cordis activation context/u,
    'a disposed plugin cannot register a host projection subscription through a retained callback')

  const lead = await makeAgent('team-contract-lead')
  const kernel = await root.plugin(TeamKernel)
  const service = root.get('agentTeams')
  assert.ok(service, 'the official root row publishes its kernel service')
  assert.equal(service.tryMembership(lead.agent)?.role, 'lead', 'the live registry owns this exact Lead')

  const tools = await root.plugin(TeamTools)
  assert.deepEqual([...lead.tools.keys()].sort(), expectedTools, 'the official tool plugin installs every Team tool in the Agent context')
  assert.equal(lead.sections.has('team:policy'), true, 'the Agent gets the Team prompt policy')
  assert.equal(host.tools.size, 0, 'Team tools do not register globally')
  assert.equal(host.sections.size, 0, 'Team policy does not register globally')

  const readTeam = () => projectTeamView(
    root.sessionProjections.snapshot(lead.session, [TEAM_PROJECTION_KEY]).values[TEAM_PROJECTION_KEY],
  )
  const empty = readTeam()
  assert.ok(empty, 'the production adapter narrows the official projection')
  assert.deepEqual(empty.members.map(member => [member.sessionId, member.name, member.role]),
    [[lead.session.id, 'lead', 'lead']])
  assert.deepEqual(empty.tasks, [])
  assert.equal(empty.failure, undefined)

  const createTask = lead.tools.get('team_task_create')!
  await createTask.execute({ subject: 'Verify projection', description: 'Read the official task row' }, {
    agent: lead.agent, signal: new AbortController().signal,
  } as never)
  const populated = readTeam()
  assert.equal(populated?.tasks.length, 1, 'a real Team tool writes a task readable through the production adapter')
  assert.equal(populated?.tasks[0]?.subject, 'Verify projection')
  assert.equal(populated?.tasks[0]?.status, 'pending')

  const late = await makeAgent('team-contract-late')
  root.emit('agent/created', { agent: late.agent })
  assert.deepEqual([...late.tools.keys()].sort(), expectedTools, 'a subsequently published Agent also receives scoped tools')
  agents.delete(late.agent.id)
  root.emit('agent/disposed', { agent: late.agent })
  assert.equal(late.tools.size, 0, 'agent disposal removes its tools')
  assert.equal(late.sections.size, 0, 'agent disposal removes its prompt policy')

  await tools.dispose()
  assert.equal(lead.tools.size, 0, 'tool-plugin disposal removes surviving Agent registrations')
  assert.equal(lead.sections.size, 0, 'tool-plugin disposal removes surviving prompt policy')
  assert.ok(readTeam(), 'removing the tool plugin leaves the kernel projection available')
  await kernel.dispose()
  assert.equal(root.get('agentTeams'), undefined, 'kernel disposal withdraws the service')
  assert.equal(readTeam(), undefined, 'kernel disposal unregisters the projection')
} finally {
  await root.fiber.dispose()
}
console.log('verify-team-contract OK (guarded root kernel/tools mount, agent-scoped tools/policy, real task projection narrowing, Agent/plugin/kernel cleanup)')
