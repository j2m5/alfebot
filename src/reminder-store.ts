import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const MAX_REMINDER_DELAY_MS = 365 * 24 * 60 * 60 * 1000
const MAX_ACTIVE_PER_USER = 50
const MAX_ERROR_LENGTH = 1000
const DAY_MS = 24 * 60 * 60 * 1000

export type Reminder = {
    id: number
    guildId: string
    channelId: string
    userId: string
    requestId: string
    text: string
    dueAt: number
    status: 'pending' | 'sending' | 'sent' | 'cancelled' | 'failed' | 'uncertain'
    attempts: number
    nextAttemptAt: number
    createdAt: number
    updatedAt: number
    messageId: string | null
    lastError: string | null
}

type ScheduleInput = Pick<Reminder, 'guildId' | 'channelId' | 'userId' | 'requestId' | 'text' | 'dueAt'>
type DbRow = Record<string, unknown>

function fromRow(row: DbRow): Reminder {
    return {
        id: Number(row.id), guildId: String(row.guildId), channelId: String(row.channelId),
        userId: String(row.userId), requestId: String(row.requestId), text: String(row.text),
        dueAt: Number(row.dueAt), status: row.status as Reminder['status'], attempts: Number(row.attempts),
        nextAttemptAt: Number(row.nextAttemptAt), createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt),
        messageId: row.messageId === null ? null : String(row.messageId),
        lastError: row.lastError === null ? null : String(row.lastError),
    }
}

function boundedError(error: string): string {
    return error.slice(0, MAX_ERROR_LENGTH)
}

export class ReminderStore {
    private readonly db: DatabaseSync

    constructor(path = './data/reminders.sqlite') {
        if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
        this.db = new DatabaseSync(path)
        this.db.exec('PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON;')
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS reminders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                guildId TEXT NOT NULL, channelId TEXT NOT NULL, userId TEXT NOT NULL,
                requestId TEXT NOT NULL, text TEXT NOT NULL, dueAt INTEGER NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('pending','sending','sent','cancelled','failed','uncertain')),
                attempts INTEGER NOT NULL DEFAULT 0, nextAttemptAt INTEGER NOT NULL,
                createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
                messageId TEXT, lastError TEXT,
                UNIQUE (guildId, userId, requestId)
            );
            CREATE INDEX IF NOT EXISTS reminders_due ON reminders(status, dueAt, nextAttemptAt, id);
            CREATE INDEX IF NOT EXISTS reminders_owner ON reminders(guildId, userId, status, dueAt, id);
            CREATE INDEX IF NOT EXISTS reminders_prune ON reminders(status, updatedAt);
        `)
    }

    close(): void { this.db.close() }

    schedule(input: ScheduleInput, now = Date.now()): Reminder {
        const text = input.text?.trim()
        const discordId = /^[1-9]\d{16,19}$/
        if (!text || text.length > 500) throw new Error('Текст напоминания должен содержать от 1 до 500 символов')
        if (![input.guildId, input.channelId, input.userId].every(id => typeof id === 'string' && discordId.test(id))) {
            throw new Error('Некорректный Discord ID сервера, канала или пользователя')
        }
        if (typeof input.requestId !== 'string' || !discordId.test(input.requestId)) throw new Error('Некорректный Discord ID запроса')
        if (!Number.isSafeInteger(input.dueAt) || input.dueAt <= now || input.dueAt > now + MAX_REMINDER_DELAY_MS) {
            throw new Error('Время напоминания должно быть в будущем, не далее чем через 365 дней')
        }

        this.db.exec('BEGIN IMMEDIATE')
        try {
            const existing = this.db.prepare('SELECT * FROM reminders WHERE guildId = ? AND userId = ? AND requestId = ?')
                .get(input.guildId, input.userId, input.requestId) as DbRow | undefined
            if (existing) {
                this.db.exec('COMMIT')
                return fromRow(existing)
            }
            const count = this.db.prepare("SELECT COUNT(*) AS count FROM reminders WHERE guildId = ? AND userId = ? AND status IN ('pending','sending')")
                .get(input.guildId, input.userId) as DbRow
            if (Number(count.count) >= MAX_ACTIVE_PER_USER) throw new Error('Достигнут лимит: не более 50 активных напоминаний на пользователя в сервере')

            this.db.prepare(`INSERT INTO reminders
                (guildId, channelId, userId, requestId, text, dueAt, status, attempts, nextAttemptAt, createdAt, updatedAt)
                VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`)
                .run(input.guildId, input.channelId, input.userId, input.requestId, text, input.dueAt, input.dueAt, now, now)
            const row = this.db.prepare('SELECT * FROM reminders WHERE id = last_insert_rowid()').get() as DbRow
            this.db.exec('COMMIT')
            return fromRow(row)
        } catch (error) {
            this.db.exec('ROLLBACK')
            throw error
        }
    }

    list(guildId: string, userId: string): Reminder[] {
        const rows = this.db.prepare("SELECT * FROM reminders WHERE guildId = ? AND userId = ? AND status IN ('pending','sending','failed','uncertain') ORDER BY CASE WHEN status IN ('pending','sending') THEN 0 ELSE 1 END, dueAt, id LIMIT 50")
            .all(guildId, userId) as DbRow[]
        return rows.map(fromRow)
    }

    cancel(id: number, guildId: string, userId: string, now = Date.now()): 'cancelled' | 'sending' | 'not_found' {
        const changed = this.db.prepare("UPDATE reminders SET status = 'cancelled', updatedAt = ?, lastError = NULL WHERE id = ? AND guildId = ? AND userId = ? AND status IN ('pending','failed','uncertain')")
            .run(now, id, guildId, userId)
        if (Number(changed.changes) > 0) return 'cancelled'
        const row = this.db.prepare('SELECT status FROM reminders WHERE id = ? AND guildId = ? AND userId = ?')
            .get(id, guildId, userId) as DbRow | undefined
        if (!row) return 'not_found'
        return row.status === 'sending' ? 'sending' : 'not_found'
    }

    claimDue(now = Date.now()): Reminder | undefined {
        const row = this.db.prepare(`UPDATE reminders SET status = 'sending', attempts = attempts + 1, updatedAt = ?
            WHERE id = (SELECT id FROM reminders WHERE status = 'pending' AND dueAt <= ? AND nextAttemptAt <= ? ORDER BY dueAt, id LIMIT 1)
            AND status = 'pending' RETURNING *`).get(now, now, now) as DbRow | undefined
        return row ? fromRow(row) : undefined
    }

    finish(id: number, status: 'sent' | 'failed' | 'uncertain', now: number, messageId?: string, error?: string): boolean {
        const result = this.db.prepare(`UPDATE reminders SET status = ?, updatedAt = ?, messageId = ?, lastError = ?
            WHERE id = ? AND status = 'sending'`)
            .run(status, now, messageId ?? null, error === undefined ? null : boundedError(error), id)
        return Number(result.changes) > 0
    }

    retry(id: number, nextAttemptAt: number, now: number, error: string): boolean {
        const result = this.db.prepare(`UPDATE reminders SET status = 'pending', nextAttemptAt = ?, updatedAt = ?, lastError = ?
            WHERE id = ? AND status = 'sending'`).run(nextAttemptAt, now, boundedError(error), id)
        return Number(result.changes) > 0
    }

    recoverInterrupted(now = Date.now()): number {
        const result = this.db.prepare(`UPDATE reminders SET status = 'uncertain', updatedAt = ?, lastError = ? WHERE status = 'sending'`)
            .run(now, 'Отправка прервана перезапуском; результат неизвестен, автоматическая повторная отправка не выполняется')
        return Number(result.changes)
    }

    prune(now = Date.now()): void {
        this.db.prepare("DELETE FROM reminders WHERE status IN ('sent','cancelled','failed','uncertain') AND updatedAt < ?")
            .run(now - 7 * DAY_MS)
    }
}
