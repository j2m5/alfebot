import type { Reminder, ReminderStore } from './reminder-store.js'

type Store = Pick<ReminderStore, 'claimDue' | 'finish' | 'retry' | 'recoverInterrupted' | 'prune'>
type Body = {
    content: string
    allowed_mentions: { parse: never[]; users: string[] }
    nonce: string
    enforce_nonce: true
}
type Delivery = {
    authorize(reminder: Reminder, signal: AbortSignal): Promise<void>
    send(reminder: Reminder, body: Body, signal: AbortSignal): Promise<{ id: string; channel_id: string }>
}

// Allow a response already resolving in this turn to confirm delivery even on stop.
// An adapter ignoring cancellation still cannot hold the worker indefinitely.
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        let immediate: ReturnType<typeof setImmediate> | undefined
        const cleanup = () => {
            signal.removeEventListener('abort', abort)
            if (immediate) clearImmediate(immediate)
        }
        const abort = () => {
            immediate ??= setImmediate(() => { cleanup(); reject(signal.reason) })
        }
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        operation.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
    })
}

function postFailure(error: unknown): 'retry' | 'failed' | 'uncertain' {
    if (!error || typeof error !== 'object') return 'uncertain'
    const { status, statusCode, name } = error as { status?: unknown; statusCode?: unknown; name?: unknown }
    const code = status ?? statusCode
    if (code === 429 || name === 'RateLimitError') return 'retry'
    if (typeof code === 'number' && Number.isInteger(code) && code >= 400 && code < 500 && code !== 408) {
        return 'failed'
    }
    return 'uncertain'
}

export class ReminderScheduler {
    private interval?: ReturnType<typeof setInterval>
    private inFlight?: Promise<void>
    private lifetime = new AbortController()
    private lastPrunedAt = -Infinity

    constructor(
        private readonly store: Store,
        private readonly delivery: Delivery,
        private readonly clock: () => number = Date.now,
    ) {}

    tick(): Promise<void> {
        if (this.inFlight) return this.inFlight
        if (this.lifetime.signal.aborted) return Promise.resolve()
        this.inFlight = this.run(this.lifetime.signal).finally(() => { this.inFlight = undefined })
        return this.inFlight
    }

    start(): void {
        if (this.interval) return
        // A manual tick may already own a live claim; never recover that claim.
        if (!this.inFlight) this.store.recoverInterrupted(this.clock())
        this.prune()
        if (this.lifetime.signal.aborted) this.lifetime = new AbortController()
        const tick = () => {
            // Store failures leave the claim persisted for explicit startup recovery.
            void this.tick().catch(() => {})
        }
        tick()
        this.interval = setInterval(tick, 5000)
        this.interval.unref()
    }

    stop(): void {
        if (this.interval) clearInterval(this.interval)
        this.interval = undefined
        this.lifetime.abort()
    }

    private async run(stop: AbortSignal): Promise<void> {
        if (this.clock() - this.lastPrunedAt >= 3_600_000) this.prune()
        for (let count = 0; count < 5 && !stop.aborted; count++) {
            const reminder = this.store.claimDue(this.clock())
            if (!reminder) break
            await this.deliver(reminder, stop)
        }
    }

    private prune(): void {
        const now = this.clock()
        this.store.prune(now)
        this.lastPrunedAt = now
    }

    private retry(reminder: Reminder, error: string): void {
        const now = this.clock()
        if (reminder.attempts >= 5) {
            this.store.finish(reminder.id, 'failed', now, undefined,
                'Лимит попыток доставки исчерпан. ' + error)
        } else {
            const delay = Math.min(30_000 * 2 ** (reminder.attempts - 1), 300_000)
            this.store.retry(reminder.id, now + delay, now, error)
        }
    }

    private async deliver(reminder: Reminder, stop: AbortSignal): Promise<void> {
        const deadline = new AbortController()
        const timeout = setTimeout(() => deadline.abort(), 15_000)
        timeout.unref()
        const signal = AbortSignal.any([stop, deadline.signal])
        let posted = false
        let result: 'sent' | 'failed' | 'uncertain' | 'retry'
        let messageId: string | undefined
        let error: string | undefined
        try {
            signal.throwIfAborted()
            await abortable(this.delivery.authorize(reminder, signal), signal)
            const body: Body = {
                content: `<@${reminder.userId}> Напоминание #${reminder.id} · <t:${Math.floor(reminder.dueAt / 1000)}:F>\n${reminder.text}`,
                allowed_mentions: { parse: [], users: [reminder.userId] },
                // Discord's nonce deduplication window is limited; this is not exactly-once delivery.
                nonce: `r${reminder.id.toString(36)}-${reminder.createdAt.toString(36)}`,
                enforce_nonce: true,
            }
            signal.throwIfAborted()
            posted = true
            const reply = await abortable(this.delivery.send(reminder, body, signal), signal)
            if (reply && typeof reply.id === 'string' && /^\d{17,20}$/.test(reply.id)
                && reply.channel_id === reminder.channelId) {
                result = 'sent'
                messageId = reply.id
            } else {
                result = 'uncertain'
                error = 'Ответ доставки не подтверждён; автоматический повтор отключён.'
            }
        } catch (cause) {
            result = posted ? postFailure(cause) : 'retry'
            error = !posted ? 'Проверка доступа не завершена; отправка не выполнялась.'
                : result === 'retry' ? 'Ограничение частоты отправки; повтор отложен.'
                    : result === 'failed' ? 'Discord отклонил отправку напоминания.'
                        : 'Результат отправки неизвестен; автоматический повтор отключён.'
        } finally {
            clearTimeout(timeout)
        }
        // Persistence is outside the network catch: a failed commit must never cause a POST retry.
        if (result === 'retry') this.retry(reminder, error!)
        else this.store.finish(reminder.id, result, this.clock(), messageId, error)
    }
}

export async function stopReminders(scheduler: ReminderScheduler, store: Pick<ReminderStore, 'close'>): Promise<void> {
    scheduler.stop()
    try { await scheduler.tick() }
    finally { store.close() }
}
