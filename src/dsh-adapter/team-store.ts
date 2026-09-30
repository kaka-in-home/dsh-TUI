/**
 * Agent-Team read face: the official `agentTeam` Session projection wired into
 * the TUI.
 *
 * The Team service (`@deepseek-ai/dsh-experimental-agent-team`) is composed by
 * the deployment — the official `dsh-experimental-agent-team-profile` layer
 * inserts it at the composition root — and publishes a projection unit under
 * the key `agentTeam`. That projection is the ONLY client-visible team state:
 * the official Web UI drives the same runtime, so this module reads the value
 * and never owns a second copy of roster or task state.
 *
 * Registration is deferred through `inject` because the plugin that *publishes*
 * the unit may be mounted at any time, possibly long after this plugin mounted:
 * a composition without the Team layer simply never fills the store, and the UI
 * falls back to "no team".
 *
 * @module dsh-tui/dsh-adapter/team-store
 */

import type { Context } from '@deepseek-ai/cordis'
import React from 'react'
import type {
  TeamMemberPhase,
  TeamMemberRow,
  TeamMemberTurn,
  TeamTaskRow,
  TeamTaskStatus,
  TeamView,
} from '../adapter/ports/channel-view.js'
export type {
  TeamMemberPhase,
  TeamMemberRow,
  TeamMemberTurn,
  TeamTaskRow,
  TeamTaskStatus,
  TeamView,
} from '../adapter/ports/channel-view.js'

/** The projection key the official Agent-Teams plugin publishes. */
export const TEAM_PROJECTION_KEY = 'agentTeam'

/**
 * The raw wire value of the `agentTeam` unit, exactly as
 * `TeamProjection` declares it (structural copy — see ADAPTER.md).
 */
interface RawTeamMember {
  readonly id?: unknown
  readonly name?: unknown
  readonly role?: unknown
  readonly phase?: unknown
  readonly error?: unknown
}

interface RawTeamTask {
  readonly id?: unknown
  readonly revision?: unknown
  readonly subject?: unknown
  readonly description?: unknown
  readonly status?: unknown
  readonly blockedBy?: unknown
  readonly writeScopes?: unknown
  readonly ownerName?: unknown
  readonly ready?: unknown
  readonly writeScopeWarnings?: unknown
}

interface RawTeamProjection {
  readonly members?: unknown
  readonly tasks?: unknown
  readonly failure?: unknown
}

/** The slice of the host projection registry this module uses. */
export interface TeamProjectionRegistryLike {
  onChanged(listener: (
    session: { readonly id: unknown },
    key: string,
    value: unknown,
    seq: number,
  ) => void): () => void
  snapshot(session: unknown, keys?: readonly string[]): { readonly values: Record<string, unknown> }
}

/**
 * Locally observed runtime facts for one member, cross-referenced by the
 * adapter from the subagent projection. All fields are optional: a cold roster
 * row (a member this process never hosted) enriches to nothing and renders
 * from the durable phase alone.
 */
export interface TeamMemberRuntime {
  readonly agentId: string
  readonly turn: TeamMemberTurn
  readonly model?: string
  readonly description?: string
}

/** Resolver the composition root supplies to cross-reference team rows. */
export type TeamRuntimeResolver = (sessionId: string) => TeamMemberRuntime | undefined

const PHASES = new Set<string>(['provisioning', 'active', 'failed'])
const STATUSES = new Set<string>(['pending', 'in_progress', 'completed'])
const ROLES = new Set<string>(['lead', 'teammate'])

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * Narrow one projection value: anything that is not a well-formed team view is
 * dropped rather than rendered half-formed.
 * @param value - Raw projection value.
 * @returns the value as a raw team projection, or `undefined`.
 */
export function asTeamProjection(value: unknown): RawTeamProjection | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as RawTeamProjection
  if (!Array.isArray(record.members) || !Array.isArray(record.tasks)) return undefined
  return record
}

/**
 * Convert one raw projection into the renderer-facing view.
 *
 * Unknown enum members are dropped (a newer projection version must not crash
 * an older TUI); a member row without a usable id or name is dropped too,
 * because it could not be navigated to.
 *
 * @param value - Raw projection value.
 * @param resolve - Optional runtime cross-reference resolver.
 * @param currentSessionId - Session the UI is showing (marks the current row).
 * @returns the view, or `undefined` when the value is not a team projection.
 */
export function projectTeamView(
  value: unknown,
  resolve?: TeamRuntimeResolver,
  currentSessionId?: string,
): TeamView | undefined {
  const raw = asTeamProjection(value)
  if (raw === undefined) return undefined

  const members: TeamMemberRow[] = []
  for (const entry of raw.members as readonly unknown[]) {
    if (entry === null || typeof entry !== 'object') continue
    const member = entry as RawTeamMember
    const sessionId = asString(member.id)
    const name = asString(member.name)
    if (sessionId === undefined || name === undefined) continue
    const role = asString(member.role)
    const phase = asString(member.phase)
    const runtime = resolve?.(sessionId)
    const error = asString(member.error)
    members.push({
      sessionId,
      name,
      role: role !== undefined && ROLES.has(role) ? role as 'lead' | 'teammate' : 'teammate',
      phase: phase !== undefined && PHASES.has(phase) ? phase as TeamMemberPhase : 'provisioning',
      turn: runtime?.turn ?? 'unknown',
      current: currentSessionId !== undefined && sessionId === currentSessionId,
      ...(error === undefined ? {} : { error }),
      ...(runtime?.agentId === undefined ? {} : { agentId: runtime.agentId }),
      ...(runtime?.model === undefined ? {} : { model: runtime.model }),
      ...(runtime?.description === undefined ? {} : { description: runtime.description }),
    })
  }

  const tasks: TeamTaskRow[] = []
  for (const entry of raw.tasks as readonly unknown[]) {
    if (entry === null || typeof entry !== 'object') continue
    const task = entry as RawTeamTask
    const id = asString(task.id)
    const subject = asString(task.subject)
    const status = asString(task.status)
    if (id === undefined || subject === undefined || status === undefined) continue
    if (!STATUSES.has(status)) continue
    const ownerName = asString(task.ownerName)
    tasks.push({
      id,
      revision: typeof task.revision === 'number' ? task.revision : 0,
      subject,
      description: asString(task.description) ?? '',
      status: status as TeamTaskStatus,
      blockedBy: asStringArray(task.blockedBy),
      writeScopes: asStringArray(task.writeScopes),
      ...(ownerName === undefined ? {} : { ownerName }),
      ready: task.ready === true,
      writeScopeWarnings: asStringArray(task.writeScopeWarnings),
    })
  }

  const failure = asString(raw.failure)
  return {
    members,
    tasks,
    ...(failure === undefined ? {} : { failure }),
  }
}

/**
 * How many durable TEAMMATES this view carries.
 *
 * This is the one fact that tells a team session from every other session in the
 * same deployment, and it is the kernel's own, not a local inference. The kernel
 * synthesizes the Lead row in `buildTeamProjection` and appends `state.members`;
 * that array only ever grows through `spawnTeammate`, whose single write is a
 * durable `team/member` event in the Lead's session log. So:
 *
 * - an empty roster means nobody has been spawned yet — the session is a Lead
 *   with team tools available, which is what EVERY session in a composition
 *   carrying the kernel looks like (its `tryMembership` falls back to
 *   `{ role: 'lead' }` for anything that is not a subagent);
 * - a non-zero count means a real team is running here.
 *
 * Counted through the projection rather than by scanning the log, because the
 * projection is the read face built from exactly those events.
 * @param team - The projected view, or undefined when no team value exists.
 * @returns The teammate count (`members` minus the synthetic Lead).
 */
export function teammateCount(team: TeamView | undefined): number {
  return team === undefined ? 0 : team.members.filter(member => member.role === 'teammate').length
}

/**
 * Whether two projected views carry the same roster and task rows.
 *
 * Re-projection always builds fresh row objects, so an identity check would
 * report a change on every feed event and re-render the panel for nothing.
 * @param previous - The value currently stored.
 * @param next - The freshly projected value.
 * @returns true when every row field the UI renders is unchanged.
 */
function sameTeamView(previous: TeamView | undefined, next: TeamView): boolean {
  if (previous === undefined) return false
  if (previous.failure !== next.failure) return false
  if (previous.members.length !== next.members.length) return false
  if (previous.tasks.length !== next.tasks.length) return false
  for (let index = 0; index < previous.members.length; index += 1) {
    const a = previous.members[index]!
    const b = next.members[index]!
    if (
      a.sessionId !== b.sessionId || a.name !== b.name || a.role !== b.role
      || a.phase !== b.phase || a.turn !== b.turn || a.current !== b.current
      || a.error !== b.error || a.agentId !== b.agentId || a.model !== b.model
      || a.description !== b.description
    ) return false
  }
  for (let index = 0; index < previous.tasks.length; index += 1) {
    const a = previous.tasks[index]!
    const b = next.tasks[index]!
    if (
      a.id !== b.id || a.revision !== b.revision || a.subject !== b.subject
      || a.status !== b.status || a.ownerName !== b.ownerName || a.ready !== b.ready
      || a.description !== b.description
      || a.blockedBy.length !== b.blockedBy.length
      || a.writeScopes.length !== b.writeScopes.length
      || a.writeScopeWarnings.length !== b.writeScopeWarnings.length
    ) return false
    for (let i = 0; i < a.blockedBy.length; i += 1) if (a.blockedBy[i] !== b.blockedBy[i]) return false
    for (let i = 0; i < a.writeScopes.length; i += 1) if (a.writeScopes[i] !== b.writeScopes[i]) return false
    for (let i = 0; i < a.writeScopeWarnings.length; i += 1) {
      if (a.writeScopeWarnings[i] !== b.writeScopeWarnings[i]) return false
    }
  }
  return true
}

/**
 * The team value for one session, with a subscription for renderers.
 * Unlike the single-current activity store this one keeps every session whose
 * value the feed delivered: opening a teammate's session does not forget the
 * Lead's roster, and switching back is instant. Keys are the Lead session id —
 * the session whose log owns the team — so a teammate view resolves its team
 * by walking to the root (see {@link leadSessionIdOf}).
 */
export class TeamStore {
  private readonly values = new Map<string, TeamView>()
  /** Raw values per session, kept so a runtime change can re-project alone. */
  private readonly raw = new Map<string, RawTeamProjection>()
  private readonly listeners = new Set<() => void>()
  /** Session objects seen per id, so a live value can be re-read. */
  private readonly sessions = new Map<string, unknown>()
  private registry: TeamProjectionRegistryLike | undefined
  private resolve: TeamRuntimeResolver | undefined
  /** Session the UI is showing; only used to mark the `current` row. */
  private currentId: string | undefined
  private readonly warn: ((message: string) => void) | undefined

  constructor(warn?: (message: string) => void) {
    this.warn = warn
  }

  /** Remember the host registry (see {@link seed}). */
  attachRegistry(registry: TeamProjectionRegistryLike): void {
    this.registry = registry
  }

  /**
   * Install (or replace) the runtime cross-reference resolver.
   *
   * The resolver is expected to read the local subagent projection — it must
   * not become a state owner. Re-projecting every cached value here is what
   * makes a teammate's live turn appear on the roster without a team event.
   * @param resolve - Resolver, or `undefined` to disable enrichment.
   */
  setRuntimeResolver(resolve: TeamRuntimeResolver | undefined): void {
    this.resolve = resolve
    let changed = false
    for (const [sessionId, raw] of this.raw) {
      const next = projectTeamView(raw, resolve, this.currentId)
      if (next === undefined) continue
      if (sameTeamView(this.values.get(sessionId), next)) continue
      this.values.set(sessionId, next)
      changed = true
    }
    if (changed) this.emit()
  }

  /** Name the session the UI is showing, so its roster row marks as current. */
  setCurrentSession(sessionId: string | undefined): void {
    if (this.currentId === sessionId) return
    this.currentId = sessionId
    let changed = false
    for (const [id, raw] of this.raw) {
      const next = projectTeamView(raw, this.resolve, sessionId)
      if (next === undefined) continue
      if (sameTeamView(this.values.get(id), next)) continue
      this.values.set(id, next)
      changed = true
    }
    if (changed) this.emit()
  }

  /**
   * Read one Lead session's team value and remember the session object.
   *
   * A projection value only *arrives* when it changes, so a resumed or
   * reattached Lead would show an empty panel until the next team event
   * without this read. Reading a session whose log carries no team yields an
   * empty view, which is exactly what a session without a team should show.
   * @param session - Session whose team value is read (its own log if Lead).
   */
  seed(session: unknown): void {
    if (session === null || session === undefined) return
    const id = String((session as { id: unknown }).id)
    this.sessions.set(id, session)
    const registry = this.registry
    if (registry === undefined) return
    let value: unknown
    try {
      const snapshot = registry.snapshot(session, [TEAM_PROJECTION_KEY])
      value = snapshot.values[TEAM_PROJECTION_KEY]
    } catch (error) {
      this.noteReadFailure(id, error instanceof Error ? error.message : String(error))
      return
    }
    if (value === undefined) {
      // No team on this session: drop a stale value rather than showing the
      // previous team's roster behind a session that has none.
      this.clear(id)
      return
    }
    const raw = asTeamProjection(value)
    if (raw === undefined) return
    this.raw.set(id, raw)
    const view = projectTeamView(raw, this.resolve, this.currentId)
    if (view === undefined) return
    this.update(id, view)
  }

  /**
   * Record one value that arrived on the change feed.
   *
   * The feed carries the already-validated wire view, but the *enriched* view
   * is recomputed here so a roster row's live turn and subagent link stay in
   * sync with the value that just landed.
   * @param sessionId - Lead session the value belongs to.
   * @param session - Session object, remembered for a later re-read.
   * @param raw - Raw projection value from the feed.
   */
  seedFromFeed(sessionId: string, session: unknown, raw: RawTeamProjection): void {
    this.sessions.set(sessionId, session)
    this.raw.set(sessionId, raw)
    const view = projectTeamView(raw, this.resolve, this.currentId)
    if (view === undefined) return
    this.update(sessionId, view)
  }

  /** Record one projection value for a session. */
  update(sessionId: string, view: TeamView): void {
    if (this.values.get(sessionId) === view) return
    this.values.set(sessionId, view)
    this.emit()
  }

  /** The team value for one Lead session id, stable between updates. */
  get(sessionId: string | undefined): TeamView | undefined {
    if (sessionId === undefined) return undefined
    return this.values.get(sessionId)
  }


  /** Forget one session (disposed, or a team that went away). */
  clear(sessionId: string): void {
    this.sessions.delete(sessionId)
    this.raw.delete(sessionId)
    if (!this.values.delete(sessionId)) return
    this.emit()
  }

  /** Re-read one session's value from the registry (health check / doctor). */
  refresh(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    this.seed(session)
  }

  /** Subscribe to value changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private noteReadFailure(sessionId: string, detail: string): void {
    this.warn?.(`dsh-tui: agent-team projection read failed for session ${sessionId}: ${detail}`)
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

/**
 * The change-feed listener for one store.
 *
 * Only this plugin's key is read, and only values that narrow to a team
 * projection are accepted: the feed is host-wide, so every other unit's change
 * and every malformed value must be dropped here rather than inside a
 * renderer.
 * @param store - Store to fill.
 * @returns the listener to hand to `ProjectionRegistry.onChanged`.
 */
export function createTeamFeed(
  store: TeamStore,
): (session: { readonly id: unknown }, key: string, value: unknown) => void {
  return (session, key, value) => {
    if (key !== TEAM_PROJECTION_KEY) return
    const raw = asTeamProjection(value)
    if (raw === undefined) return
    const sessionId = String(session.id)
    store.seedFromFeed(sessionId, session, raw)
  }
}

/**
 * Wire one store to the host's projection registry.
 *
 * Deferred through `inject` for the same reason the activity feed is: the
 * plugin that publishes the unit may mount after this one, and a composition
 * without it must degrade to "no team" instead of failing.
 * @param ctx - Host context of the composition root.
 * @param store - Store to fill.
 */
export function attachTeamProjection(ctx: Context, store: TeamStore): void {
  ctx.inject(['sessionProjections'] as never, ((projectionCtx: Context) => {
    const registry = (projectionCtx as unknown as {
      sessionProjections?: TeamProjectionRegistryLike
    }).sessionProjections
    if (registry === undefined) return
    store.attachRegistry(registry)
    const offFeed = registry.onChanged(createTeamFeed(store))
    projectionCtx.effect(() => () => { offFeed() }, 'dsh-tui agent-team projection feed')
  }) as never)
}


/**
 * Create the composition root's team store and wire it to the host.
 * @param ctx - Host context of the composition root.
 * @returns the store the UI reads from.
 */
export function createTeamStore(ctx: Context): TeamStore {
  const store = new TeamStore(message => { ctx.logger.warn(message) })
  attachTeamProjection(ctx, store)
  return store
}

/**
 * Resolve the session whose log owns the team for one visible session.
 *
 * The team projection lives in the Lead (root) session's log only, so a
 * teammate's own session carries none. The official Web UI does exactly this
 * walk (`subagent.address.parentSessionId ?? sessionId`); the TUI reads the
 * same field off the session header, and falls back to the session itself.
 * @param session - Session being viewed, or its header.
 * @returns the Lead session id to read team state from.
 */
export function leadSessionIdOf(session: unknown): string | undefined {
  if (session === null || session === undefined) return undefined
  const record = session as {
    readonly id?: unknown
    readonly subagent?: { readonly address?: { readonly parentSessionId?: unknown } }
  }
  const parent = record.subagent?.address?.parentSessionId
  if (typeof parent === 'string' && parent.length > 0) return parent
  return typeof record.id === 'string' ? record.id : undefined
}
