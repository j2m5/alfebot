import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isFloodTrigger, AnswerGate, FloodChat } from '../src/flood-chat.js'
import { FLOOD_CHANNEL_ID, ConversationMemory } from '../src/conversation-memory.js'
import type { Client, Message, ChatInputCommandInteraction } from 'discord.js'
import { Collection } from 'discord.js'
import { EventEmitter } from 'node:events'

const base = { channelId: FLOOD_CHANNEL_ID, author: { bot: false }, webhookId: null, content: 'привет', system: false }

test('только упоминание бота или reply к нему запускают ответ во флудилке', () => {
    assert.equal(isFloodTrigger(base, '123', false), false)
    assert.equal(isFloodTrigger({ ...base, content: '<@123> привет' }, '123', false), true)
    assert.equal(isFloodTrigger({ ...base, content: '<@!123> привет' }, '123', false), true)
    assert.equal(isFloodTrigger(base, '123', true), true)
    assert.equal(isFloodTrigger({ ...base, content: '<@456> привет' }, '123', false), false)
})

test('боты, вебхуки, системные события и другие каналы не запускают память/ответ', () => {
    for (const change of [{ channelId: 'other' }, { author: { bot: true } }, { webhookId: 'hook' }, { system: true }]) {
        assert.equal(isFloodTrigger({ ...base, content: '<@123>', ...change }, '123', true), false)
    }
})

test('занятый бот не ставит второе обращение в очередь, освобождение разрешает новое', () => {
    const gate = new AnswerGate()
    const release = gate.acquire()
    assert.ok(release)
    assert.equal(gate.acquire(), null)
    release()
    const second = gate.acquire()
    assert.ok(second)
    release() // старое освобождение не должно сбрасывать новый запрос
    assert.equal(gate.acquire(), null)
    second()
    assert.ok(gate.acquire())
})

function setup(t: any) {
    const memory = new ConversationMemory(':memory:')
    t.after(() => memory.close())
    const client = { user: { id: '123' } } as Client
    const chat = new FloodChat(client, memory)
    const sent: any[] = []
    let sequence = 0
    function message(id: string, content: string, extra: Record<string, unknown> = {}): Message {
        return {
            ...base, id, content, author: { id: 'alice', bot: false, username: 'Алиса', globalName: null },
            guild: null, member: null, reference: null, createdTimestamp: Date.now(),
            channel: { messages: { fetch: async () => null }, sendTyping: async () => {} },
            reply: async (options: any) => {
                sent.push(options)
                return message(`answer-${++sequence}`, options.content, { author: { id: '123', bot: true, username: 'Алфе' } })
            }, ...extra
        } as unknown as Message
    }
    return { chat, memory, sent, message }
}

test('обычный чат записывается без модели; упоминание и reply получают фон и ветку', async (t) => {
    const { chat, memory, sent, message } = setup(t)
    const requests: any[] = []
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        requests.push(JSON.parse(String(options.body)).messages)
        return Response.json({ message: { content: 'Наш корабль — Кабачок.' }, done: true })
    })
    await chat.onMessage(message('background', 'Корабль называется Кабачок'))
    assert.equal(requests.length, 0)
    assert.equal(sent.length, 0)
    assert.equal(memory.count(), 1)
    await chat.onMessage(message('question', '<@123> как называется корабль?'))
    assert.equal(requests.length, 1)
    assert.ok(JSON.stringify(requests[0]).includes('Корабль называется Кабачок'))
    assert.deepEqual(sent[0].allowedMentions, { parse: [], repliedUser: false })
    await chat.onMessage(message('followup', 'А почему так?', {
        reference: { messageId: 'answer-1', channelId: FLOOD_CHANNEL_ID },
        author: { id: 'bob', bot: false, username: 'Боб' }
    }))
    assert.equal(requests.length, 2)
    assert.ok(requests[1].some((m: any) => m.role === 'assistant' && m.content === 'Наш корабль — Кабачок.'))
    assert.ok(requests[1].at(-1).content.includes('Боб'))
    assert.equal(memory.get('answer-2')?.parentId, 'followup')
    assert.equal(memory.get('followup')?.parentId, 'answer-1')
})

test('другие каналы и боты не записываются и не вызывают модель', async (t) => {
    const { chat, memory, sent, message } = setup(t)
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected model request') })
    await chat.onMessage(message('outside', '<@123> секрет', { channelId: 'private' }))
    await chat.onMessage(message('bot', '<@123> цикл', { author: { id: 'bot', bot: true } }))
    assert.equal(memory.count(), 0)
    assert.equal(sent.length, 0)
})

test('удаление вопроса во время генерации предотвращает публикацию ответа', async (t) => {
    const { chat, memory, sent, message } = setup(t)
    t.mock.method(globalThis, 'fetch', async () => {
        memory.remove('question')
        return Response.json({ message: { content: 'Уже не нужен' }, done: true })
    })
    await chat.onMessage(message('question', '<@123> ответь'))
    assert.equal(sent.length, 0)
})

test('ответ из одного выдуманного эмодзи не оставляет обращение без сообщения', async (t) => {
    const { chat, sent, message } = setup(t)
    t.mock.method(globalThis, 'fetch', async () => Response.json({
        message: { content: '<:invented:999999999999999999>' }, done: true
    }))
    await chat.onMessage(message('question', '<@123> ответь'))
    assert.equal(sent.length, 1)
    assert.equal(sent[0].content, 'Модель не вернула текст.')
})

test('slash-вопрос сохраняется вместе с ответом; второй ask продолжает цепочку', async (t) => {
    const { chat, memory, message } = setup(t)
    const requests: any[] = []
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        requests.push(JSON.parse(String(options.body)).messages)
        return Response.json({ message: { content: 'Кабачок' }, done: true })
    })
    function interaction(id: string): ChatInputCommandInteraction {
        return {
            id, channelId: FLOOD_CHANNEL_ID, createdTimestamp: Date.now(),
            user: { id: 'alice', username: 'Алиса' }, guild: null, deferred: true,
            deferReply: async () => {},
            editReply: async (options: any) => {
                assert.deepEqual(options.allowedMentions, { parse: [], repliedUser: false })
                return message(`slash-answer-${id}`, options.content, { author: { id: '123', bot: true, username: 'Алфе' } })
            }
        } as unknown as ChatInputCommandInteraction
    }
    await chat.answerSlash(interaction('1'), 'Наш корабль называется Кабачок')
    await chat.answerSlash(interaction('2'), 'Как он называется?')
    assert.equal(memory.get('ask:2')?.parentId, 'slash-answer-1')
    assert.ok(requests[1].some((m: any) => m.role === 'assistant' && m.content === 'Кабачок'))
    assert.ok(requests[1].some((m: any) => m.content.includes('Наш корабль называется Кабачок')))
})

test('при запуске подхватывается только нужный канал без вызовов модели и ответов', async (t) => {
    const { memory, message, sent } = setup(t)
    const recent = new Collection([
        ['1', message('1', 'Обычный разговор')],
        ['2', message('2', 'бот', { author: { id: 'otherbot', bot: true } })],
        ['3', message('3', '<@123> старый вопрос')]
    ])
    const client = { user: { id: '123' }, channels: { fetch: async (id: string) => {
        assert.equal(id, FLOOD_CHANNEL_ID)
        return { isTextBased: () => true, messages: { fetch: async ({ limit }: any) => {
            assert.equal(limit, 40)
            return recent
        } } }
    } } } as unknown as Client
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected model request') })
    await new FloodChat(client, memory).bootstrap()
    assert.equal(memory.count(), 2)
    assert.equal(memory.get('2'), undefined)
    assert.equal(sent.length, 0)
})

test('события редактирования и удаления обновляют память даже для partial-сообщений', async (t) => {
    const { memory, message } = setup(t)
    const client = new EventEmitter() as EventEmitter & { user: { id: string } }
    client.user = { id: '123' }
    const chat = new FloodChat(client as unknown as Client, memory)
    chat.start()
    await chat.onMessage(message('original', 'Старое'))
    client.emit('messageUpdate', {}, { channelId: FLOOD_CHANNEL_ID, partial: true,
        fetch: async () => message('original', 'Новое') })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(memory.get('original')?.content, 'Новое')
    client.emit('messageDelete', { channelId: FLOOD_CHANNEL_ID, id: 'original' })
    assert.equal(memory.get('original'), undefined)
    client.removeAllListeners()
})
