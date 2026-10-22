import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Collection, MessageFlags, type ChatInputCommandInteraction } from 'discord.js'
import { replyPlay, rollSlots, slotComment } from '../src/play.js'
import type { ServerEmoji } from '../src/server-emojis.js'

const emojis: ServerEmoji[] = [
    { id: '111', name: 'sanich', animated: false },
    { id: '222', name: 'dance', animated: true },
    { id: '333', name: 'kek', animated: false },
    { id: '444', name: 'hmm', animated: false }
]

function randomForTicket(ticket: number, pick: number = 0) {
    let first = true
    return (max: number) => {
        if (first) { first = false; return ticket }
        return pick % max
    }
}

test('из 100 равновероятных билетов 10 дают тройку, 30 пару, 60 разные эмодзи', () => {
    const counts = { jackpot: 0, pair: 0, miss: 0 }
    for (let ticket = 0; ticket < 100; ticket++) {
        const result = rollSlots(emojis, randomForTicket(ticket))
        assert.ok(result)
        counts[result.outcome]++
        const uniqueCount = new Set(result.emojis.map((emoji) => emoji.id)).size
        assert.equal(uniqueCount, { jackpot: 1, pair: 2, miss: 3 }[result.outcome])
        assert.equal(result.emojis.length, 3)
    }
    assert.deepEqual(counts, { jackpot: 10, pair: 30, miss: 60 })
})

test('границы шансов не добавляют лишний билет соседнему исходу', () => {
    for (const [ticket, expected] of [[0, 'jackpot'], [9, 'jackpot'], [10, 'pair'], [39, 'pair'], [40, 'miss'], [99, 'miss']] as const) {
        assert.equal(rollSlots(emojis, randomForTicket(ticket))?.outcome, expected)
    }
})

test('отличающаяся эмодзи пары может оказаться на любом из трёх мест', () => {
    const singletonPositions = new Set<number>()
    for (let pick = 0; pick < 3; pick++) {
        const result = rollSlots(emojis, randomForTicket(10, pick))!
        const ids = result.emojis.map((emoji) => emoji.id)
        singletonPositions.add(ids.findIndex((id) => ids.filter((other) => other === id).length === 1))
    }
    assert.deepEqual([...singletonPositions].sort(), [0, 1, 2])
})

test('слоты используют только переданные серверные эмодзи, включая анимированные, и не меняют каталог', () => {
    const original = structuredClone(emojis)
    const seen = new Set<string>()
    for (let pick = 0; pick < emojis.length; pick++) {
        const result = rollSlots(emojis, randomForTicket(0, pick))!
        for (const emoji of result.emojis) {
            assert.deepEqual(emoji, original.find((item) => item.id === emoji.id))
            seen.add(emoji.id)
        }
    }
    assert.deepEqual([...seen].sort(), ['111', '222', '333', '444'])
    assert.deepEqual(emojis, original)
})

test('если разных серверных эмодзи меньше трёх, игра не подменяет их стандартными', () => {
    for (const pool of [[], emojis.slice(0, 1), emojis.slice(0, 2), [emojis[0], emojis[0], emojis[1]]]) {
        assert.equal(rollSlots(pool), null)
    }
})

test('на минимальном каталоге из трёх эмодзи проигрыш всегда даёт три разные', () => {
    const result = rollSlots(emojis.slice(0, 3), randomForTicket(99))!
    assert.deepEqual(new Set(result.emojis.map((emoji) => emoji.id)), new Set(['111', '222', '333']))
})

function playInteraction(pool: ServerEmoji[] = emojis) {
    const cache = new Collection(pool.map((emoji) => [emoji.id, {
        ...emoji, available: true, roles: { cache: new Collection() }
    }]))
    const sent: { method: string; content: string; allowedMentions?: unknown; flags?: number }[] = []
    const interaction = {
        guild: { emojis: { cache, fetch: async () => cache }, members: { me: null } },
        deferReply: async () => { sent.push({ method: 'defer', content: '' }) },
        editReply: async (options: any) => { sent.push({ method: 'edit', ...options }) },
        followUp: async (options: any) => { sent.push({ method: 'followUp', ...options }) },
        reply: async (options: any) => { sent.push({ method: 'reply', ...options }) }
    } as unknown as ChatInputCommandInteraction
    return { interaction, sent, cache }
}

test('первое сообщение содержит только 3 серверных эмодзи, второе — комментарий именно к их результату', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('Неожиданный запрос к модели') })
    const { interaction, sent } = playInteraction()
    await replyPlay(interaction)
    assert.deepEqual(sent.map((entry) => entry.method), ['defer', 'edit', 'followUp'])
    assert.match(sent[1].content, /^<a?:\w+:\d+> <a?:\w+:\d+> <a?:\w+:\d+>$/)
    const codes = sent[1].content.split(' ')
    for (const code of codes) assert.ok(['<:sanich:111>', '<a:dance:222>', '<:kek:333>', '<:hmm:444>'].includes(code))
    assert.match(sent[2].content, { 1: /Победа!/, 2: /Пара!/, 3: /Без совпадений\./ }[new Set(codes).size]!)
    for (const message of sent.slice(1)) assert.deepEqual(message.allowedMentions, { parse: [] })
})

test('комментарии различаются внутри каждого исхода, не добавляют Unicode-эмодзи и помещаются в одно сообщение', () => {
    for (const [outcome, label] of [['jackpot', /Победа!/], ['pair', /Пара!/], ['miss', /Без совпадений\./]] as const) {
        const comments = [0, 1, 2].map((pick) => slotComment(outcome, (max) => pick % max))
        assert.equal(new Set(comments).size, 3)
        for (const comment of comments) {
            assert.match(comment, label)
            assert.ok(comment.length > 30 && comment.length <= 2000)
            assert.doesNotMatch(comment, /\p{Extended_Pictographic}/u)
        }
    }
})

test('команда недоступна в личных сообщениях и не запускает розыгрыш', async () => {
    const { interaction, sent } = playInteraction()
    Object.assign(interaction, { guild: null })
    await replyPlay(interaction)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].method, 'reply')
    assert.equal(sent[0].flags, MessageFlags.Ephemeral)
    assert.match(sent[0].content, /сервер/i)
})

test('недоступные и ограниченные ролями эмодзи исключаются, при недостатке нет ложного розыгрыша', async () => {
    const { interaction, sent, cache } = playInteraction()
    cache.get('333')!.available = false
    cache.get('444')!.roles.cache.set('restricted', { id: 'restricted' })
    await replyPlay(interaction)
    assert.deepEqual(sent.map((entry) => entry.method), ['defer', 'edit'])
    assert.match(sent[1].content, /тр[её]х|3/)
    assert.doesNotMatch(sent[1].content, /<a?:\w+:\d+>/)
})

test('комментарий отправляется только после успешной публикации результата', async () => {
    const { interaction, sent } = playInteraction()
    Object.assign(interaction, { editReply: async () => { throw new Error('Discord недоступен') } })
    await assert.rejects(replyPlay(interaction), /Discord недоступен/)
    assert.deepEqual(sent.map((entry) => entry.method), ['defer'])
})
