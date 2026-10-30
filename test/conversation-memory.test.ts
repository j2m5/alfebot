import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationMemory, FLOOD_CHANNEL_ID, type RememberedMessage } from '../src/conversation-memory.js'

const now = 1_800_000_000_000
function message(id: string, extra: Partial<RememberedMessage> = {}): RememberedMessage {
    return { id, channelId: FLOOD_CHANNEL_ID, authorId: 'alice', authorName: 'Алиса',
        role: 'user', content: `текст-${id}`, createdAt: now - 1000, parentId: null, ownerId: null, ...extra }
}
function memory(t: any) {
    const db = new ConversationMemory(':memory:')
    t.after(() => db.close())
    return db
}

test('SQLite сохраняет сообщения после открытия заново; редактирование не дублирует', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'alfebot-chat-'))
    const path = join(dir, 'chat.sqlite')
    const first = new ConversationMemory(path)
    first.remember(message('1'), now)
    first.remember(message('1', { content: 'исправлено' }), now)
    first.close()
    const second = new ConversationMemory(path)
    t.after(() => { second.close(); rmSync(dir, { recursive: true, force: true }) })
    assert.equal(second.get('1', now)?.content, 'исправлено')
    assert.equal(second.count(), 1)
})

test('чужие каналы не сохраняются и не получают контекст флудилки', (t) => {
    const db = memory(t)
    db.remember(message('1'), now)
    db.remember(message('2', { channelId: 'private-channel', content: 'секрет' }), now)
    assert.equal(db.count(), 1)
    assert.deepEqual(db.context('private-channel', 'new', null, now), [])
    assert.ok(!JSON.stringify(db.context(FLOOD_CHANNEL_ID, 'new', null, now)).includes('секрет'))
})

test('reply сохраняет цепочку отдельно от фона, исключает текущий вопрос и не дублирует', (t) => {
    const db = memory(t)
    db.remember(message('question', { content: 'Корабль называется Кабачок' }), now)
    db.remember(message('answer', { role: 'assistant', authorId: 'bot', content: 'Запомнил Кабачок', parentId: 'question', ownerId: 'alice' }), now)
    db.remember(message('background', { authorId: 'bob', content: 'Завтра рейд', createdAt: now - 500 }), now)
    db.remember(message('current', { content: 'Как он называется?', parentId: 'answer', createdAt: now }), now)
    const context = db.context(FLOOD_CHANNEL_ID, 'current', 'answer', now)
    assert.deepEqual(context.slice(-2).map((m: any) => m.role), ['user', 'assistant'])
    const text = JSON.stringify(context)
    assert.ok(text.includes('Завтра рейд'))
    assert.ok(text.includes('Алиса'))
    assert.ok(!text.includes('Как он называется?'))
    assert.equal(context.filter((m: any) => m.content.includes('Запомнил Кабачок')).length, 1)
})

test('повторный ask продолжает только своего пользователя и только 30 минут', (t) => {
    const db = memory(t)
    db.remember(message('a', { role: 'assistant', ownerId: 'alice' }), now)
    db.remember(message('b', { role: 'assistant', ownerId: 'bob', createdAt: now }), now)
    assert.equal(db.latestReply('alice', now)?.id, 'a')
    assert.equal(db.latestReply('bob', now)?.id, 'b')
    assert.equal(db.latestReply('alice', now + 31 * 60_000), undefined)
})

test('срок хранения и удаление родителя исключают записи вместе с зависимыми ответами', (t) => {
    const db = memory(t)
    db.remember(message('old', { createdAt: now - 8 * 86_400_000 }), now)
    assert.equal(db.get('old', now), undefined)
    db.remember(message('1'), now)
    db.remember(message('2', { role: 'assistant', parentId: '1', ownerId: 'alice' }), now)
    db.remember(message('3', { parentId: '2' }), now)
    db.remove('1')
    assert.equal(db.get('2', now), undefined)
    assert.equal(db.get('3', now), undefined)
    db.prune(now + 8 * 86_400_000)
    assert.equal(db.count(), 0)
})

test('контекст ограничен 6000 символами, циклические ссылки не зацикливают сборку', (t) => {
    const db = memory(t)
    for (let i = 0; i < 45; i++) db.remember(message(String(i), { content: 'Ж'.repeat(4000), createdAt: now - 100 + i }), now)
    db.remember(message('a', { parentId: 'b' }), now)
    db.remember(message('b', { parentId: 'a' }), now)
    const context = db.context(FLOOD_CHANNEL_ID, 'new', 'a', now)
    assert.ok(context.reduce((n: number, m: any) => n + m.content.length, 0) <= 6000)
    assert.ok(context.length <= 9)
    assert.ok(context.some((m: any) => m.content.includes('текст-a')))
})

test('удаление slash-ответа удаляет и сохранённый невидимый вопрос', (t) => {
    const db = memory(t)
    db.remember(message('ask:1', { content: 'Удали этот вопрос' }), now)
    db.remember(message('answer', { role: 'assistant', parentId: 'ask:1' }), now)
    db.remove('answer')
    assert.equal(db.get('ask:1', now), undefined)
    assert.equal(db.get('answer', now), undefined)
})

test('сброс очищает историю и не даёт вернуть сообщения до границы сброса', (t) => {
    const db = memory(t)
    db.remember(message('question'), now)
    db.remember(message('answer', { role: 'assistant', parentId: 'question', ownerId: 'alice' }), now)
    const result = db.reset(now)
    assert.equal(result.reset, true)
    assert.equal(db.count(), 0)
    assert.equal(db.latestReply('alice', now), undefined)
    db.remember(message('old'), now + 1)
    db.remember(message('at-reset', { createdAt: now }), now + 1)
    db.remember(message('fresh', { createdAt: now + 1, content: 'Новый разговор' }), now + 1)
    assert.equal(db.count(), 1)
    const context = JSON.stringify(db.context(FLOOD_CHANNEL_ID, 'next', 'answer', now + 1))
    assert.ok(context.includes('Новый разговор'))
    assert.ok(!context.includes('текст-'))
})

test('общий перерыв 30 минут: отказ не стирает новые сообщения и не продлевает срок', (t) => {
    const db = memory(t)
    assert.equal(db.reset(now).reset, true)
    db.remember(message('fresh', { createdAt: now + 1 }), now + 1)
    assert.deepEqual(db.reset(now + 1_799_999), { reset: false, nextAllowedAt: now + 1_800_000 })
    assert.ok(db.get('fresh', now + 1_799_999))
    assert.equal(db.resetAt, now)
    assert.equal(db.reset(now + 1_800_000).reset, true)
    assert.equal(db.count(), 0)
})

test('граница сброса и перерыв сохраняются после открытия SQLite заново и видны другому соединению', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'alfebot-reset-'))
    const path = join(dir, 'chat.sqlite')
    const first = new ConversationMemory(path)
    const second = new ConversationMemory(path)
    t.after(() => { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }) })
    first.remember(message('old'), now)
    first.reset(now)
    second.remember(message('old'), now + 1)
    assert.equal(second.count(), 0)
    const reopened = new ConversationMemory(path)
    try {
        assert.equal(reopened.resetAt, now)
        assert.deepEqual(reopened.reset(now + 1), { reset: false, nextAllowedAt: now + 1_800_000 })
        reopened.remember(message('stale'), now + 1)
        assert.equal(reopened.count(), 0)
    } finally { reopened.close() }
})
