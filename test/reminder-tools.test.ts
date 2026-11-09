import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionFlagsBits as P } from 'discord.js'
import { ReminderStore } from '../src/reminder-store.js'
import { createReminderTools } from '../src/reminder-tools.js'
import { createBotTools } from '../src/bot-tools.js'
import type { DiscordToolContext, ToolBackend } from '../src/tool-types.js'

const now = Date.parse('2026-11-09T20:00:00Z')
const guildId = '111111111111111111', channelId = '222222222222222222', actorId = '333333333333333333'
const signal = () => AbortSignal.timeout(1000)
const permissions = (member = P.SendMessages, bot = P.SendMessages): ToolBackend => ({
    definitions: [], execute: async () => ({ ok: true, message: 'Permissions', data: {
        channelId, member: { id: actorId, bitfield: String(member) }, bot: { id: '444444444444444444', bitfield: String(bot) }
    } })
})
const context = (store: ReminderStore): DiscordToolContext => ({ rest: {} as any, guildId, channelId, actorId,
    botId: '444444444444444444', requestId: '555555555555555555', requestText: 'Через 40 минут напомни про загрузку', reminders: store })

test('relative reminder is stored for trusted caller/channel and confirmed with actual time', async t => {
    const store = new ReminderStore(':memory:'); t.after(() => store.close())
    const ctx = context(store)
    const tools = createReminderTools(ctx, store, permissions(), () => now)
    const outcome = await tools.execute('create_reminder', { text: 'Проверить загрузку', delaySeconds: 2400 }, signal())
    assert.equal(outcome.ok, true)
    assert.equal(outcome.changed, true)
    const [reminder] = store.list(guildId, actorId)
    assert.equal(reminder.dueAt, now + 2400_000)
    assert.equal(reminder.channelId, channelId)
    assert.equal(reminder.userId, actorId)
    assert.match(outcome.message, new RegExp(`<t:${reminder.dueAt / 1000}:F>`))
    const again = await tools.execute('create_reminder', { text: 'Другая попытка', delaySeconds: 60 }, signal())
    assert.equal(again.ok, true)
    assert.equal(store.list(guildId, actorId).length, 1)
    assert.match(again.message, /Проверить загрузку/)
})

test('explicit offset is respected; missing timezone, impossible dates and invalid schedules fail closed', async t => {
    const store = new ReminderStore(':memory:'); t.after(() => store.close())
    const tools = createReminderTools(context(store), store, permissions(), () => now)
    for (const args of [
        { text: 'x' }, { text: 'x', delaySeconds: -1 }, { text: 'x', delaySeconds: 60, at: '2026-11-10T20:00:00+03:00' },
        { text: 'x', at: '2026-11-10T20:00:00' }, { text: 'x', at: '2027-02-30T20:00:00+03:00' },
        { text: 'x', at: '2026-11-09T19:00:00Z' }, { text: 'x', delaySeconds: 60, userId: '999999999999999999' }
    ]) assert.equal((await tools.execute('create_reminder', args, signal())).ok, false, JSON.stringify(args))
    assert.equal(store.list(guildId, actorId).length, 0)
    const outcome = await tools.execute('create_reminder', { text: 'Рейд', at: '2026-11-10T20:00:00+03:00' }, signal())
    assert.equal(outcome.ok, true)
    assert.equal(store.list(guildId, actorId)[0].dueAt, Date.parse('2026-11-10T17:00:00Z'))
})

test('both parties need send access; malformed permission data and aborted request never schedule', async t => {
    const store = new ReminderStore(':memory:'); t.after(() => store.close())
    for (const backend of [permissions(0n), permissions(P.SendMessages, 0n), {
        definitions: [], execute: async () => ({ ok: true, message: 'bad', data: {} })
    }, { definitions: [], execute: async () => ({ ok: false, message: 'Нет доступа' }) }]) {
        const tools = createReminderTools(context(store), store, backend, () => now)
        assert.equal((await tools.execute('create_reminder', { text: 'x', delaySeconds: 60 }, signal())).ok, false)
    }
    const controller = new AbortController(); controller.abort()
    const tools = createReminderTools(context(store), store, permissions(), () => now)
    assert.equal((await tools.execute('create_reminder', { text: 'x', delaySeconds: 60 }, controller.signal)).ok, false)
    assert.equal(store.list(guildId, actorId).length, 0)
})

test('list and cancel expose only caller reminders in current guild', async t => {
    const store = new ReminderStore(':memory:'); t.after(() => store.close())
    const own = store.schedule({ guildId, channelId, userId: actorId, requestId: '555555555555555555', text: 'Моё', dueAt: now + 60000 }, now)
    const foreign = store.schedule({ guildId, channelId, userId: '666666666666666666', requestId: '777777777777777777', text: 'Чужое', dueAt: now + 60000 }, now)
    const tools = createReminderTools(context(store), store, permissions(), () => now)
    const listing = await tools.execute('list_reminders', {}, signal())
    assert.equal(listing.ok, true)
    assert.match(JSON.stringify(listing.data), /Моё/)
    assert.doesNotMatch(JSON.stringify(listing.data), /Чужое/)
    assert.equal((await tools.execute('cancel_reminder', { reminderId: foreign.id }, signal())).ok, false)
    assert.equal((await tools.execute('cancel_reminder', { reminderId: own.id }, signal())).changed, true)
    assert.equal(store.list(guildId, actorId).length, 0)
})

test('bot backend shares one mutation allowance across reminders and Discord actions', async t => {
    const store = new ReminderStore(':memory:'); t.after(() => store.close())
    const backend = permissions()
    let writes = 0
    const original = backend.execute
    backend.definitions = [{ name: 'set_nickname', description: 'test', inputSchema: { type: 'object' }, mutating: true }]
    backend.execute = async (name, args, signal) => name === 'set_nickname'
        ? (writes++, { ok: true, changed: true, message: 'Changed' }) : original(name, args, signal)
    const tools = createBotTools(context(store), backend)
    assert.ok(tools.definitions.some(tool => tool.name === 'create_reminder'))
    assert.equal((await tools.execute('create_reminder', { text: 'x', delaySeconds: 60 }, signal())).ok, true)
    assert.equal((await tools.execute('set_nickname', {}, signal())).ok, false)
    assert.equal(writes, 0)
})

test('list preserves distinguishing suffixes and a guessed cancellation ID is rejected', async t => {
    const store = new ReminderStore(':memory:'); t.after(() => store.close())
    const first = store.schedule({ guildId, channelId, userId: actorId, requestId: '555555555555555555',
        text: 'x'.repeat(190) + ' — забрать посылку', dueAt: now + 60000 }, now)
    store.schedule({ guildId, channelId, userId: actorId, requestId: '666666666666666666',
        text: 'x'.repeat(190) + ' — проверить загрузку', dueAt: now + 60000 }, now)
    const tools = createReminderTools(context(store), store, permissions(), () => now)
    assert.equal((await tools.execute('cancel_reminder', { reminderId: first.id }, signal())).ok, false)
    const listing = await tools.execute('list_reminders', {}, signal())
    assert.match(JSON.stringify(listing.data), /забрать посылку/)
    assert.match(JSON.stringify(listing.data), /проверить загрузку/)
    assert.equal((await tools.execute('cancel_reminder', { reminderId: first.id }, signal())).ok, true)
    const explicit = createReminderTools({ ...context(store), requestText: 'отмени напоминание 2' }, store, permissions(), () => now)
    assert.equal((await explicit.execute('cancel_reminder', { reminderId: 2 }, signal())).ok, true)
})
