import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ReminderStore, MAX_REMINDER_DELAY_MS } from '../src/reminder-store.js'

const NOW = 1_800_000_000_000
const asDiscordId = (value: string) => {
    let hash = 0
    for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) % 10_000_000_000_000_000
    return `4${String(hash).padStart(16, '0')}`
}
const input = (overrides: Partial<Parameters<ReminderStore['schedule']>[0]> = {}) => ({
    guildId: '12345678901234567', channelId: '22345678901234567', userId: '32345678901234567',
    requestId: asDiscordId(overrides.requestId ?? 'default'), text: '  Remember this  ', dueAt: NOW + 60_000,
    ...overrides, requestId: asDiscordId(overrides.requestId ?? 'default'),
})

async function tempDb(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'alfebot-reminder-'))
    return join(dir, 'nested', 'reminders.sqlite')
}

async function withStore(fn: (store: ReminderStore, path: string) => void | Promise<void>) {
    const path = await tempDb()
    const store = new ReminderStore(path)
    try { await fn(store, path) } finally {
        store.close()
        await rm(join(path, '..', '..'), { recursive: true, force: true })
    }
}

test('persists reminders across reopen and returns the unchanged idempotent row', async () => withStore((store, path) => {
    const created = store.schedule(input())
    assert.equal(created.text, 'Remember this')
    const reopened = new ReminderStore(path)
    try {
        assert.deepEqual(reopened.schedule(input({ text: 'replacement', dueAt: NOW + 100_000 }), NOW), created)
        assert.deepEqual(reopened.list(created.guildId, created.userId), [created])
    } finally { reopened.close() }
}))

test('claims due reminders in due order only when due and retry time has arrived', () => withStore(store => {
    const later = store.schedule(input({ requestId: 'later', dueAt: NOW + 20 }), NOW)
    const first = store.schedule(input({ requestId: 'first', dueAt: NOW }), NOW - 1)
    assert.equal(store.claimDue(NOW - 1), undefined)
    assert.equal(store.claimDue(NOW)?.id, first.id)
    assert.equal(store.claimDue(NOW)?.id, undefined)
    assert.equal(store.claimDue(NOW + 20)?.id, later.id)
}))

test('idempotency remains fixed after cancellation', () => withStore(store => {
    const row = store.schedule(input(), NOW)
    assert.equal(store.cancel(row.id, row.guildId, row.userId, NOW), 'cancelled')
    assert.deepEqual(store.schedule(input({ dueAt: NOW + 90_000 }), NOW), { ...row, status: 'cancelled', updatedAt: NOW })
}))

test('isolates list and cancellation by guild and user', () => withStore(store => {
    const row = store.schedule(input(), NOW)
    assert.deepEqual(store.list('42345678901234567', row.userId), [])
    assert.deepEqual(store.list(row.guildId, '42345678901234567'), [])
    assert.equal(store.cancel(row.id, '42345678901234567', row.userId), 'not_found')
    assert.equal(store.cancel(row.id, row.guildId, '42345678901234567'), 'not_found')
}))

test('lists live reminders before failures even when failures fill the limit', () => withStore(store => {
    for (let i = 0; i < 50; i++) {
        const failed = store.schedule(input({ requestId: `failure-${i}`, dueAt: NOW }), NOW - 1)
        store.claimDue(NOW)
        store.finish(failed.id, 'failed', NOW)
    }
    const live = store.schedule(input({ requestId: 'live', dueAt: NOW + 1 }), NOW)
    const reminders = store.list(live.guildId, live.userId)
    assert.equal(reminders.length, 50)
    assert.equal(reminders[0]?.id, live.id)
}))

test('two connections atomically claim a due reminder once', () => withStore((a, path) => {
    const b = new ReminderStore(path)
    try {
        a.schedule(input({ dueAt: NOW }), NOW - 1)
        assert.ok(a.claimDue(NOW))
        assert.equal(b.claimDue(NOW), undefined)
    } finally { b.close() }
}))

test('cancel reports sending and terminal or missing reminders as not found', () => withStore(store => {
    const row = store.schedule(input({ dueAt: NOW }), NOW - 1)
    assert.ok(store.claimDue(NOW))
    assert.equal(store.cancel(row.id, row.guildId, row.userId, NOW), 'sending')
    assert.equal(store.finish(row.id, 'sent', NOW, '42345678901234567'), true)
    assert.equal(store.cancel(row.id, row.guildId, row.userId, NOW), 'not_found')
}))

test('a cancellation that wins before claim prevents delivery', () => withStore(store => {
    const row = store.schedule(input({ dueAt: NOW }), NOW - 1)
    assert.equal(store.cancel(row.id, row.guildId, row.userId, NOW), 'cancelled')
    assert.equal(store.claimDue(NOW), undefined)
}))

test('interrupted sending becomes uncertain and is never automatically reclaimed', () => withStore(store => {
    const row = store.schedule(input({ dueAt: NOW }), NOW - 1)
    store.claimDue(NOW)
    assert.equal(store.recoverInterrupted(NOW + 1), 1)
    assert.equal(store.list(row.guildId, row.userId)[0]?.status, 'uncertain')
    assert.equal(store.claimDue(NOW + 1), undefined)
}))

test('retry returns sending reminder to pending until its retry time', () => withStore(store => {
    const row = store.schedule(input({ dueAt: NOW }), NOW - 1)
    store.claimDue(NOW)
    assert.equal(store.retry(row.id, NOW + 10, NOW, 'temporary failure'), true)
    assert.equal(store.claimDue(NOW + 9), undefined)
    assert.equal(store.claimDue(NOW + 10)?.attempts, 2)
}))

test('enforces 50 active reminders per guild and user', () => withStore(store => {
    for (let i = 0; i < 50; i++) store.schedule(input({ requestId: `cap-${i}`, dueAt: NOW + i + 1 }), NOW)
    assert.throws(() => store.schedule(input({ requestId: 'cap-over', dueAt: NOW + 100 }), NOW), /50/)
    const other = store.schedule(input({ guildId: '42345678901234567', requestId: 'other', dueAt: NOW + 101 }), NOW)
    assert.equal(other.status, 'pending')
}))

test('rejects invalid IDs, text, and due times', () => withStore(store => {
    for (const bad of [
        input({ guildId: '123' }), input({ channelId: '1234567890123456x' }), input({ userId: '123456789012345678901' }),
        { ...input(), requestId: 'request-1' }, { ...input(), requestId: '02345678901234567' },
        input({ text: '   ' }), input({ text: 'x'.repeat(501) }), input({ dueAt: NOW }), input({ dueAt: NOW + MAX_REMINDER_DELAY_MS + 1 }),
        input({ dueAt: NOW + 0.5 }),
    ]) assert.throws(() => store.schedule(bad, NOW))
}))

test('prunes old terminal reminders but preserves pending and fresh reminders', () => withStore(store => {
    const old = store.schedule(input({ dueAt: NOW + 1 }), NOW)
    const pending = store.schedule(input({ requestId: 'pending', dueAt: NOW + 2 }), NOW)
    store.schedule(input({ requestId: 'sent', dueAt: NOW }), NOW - 1)
    const sent = store.claimDue(NOW)!
    store.finish(sent.id, 'sent', NOW - 7 * 24 * 60 * 60 * 1000 - 1)
    store.prune(NOW)
    assert.deepEqual(store.list(old.guildId, old.userId).map(x => x.id), [old.id, pending.id])
}))
