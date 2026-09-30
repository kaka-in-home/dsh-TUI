/**
 * Agent-Team inbox: the teammate messages this session actually received.
 *
 * A peer message reaches the target session as a durable `user/message` with
 * source `{ kind: 'team-message', senderName, … }` (the Team kernel's
 * `TeamMessageSource`). That event is the SENDER's own durable record of the
 * delivery, so this store folds the session's own log and never polls the team
 * mailbox — the log stays the single source of truth.
 *
 * The store is a projection: rows are appended in log order, de-duplicated by
 * message id (a resume replays the log), and bounded, so a long-lived session
 * cannot grow the panel without limit.
 *
 * @module dsh-tui/dsh-adapter/team-inbox
 */


/** One received teammate message. */
export interface TeamMessageRow {
  readonly id: string
  readonly senderName: string
  readonly text: string
  /** Wall clock the event was folded (log order is the ordering guarantee). */
  readonly at: number
}

/** Hard cap on retained messages; the oldest are dropped first. */
const MAX_MESSAGES = 200

/** The source shape the Team kernel stamps on a delivered peer message. */
interface TeamMessageSource {
  readonly kind?: unknown
  readonly messageId?: unknown
  readonly senderName?: unknown
}

/** Extract text from a message content block list (first text blocks joined). */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type !== 'text' || typeof candidate.text !== 'string') continue
    parts.push(candidate.text)
  }
  return parts.join('\n')
}

/**
 * Read one durable message event as a teammate message, when it is one.
 *
 * Anything that is not a well-formed team-message source is rejected here
 * rather than rendered half-formed by the panel.
 * @param data - Raw `user/message` event payload.
 * @returns the message row fields, or `undefined` for an ordinary message.
 */
export function asTeamMessage(
  data: unknown,
): { readonly id: string; readonly senderName: string; readonly text: string } | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const record = data as { readonly id?: unknown; readonly source?: TeamMessageSource; readonly content?: unknown }
  const source = record.source
  if (source === null || typeof source !== 'object' || source.kind !== 'team-message') return undefined
  const text = textOf(record.content)
  if (text === '') return undefined
  const senderName = typeof source.senderName === 'string' && source.senderName !== '' ? source.senderName : 'teammate'
  const id = typeof source.messageId === 'string' && source.messageId !== ''
    ? source.messageId
    : typeof record.id === 'string' ? record.id : `${senderName}:${text.length}:${text.slice(0, 24)}`
  return { id, senderName, text }
}

/** Ordered, bounded, de-duplicated inbox for one session. */
export class TeamInboxStore {
  private rows: readonly TeamMessageRow[] = []
  /** Lead session this inbox is bound to (see {@link setCurrentSession}). */
  private currentId: string | undefined
  /** Messages folded since the last {@link markRead}. */
  private unreadCount = 0
  private readonly seen = new Set<string>()
  private readonly listeners = new Set<() => void>()

  /**
   * Mark which Lead session the inbox belongs to.
   *
   * The store is per displayed session: a rebind to another session (or its
   * Lead) must not carry the previous session's messages into the panel. The
   * comparison is on the resolved Lead id, so entering and leaving a teammate
   * view of the same team keeps the inbox.
   * @param leadSessionId - Lead session id, or undefined when unknown.
   */
  setCurrentSession(leadSessionId: string | undefined): void {
    if (this.currentId === leadSessionId) return
    this.currentId = leadSessionId
    this.reset()
  }

  /**
   * Fold one durable message event.
   *
   * `silent` marks a durable REPLAY (resume, rewind, adoption): the message is
   * recorded so the inbox is complete, but it is not "new" to the user and
   * must not raise an unread count or a toast — otherwise every resume would
   * re-announce the whole history.
   * @param data - Raw `user/message` payload.
   * @param options - `silent` for replay-folded events.
   * @returns true when a new message was recorded.
   */
  noteEvent(data: unknown, options: { readonly silent?: boolean } = {}): boolean {
    const message = asTeamMessage(data)
    if (message === undefined) return false
    if (this.seen.has(message.id)) return false
    this.seen.add(message.id)
    const next = [...this.rows, { ...message, at: Date.now() }]
    this.rows = next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next
    if (options.silent !== true) this.unreadCount += 1
    this.emit()
    return true
  }

  /** Messages folded since the last {@link markRead}. */
  unread(): number {
    return this.unreadCount
  }

  /** The user has seen the inbox (panel opened, or the inbox page shown). */
  markRead(): void {
    if (this.unreadCount === 0) return
    this.unreadCount = 0
    this.emit()
  }

  /** The name of the most recent message's sender, or undefined. */
  lastSender(): string | undefined {
    return this.rows.at(-1)?.senderName
  }

  /** Every retained message, oldest first (stable reference between folds). */
  snapshot(): readonly TeamMessageRow[] {
    return this.rows
  }

  /** Forget everything (session reset / rebind to another session). */
  reset(): void {
    if (this.rows.length === 0 && this.seen.size === 0 && this.unreadCount === 0) return
    this.rows = []
    this.seen.clear()
    this.unreadCount = 0
    this.emit()
  }

  /** Subscribe to inbox changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

