import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { ReminderStore, type Reminder } from '../src/reminder-store.js'
import { ReminderScheduler, stopReminders } from '../src/reminder-scheduler.js'

const NOW = 1_800_000_000_000
const CHANNEL = '22345678901234567'
const USER = '32345678901234567'
const ACK = { id: '42345678901234567', channel_id: CHANNEL }
type Delivery = ConstructorParameters<typeof ReminderScheduler>[1]

test('graceful application shutdown persists an unsent reminder before closing storage', async t => {
    const f = fixture(t)
    const row = f.row()
    f.delivery.authorize = async () => new Promise<void>(() => {})
    const worker = f.scheduler()
    const running = worker.tick()
    assert.equal(f.read(row)?.status, 'sending')
    let closed = false
    await stopReminders(worker, { close() {
        assert.equal(f.read(row)?.status, 'pending')
        closed = true
    } })
    await running
    assert.equal(closed, true)
    assert.equal(f.posts.length, 0)
    f.reopen()
    assert.equal(f.read(row)?.status, 'pending')
})

function fixture(t: { after(fn: () => void): void }) {
    const dir = mkdtempSync(join(tmpdir(), 'reminder-scheduler-'))
    const path = join(dir, 'reminders.sqlite')
    let store = new ReminderStore(path)
    let now = NOW
    let request = 72345678901234567n
    const posts: Parameters<Delivery['send']>[1][] = []
    const delivery: Delivery = {
        authorize: async () => {},
        send: async (row, body) => {
            assert.equal(store.list(row.guildId, row.userId)[0]?.status, 'sending')
            posts.push(body)
            return ACK
        },
    }
    const schedulers: ReminderScheduler[] = []
    const scheduler = () => {
        const worker = new ReminderScheduler(store, delivery, () => now)
        schedulers.push(worker)
        return worker
    }
    t.after(() => {
        for (const worker of schedulers) worker.stop()
        store.close()
        rmSync(dir, { recursive: true, force: true })
    })
    return {
        get store() { return store }, delivery, posts, scheduler,
        advance(ms: number) { now += ms },
        reopen() { store.close(); store = new ReminderStore(path) },
        row: (overrides: Partial<Omit<Parameters<ReminderStore['schedule']>[0], 'requestId'>> = {}) => store.schedule({
            guildId: '12345678901234567', channelId: CHANNEL, userId: USER,
            text: 'чай @everyone <@52345678901234567> <@&62345678901234567>',
            dueAt: NOW, ...overrides, requestId: String(request++),
        }, NOW - 1),
        read: (row: Reminder) => store.list(row.guildId, row.userId).find(r => r.id === row.id),
        receipt: (row: Reminder) => {
            const db = new DatabaseSync(path, { readOnly: true })
            try { return { ...db.prepare('SELECT status, messageId FROM reminders WHERE id = ?').get(row.id) } }
            finally { db.close() }
        },
    }
}

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
}

test('waits until due, then sends the original text with only the author allowed to ping', async t => {
    const f = fixture(t)
    const row = f.row({ dueAt: NOW + 1000 })
    const worker = f.scheduler()
    await worker.tick()
    assert.equal(f.posts.length, 0)
    f.advance(1000)
    await worker.tick()
    assert.equal(f.posts.length, 1)
    const body = f.posts[0]
    assert.ok(body.content.includes(`<@${USER}>`))
    assert.ok(body.content.includes(row.text))
    assert.ok(body.content.includes('<t:1800000001:F>'))
    assert.ok(body.content.includes(String(row.id)))
    assert.deepEqual(body.allowed_mentions, { parse: [], users: [USER] })
    assert.equal(body.enforce_nonce, true)
    assert.match(body.nonce, /^[a-z0-9-]{1,25}$/)
    assert.equal(f.read(row), undefined) // sent rows leave the active list
    assert.deepEqual(f.receipt(row), { status: 'sent', messageId: ACK.id })
    assert.equal(f.store.claimDue(NOW + 1000), undefined)
})

test('concurrent ticks share one claim and wait for the same delivery', async t => {
    const f = fixture(t)
    f.row()
    const gate = deferred<void>()
    f.delivery.authorize = () => gate.promise
    const worker = f.scheduler()
    let secondDone = false
    const first = worker.tick()
    const second = worker.tick().then(() => { secondDone = true })
    await nextTurn()
    assert.equal(secondDone, false)
    gate.resolve()
    await Promise.all([first, second])
    assert.equal(f.posts.length, 1)
})

test('delivers persisted pending rows after reopen and skips cancelled rows', async t => {
    const f = fixture(t)
    const cancelled = f.row()
    f.store.cancel(cancelled.id, cancelled.guildId, cancelled.userId, NOW)
    f.row({ dueAt: NOW + 5000 })
    f.reopen()
    const worker = f.scheduler()
    await worker.tick()
    assert.equal(f.posts.length, 0)
    f.advance(5000)
    await worker.tick()
    assert.equal(f.posts.length, 1)
})

test('claims at most five rows per tick', async t => {
    const f = fixture(t)
    for (let i = 0; i < 7; i++) f.row()
    const worker = f.scheduler()
    await worker.tick()
    assert.equal(f.posts.length, 5)
    await worker.tick()
    assert.equal(f.posts.length, 7)
    assert.equal(new Set(f.posts.map(p => p.nonce)).size, 7)
})

for (const failure of ['access', '429', 'RateLimitError']) {
    test(`${failure} retries safely with persisted bounded backoff and fails after five claims`, async t => {
        const f = fixture(t)
        const row = f.row()
        const error = failure === 'access' ? new Error('PRIVATE text/token')
            : failure === '429' ? { status: 429, message: 'PRIVATE' }
                : Object.assign(new Error('PRIVATE'), { name: 'RateLimitError' })
        let sends = 0
        if (failure === 'access') f.delivery.authorize = async () => { throw error }
        else f.delivery.send = async () => { sends++; throw error }
        let worker = f.scheduler()
        let expectedTime = NOW
        for (const [i, delay] of [30_000, 60_000, 120_000, 240_000].entries()) {
            await worker.tick()
            expectedTime += delay
            const pending = f.read(row)!
            assert.equal(pending.status, 'pending')
            assert.equal(pending.attempts, i + 1)
            assert.equal(pending.nextAttemptAt, expectedTime)
            assert.ok(pending.lastError && pending.lastError.length <= 300)
            assert.match(pending.lastError, /[А-Яа-я]/u)
            assert.ok(!pending.lastError.includes('PRIVATE'))
            await worker.tick()
            assert.equal(f.read(row)!.attempts, i + 1)
            f.advance(delay)
            if (i === 0) { f.reopen(); worker = f.scheduler() }
        }
        await worker.tick()
        assert.equal(f.read(row)!.status, 'failed')
        assert.equal(f.read(row)!.attempts, 5)
        f.advance(1_000_000)
        await worker.tick()
        assert.equal(sends, failure === 'access' ? 0 : 5)
    })
}

for (const status of [400, 401, 403, 404]) {
    test(`POST ${status} is terminal`, async t => {
        const f = fixture(t)
        const row = f.row()
        f.delivery.send = async () => { throw { status } }
        await f.scheduler().tick()
        assert.equal(f.read(row)!.status, 'failed')
    })
}

for (const error of [{ status: 408 }, { status: 500 }, { status: 503 }, new Error('unknown'),
    Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
    Object.assign(new Error('abort'), { name: 'AbortError' })]) {
    test(`ambiguous POST ${'status' in error ? error.status : error.name} is never repeated`, async t => {
        const f = fixture(t)
        const row = f.row()
        let sends = 0
        f.delivery.send = async () => { sends++; throw error }
        const worker = f.scheduler()
        await worker.tick()
        assert.equal(f.read(row)!.status, 'uncertain')
        f.advance(1_000_000)
        await worker.tick()
        assert.equal(sends, 1)
    })
}

for (const reply of [null, {}, { ...ACK, id: '123' }, { ...ACK, id: '1'.repeat(21) },
    { ...ACK, channel_id: '52345678901234567' }]) {
    test(`malformed acknowledgement ${JSON.stringify(reply)} is uncertain`, async t => {
        const f = fixture(t)
        const row = f.row()
        f.delivery.send = async () => reply as typeof ACK
        await f.scheduler().tick()
        assert.equal(f.read(row)!.status, 'uncertain')
    })
}

test('stop during authorization aborts its signal and prevents every subsequent send', async t => {
    const f = fixture(t)
    const row = f.row()
    f.row()
    const gate = deferred<void>()
    let signal!: AbortSignal
    f.delivery.authorize = async (_row, current) => { signal = current; await gate.promise }
    const worker = f.scheduler()
    const tick = worker.tick()
    await nextTurn()
    worker.stop()
    assert.equal(signal.aborted, true)
    gate.resolve()
    await tick
    await worker.tick()
    assert.equal(f.posts.length, 0)
    assert.equal(f.read(row)!.status, 'pending')
})

test('a verified ACK remains sent when stop aborts the signal before send returns', async t => {
    const f = fixture(t)
    const row = f.row()
    const worker = f.scheduler()
    f.delivery.send = async (_row, _body, signal) => {
        worker.stop()
        assert.equal(signal.aborted, true)
        return ACK
    }
    await worker.tick()
    assert.equal(f.read(row), undefined)
    assert.deepEqual(f.receipt(row), { status: 'sent', messageId: ACK.id })
})

test('a hanging POST has a 15-second deadline and becomes uncertain', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const f = fixture(t)
    const row = f.row()
    let signal!: AbortSignal
    f.delivery.send = async (_row, _body, current) => {
        signal = current
        return new Promise(() => {})
    }
    const tick = f.scheduler().tick()
    await nextTurn()
    t.mock.timers.tick(14_999)
    assert.equal(signal.aborted, false)
    t.mock.timers.tick(1)
    await tick
    assert.equal(signal.aborted, true)
    assert.equal(f.read(row)!.status, 'uncertain')
})

test('authorization consumes the same 15-second deadline and cannot write after timing out', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const f = fixture(t)
    const row = f.row()
    const gate = deferred<void>()
    f.delivery.authorize = () => gate.promise
    const tick = f.scheduler().tick()
    t.mock.timers.tick(15_000)
    await tick
    gate.resolve()
    await nextTurn()
    assert.equal(f.posts.length, 0)
    assert.equal(f.read(row)!.status, 'pending')
})

test('start recovers sending as uncertain, prunes, ticks immediately and every five seconds', async t => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const f = fixture(t)
    const interrupted = f.row()
    f.store.claimDue(NOW)
    const stale = f.row()
    f.store.claimDue(NOW)
    f.store.finish(stale.id, 'failed', NOW - 8 * 86_400_000)
    f.row()
    f.row({ dueAt: NOW + 5000 })
    const worker = f.scheduler()
    worker.start()
    worker.start() // idempotent: must not recover a live claim
    await worker.tick()
    assert.equal(f.read(interrupted)!.status, 'uncertain')
    assert.equal(f.read(stale), undefined)
    assert.equal(f.posts.length, 1)
    f.advance(5000)
    t.mock.timers.tick(5000)
    await worker.tick()
    assert.equal(f.posts.length, 2)
    worker.stop()
    f.row()
    t.mock.timers.tick(5000)
    await worker.tick()
    assert.equal(f.posts.length, 2)
})

test('a long-running worker prunes terminal rows at least hourly', async t => {
    const f = fixture(t)
    const row = f.row()
    f.store.claimDue(NOW)
    f.store.finish(row.id, 'failed', NOW)
    const worker = f.scheduler()
    await worker.tick()
    f.advance(7 * 86_400_000)
    await worker.tick()
    assert.equal(f.read(row)!.status, 'failed')
    f.advance(3_600_000)
    await worker.tick()
    assert.equal(f.read(row), undefined)
})

test('safe POST retries reauthorize and reuse the same persisted nonce', async t => {
    const f = fixture(t)
    const row = f.row()
    let authorizations = 0
    f.delivery.authorize = async () => { authorizations++ }
    f.delivery.send = async (_row, body) => {
        f.posts.push(body)
        if (f.posts.length === 1) throw { status: 429 }
        return ACK
    }
    await f.scheduler().tick()
    f.reopen()
    f.advance(30_000)
    await f.scheduler().tick()
    assert.equal(authorizations, 2)
    assert.equal(f.posts.length, 2)
    assert.equal(f.posts[0].nonce, f.posts[1].nonce)
    assert.deepEqual(f.receipt(row), { status: 'sent', messageId: ACK.id })
})

test('stop aborts a hanging POST, marks it uncertain and leaves the next row pending', async t => {
    const f = fixture(t)
    const row = f.row()
    const next = f.row()
    let signal!: AbortSignal
    let sends = 0
    f.delivery.send = async (_row, _body, current) => {
        sends++
        signal = current
        return new Promise(() => {})
    }
    const worker = f.scheduler()
    const tick = worker.tick()
    await nextTurn()
    worker.stop()
    await tick
    assert.equal(signal.aborted, true)
    assert.equal(f.read(row)!.status, 'uncertain')
    assert.equal(f.read(next)!.status, 'pending')
    assert.equal(f.read(next)!.attempts, 0)
    await worker.tick()
    assert.equal(sends, 1)
})
