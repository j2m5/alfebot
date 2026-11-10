import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isFloodTrigger, AnswerGate, FloodChat } from '../src/flood-chat.js'
import { FLOOD_CHANNEL_ID, ConversationMemory } from '../src/conversation-memory.js'
import type { Client, Message, ChatInputCommandInteraction } from 'discord.js'
import { Collection, MessageFlags, PermissionFlagsBits, Routes } from 'discord.js'
import { EventEmitter } from 'node:events'
import { ReminderStore } from '../src/reminder-store.js'
import { modelTextResponse, modelToolResponse, useTestModelKey } from './helpers/model-response.js'

useTestModelKey()

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
    const client = { user: { id: '123' }, channels: { fetch: async () => ({ guildId: 'guild' }) } } as unknown as Client
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
    return { chat, memory, sent, message, client }
}

function resetInteraction(userId = 'alice', guildId: string | null = 'guild') {
    const sent: any[] = []
    const interaction = {
        guildId, channelId: 'another-channel', user: { id: userId }, memberPermissions: { has: () => false },
        deferReply: async (options: any) => sent.push({ kind: 'defer', ...options }),
        editReply: async (options: any) => sent.push({ kind: 'edit', ...options }),
        reply: async (options: any) => sent.push({ kind: 'reply', ...options })
    } as unknown as ChatInputCommandInteraction
    return { interaction, sent }
}

test('reset conversation memory preserves scheduled reminders', async t => {
    const { memory, client } = setup(t)
    const reminders = new ReminderStore(':memory:'); t.after(() => reminders.close())
    const guildId = '111111111111111111', userId = '222222222222222222'
    reminders.schedule({ guildId, userId, channelId: FLOOD_CHANNEL_ID, requestId: '333333333333333333',
        text: 'Проверить загрузку', dueAt: Date.now() + 60000 })
    await new FloodChat(client, memory, undefined, reminders).resetMemory(resetInteraction().interaction)
    assert.ok(memory.resetAt > 0)
    assert.equal(reminders.list(guildId, userId).length, 1)
})

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => { resolve = done })
    return { promise, resolve }
}

test('обычный чат записывается без модели; упоминание и reply получают фон и ветку', async (t) => {
    const { chat, memory, sent, message } = setup(t)
    const requests: any[] = []
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        requests.push(JSON.parse(String(options.body)).messages)
        return modelTextResponse('Наш корабль — Кабачок.')
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

function serverGuild() {
    const members = [{ user: { id: '200', username: 'User', global_name: 'Капитан' }, roles: ['900'] }]
    const roles = [
        { id: '100', name: '@everyone', position: 0, permissions: '0' },
        { id: '900', name: 'Командир', position: 1, permissions: String(PermissionFlagsBits.ManageRoles) }
    ]
    const guild = { id: '100', name: 'Наш сервер', ownerId: '200', memberCount: 1,
        emojis: { fetch: async () => new Collection() },
        client: { rest: { get: async (route: string) => route === Routes.guildRoles('100') ? roles : members } }
    }
    return { guild, members, roles }
}

test('диалог получает свежий справочник после истории, справочник не накапливается в SQLite', async (t) => {
    const { chat, memory, message } = setup(t)
    const { guild, roles } = serverGuild()
    const requests: any[][] = []
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        requests.push(JSON.parse(String(options.body)).messages)
        return modelTextResponse('Роль найдена.')
    })
    await chat.onMessage(message('background', 'Раньше роль называлась Страж'))
    await chat.onMessage(message('question', '<@123> Какие права у Командира?', { guild }))
    const context = requests[0].at(-2).content
    assert.ok(context.startsWith('Актуальный справочник сервера Discord'))
    assert.ok(context.includes('Командир') && context.includes('ManageRoles') && context.includes('Капитан'))
    assert.ok(requests[0].at(-1).content.includes('Какие права'))
    assert.ok(requests[0].some(m => m.content.includes('Раньше роль называлась Страж')))
    roles[1].name = 'Новый командир'
    await chat.onMessage(message('followup', '<@123> А сейчас?', { guild }))
    assert.ok(requests[1].at(-2).content.includes('Новый командир'))
    const saved = memory.context(FLOOD_CHANNEL_ID, 'unused', 'answer-2')
    assert.ok(!JSON.stringify(saved).includes('Актуальный справочник сервера Discord'))
})

test('сброс во время чтения Discord отменяет справочник и не запускает модель', { timeout: 2000 }, async (t) => {
    const { chat, sent, message } = setup(t)
    const { guild } = serverGuild()
    const started = deferred<void>()
    let signal: AbortSignal | undefined
    t.mock.method(guild.client.rest, 'get', async (_route, options: any) => {
        signal = options.signal
        started.resolve()
        return new Promise(() => {})
    })
    let modelCalls = 0
    t.mock.method(globalThis, 'fetch', async () => { modelCalls++; throw new Error('Unexpected model request') })
    const pending = chat.onMessage(message('question', '<@123> Кто на сервере?', { guild }))
    await started.promise
    await chat.resetMemory(resetInteraction().interaction)
    await pending
    assert.equal(signal?.aborted, true)
    assert.equal(modelCalls, 0)
    assert.equal(sent.length, 0)
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
        return modelTextResponse('Уже не нужен')
    })
    await chat.onMessage(message('question', '<@123> ответь'))
    assert.equal(sent.length, 0)
})

test('событие удаления исходного вопроса отменяет выполняющийся запрос', { timeout: 2000 }, async (t) => {
    const { memory, message, sent } = setup(t)
    const client = Object.assign(new EventEmitter(), { user: { id: '123' } })
    t.after(() => client.removeAllListeners())
    const chat = new FloodChat(client as unknown as Client, memory)
    chat.start()
    const started = deferred<void>()
    let requestSignal: AbortSignal | undefined
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        requestSignal = options.signal
        started.resolve()
        return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
    })
    const task = chat.onMessage(message('question', '<@123> Сделай действие'))
    await started.promise
    client.emit('messageDelete', { channelId: FLOOD_CHANNEL_ID, id: 'question' })
    // Проверяем отмену до ожидания задачи, иначе регрессия зависнет на таймауте.
    assert.equal(requestSignal?.aborted, true)
    await task
    assert.equal(sent.length, 0)
})

test('изменение текста исходного запроса отзывает действие; обновление превью его не отменяет', { timeout: 2000 }, async (t) => {
    const { memory, message, sent } = setup(t)
    const client = Object.assign(new EventEmitter(), { user: { id: '123' } })
    t.after(() => client.removeAllListeners())
    const chat = new FloodChat(client as unknown as Client, memory)
    chat.start()
    const started = deferred<void>()
    let requestSignal: AbortSignal | undefined
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        requestSignal = options.signal
        started.resolve()
        return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
    })
    const task = chat.onMessage(message('question', '<@123> Поставь таймаут'))
    await started.promise
    client.emit('messageUpdate', {}, message('question', '<@123> Поставь таймаут'))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(requestSignal?.aborted, false)
    client.emit('messageUpdate', {}, message('question', 'Передумал, не делай'))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(requestSignal?.aborted, true)
    await task
    assert.equal(sent.length, 0)
})

test('удаление или изменение запроса во время загрузки reply не запускает модель', { timeout: 2000 }, async (t) => {
    for (const action of ['delete', 'edit']) {
        const { memory, message, sent } = setup(t)
        const client = Object.assign(new EventEmitter(), { user: { id: '123' } })
        t.after(() => client.removeAllListeners())
        const chat = new FloodChat(client as unknown as Client, memory)
        chat.start()
        const loading = deferred<Message | null>()
        let modelCalls = 0
        const mock = t.mock.method(globalThis, 'fetch', async () => {
            modelCalls++
            return modelTextResponse('Готово.')
        })
        const task = chat.onMessage(message('question', '<@123> поставь таймаут @участник на 5 минут', {
            reference: { messageId: 'uncached', channelId: FLOOD_CHANNEL_ID },
            channel: { messages: { fetch: () => loading.promise } }
        }))
        if (action === 'delete') client.emit('messageDelete', { channelId: FLOOD_CHANNEL_ID, id: 'question' })
        else client.emit('messageUpdate', {}, message('question', 'Передумал'))
        loading.resolve(null)
        await task
        assert.equal(modelCalls, 0, action)
        assert.equal(sent.length, 0, action)
        mock.mock.restore()
    }
})

test('reset во время авторизации MCP не даёт инструменту выполнить изменение', { timeout: 3000 }, async (t) => {
    const { memory, message, sent } = setup(t)
    const guildId = '111111111111111111', botId = '222222222222222222'
    const actorId = '333333333333333333', targetId = '444444444444444444'
    const started = deferred<void>()
    let writes = 0
    let toolSignal: AbortSignal | undefined
    const rest = { get: async (_route: string, options: any) => {
        toolSignal = options.signal
        started.resolve()
        return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
    }, patch: async () => { writes++ }, put: async () => { writes++ }, delete: async () => { writes++ }, post: async () => { writes++ } }
    const guild = { id: guildId, name: 'Наш сервер', ownerId: actorId, memberCount: 1,
        emojis: { fetch: async () => new Collection() },
        client: { rest: { get: async (route: string) => route.endsWith('/roles')
            ? [{ id: guildId, name: '@everyone', position: 0, permissions: '0' }]
            : [{ user: { id: actorId, username: 'Алиса' }, roles: [] }] } } }
    const client = { user: { id: botId }, channels: { fetch: async () => ({ guildId }) } } as unknown as Client
    const chat = new FloodChat(client, memory, rest as any)
    t.mock.method(globalThis, 'fetch', async () => modelToolResponse('set_timeout', { userId: targetId, minutes: 5 }))
    const task = chat.onMessage(message('777777777777777777', `<@${botId}> поставь таймаут <@${targetId}> на 5 минут`, {
        guild, author: { id: actorId, username: 'Алиса', bot: false }
    }))
    await started.promise
    await chat.resetMemory(resetInteraction(actorId, guildId).interaction)
    await task
    assert.equal(toolSignal?.aborted, true)
    assert.equal(writes, 0)
    assert.equal(sent.length, 0)
    assert.equal(memory.count(), 0)
})

test('ответ из одного выдуманного эмодзи не оставляет обращение без сообщения', async (t) => {
    const { chat, sent, message } = setup(t)
    t.mock.method(globalThis, 'fetch', async () => modelTextResponse('<:invented:999999999999999999>'))
    await chat.onMessage(message('question', '<@123> ответь'))
    assert.equal(sent.length, 1)
    assert.equal(sent[0].content, 'Модель не вернула текст.')
})

test('slash-вопрос сохраняется вместе с ответом; второй ask продолжает цепочку', async (t) => {
    const { chat, memory, message } = setup(t)
    const { guild } = serverGuild()
    const requests: any[] = []
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        requests.push(JSON.parse(String(options.body)).messages)
        return modelTextResponse('Кабачок')
    })
    function interaction(id: string): ChatInputCommandInteraction {
        return {
            id, channelId: FLOOD_CHANNEL_ID, createdTimestamp: Date.now(),
            user: { id: 'alice', username: 'Алиса' }, guild, deferred: true,
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
    assert.ok(requests.every((messages: any[]) => messages.at(-2).content.includes('Актуальный справочник сервера Discord')))
    assert.equal(JSON.parse(requests[1].at(-1).content).userId, 'alice')
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
    memory.reset(Date.now() + 1)
    client.emit('messageUpdate', {}, { channelId: FLOOD_CHANNEL_ID, partial: true,
        fetch: async () => message('original', 'Не возвращать после сброса', { createdTimestamp: memory.resetAt - 1 }) })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(memory.get('original'), undefined)
    client.removeAllListeners()
})

test('/reset доступна обычному участнику; общий cooldown действует и для другого пользователя', async (t) => {
    const { chat, memory, message } = setup(t)
    let time = Date.now()
    t.mock.method(Date, 'now', () => time)
    await chat.onMessage(message('old', 'Старая переписка'))
    const first = resetInteraction()
    await chat.resetMemory(first.interaction)
    assert.equal(memory.count(), 0)
    assert.match(first.sent.at(-1).content, /память.*сброшена/i)
    assert.equal(first.sent[0].flags, MessageFlags.Ephemeral)
    time++
    await chat.onMessage(message('new', 'Новая переписка'))
    const second = resetInteraction('bob')
    await chat.resetMemory(second.interaction)
    assert.ok(memory.get('new'))
    assert.match(second.sent.at(-1).content, /<t:\d+:R>/)
    assert.equal(second.sent[0].flags, MessageFlags.Ephemeral)
})

test('сброс из другого сервера или лички не затрагивает память флудилки и её cooldown', async (t) => {
    const { chat, memory, message } = setup(t)
    await chat.onMessage(message('old', 'Разговор своего сервера'))
    for (const guildId of ['unrelated', null]) {
        await chat.resetMemory(resetInteraction('alice', guildId).interaction)
        assert.ok(memory.get('old'))
        assert.equal(memory.resetAt, 0)
    }
})

test('после сброса bootstrap не возвращает старые сообщения, но принимает свежие', async (t) => {
    const { memory, message } = setup(t)
    const time = Date.now()
    memory.reset(time)
    const client = { user: { id: '123' }, channels: { fetch: async () => ({
        isTextBased: () => true,
        messages: { fetch: async () => new Collection([
            ['old', message('old', 'Забытая переписка', { createdTimestamp: time - 1 })],
            ['new', message('new', 'Новая переписка', { createdTimestamp: time + 1 })]
        ]) }
    }) } } as unknown as Client
    await new FloodChat(client, memory).bootstrap()
    assert.equal(memory.get('old'), undefined)
    assert.ok(memory.get('new'))
    assert.equal(memory.count(), 1)
})

test('reply на старый ответ после reset запускает новый разговор без старого текста', async (t) => {
    const { chat, memory, sent, message } = setup(t)
    let time = Date.now()
    t.mock.method(Date, 'now', () => time)
    const old = message('old', 'Секретная старая история', { author: { id: '123', bot: true, username: 'Алфе' } })
    await chat.resetMemory(resetInteraction().interaction)
    time++
    const requests: any[] = []
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        requests.push(JSON.parse(String(options.body)).messages)
        return modelTextResponse('Начинаем заново')
    })
    await chat.onMessage(message('fresh', 'Привет!', {
        reference: { messageId: 'old', channelId: FLOOD_CHANNEL_ID },
        channel: { messages: { fetch: async () => old }, sendTyping: async () => {} }
    }))
    assert.equal(requests.length, 1)
    assert.ok(!JSON.stringify(requests).includes('Секретная старая история'))
    assert.equal(memory.get('old'), undefined)
    assert.equal(sent[0].content, 'Начинаем заново')
})

test('reset отменяет текущую генерацию и освобождает бота; поздний старый ответ не отправляется', async (t) => {
    const { chat, memory, sent, message } = setup(t)
    let time = Date.now()
    t.mock.method(Date, 'now', () => time)
    const started = deferred<void>()
    const oldResponse = deferred<Response>()
    let oldSignal!: AbortSignal
    let requests = 0
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        if (++requests === 1) {
            oldSignal = options.signal
            started.resolve()
            return oldResponse.promise
        }
        assert.ok(!String(options.body).includes('Старый вопрос'))
        return modelTextResponse('Новый ответ')
    })
    const oldTask = chat.onMessage(message('old', '<@123> Старый вопрос'))
    await started.promise
    await chat.resetMemory(resetInteraction().interaction)
    const aborted = oldSignal.aborted
    time++
    await chat.onMessage(message('new', '<@123> Новый вопрос'))
    oldResponse.resolve(modelTextResponse('Забытый ответ'))
    await oldTask
    assert.equal(aborted, true)
    assert.deepEqual(sent.map((reply) => reply.content), ['Новый ответ'])
    assert.ok(!JSON.stringify(memory.context(FLOOD_CHANNEL_ID, 'next', null)).includes('Забытый ответ'))
})

test('сброс во время /ask удаляет ожидание, не публикует старый ответ и не возвращает его в SQLite', async (t) => {
    const { chat, memory } = setup(t)
    const started = deferred<void>()
    const response = deferred<Response>()
    const sent: any[] = []
    let deleted = 0
    let signal!: AbortSignal
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        signal = options.signal
        started.resolve()
        return response.promise
    })
    const interaction = {
        id: 'old-ask', channelId: FLOOD_CHANNEL_ID, createdTimestamp: Date.now(),
        user: { id: 'alice', username: 'Алиса' }, guild: null, deferred: true,
        deferReply: async () => {}, editReply: async (options: any) => sent.push(options),
        followUp: async (options: any) => sent.push(options), deleteReply: async () => { deleted++ }
    } as unknown as ChatInputCommandInteraction
    const task = chat.answerSlash(interaction, 'Старый вопрос')
    await started.promise
    await chat.resetMemory(resetInteraction().interaction)
    response.resolve(modelTextResponse('Забытый ответ'))
    await task
    assert.equal(signal.aborted, true)
    assert.equal(sent.length, 0)
    assert.equal(deleted, 1)
    assert.equal(memory.count(), 0)
})

test('если сброс произошёл во время отправки ответа в Discord, позднее сообщение удаляется', async (t) => {
    const { chat, memory, message } = setup(t)
    const sending = deferred<void>()
    const sentResponse = deferred<Message>()
    let deleted = 0
    t.mock.method(globalThis, 'fetch', async () => modelTextResponse('Старый ответ'))
    const task = chat.onMessage(message('question', '<@123> Вопрос', { reply: async () => {
        sending.resolve()
        return sentResponse.promise
    } }))
    await sending.promise
    await chat.resetMemory(resetInteraction().interaction)
    sentResponse.resolve(message('late-answer', 'Старый ответ', {
        author: { id: '123', bot: true, username: 'Алфе' }, delete: async () => { deleted++ }
    }))
    await task
    assert.equal(deleted, 1)
    assert.equal(memory.count(), 0)
})

test('отклонённый повторный /reset не отменяет ответ на новый вопрос', async (t) => {
    const { chat, message, sent } = setup(t)
    let time = Date.now()
    t.mock.method(Date, 'now', () => time)
    await chat.resetMemory(resetInteraction().interaction)
    time++
    const started = deferred<void>()
    const response = deferred<Response>()
    let signal!: AbortSignal
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        signal = options.signal
        started.resolve()
        return response.promise
    })
    const task = chat.onMessage(message('new-question', '<@123> Новый вопрос'))
    await started.promise
    await chat.resetMemory(resetInteraction('bob').interaction)
    const aborted = signal.aborted
    response.resolve(modelTextResponse('Новый ответ'))
    await task
    assert.equal(aborted, false)
    assert.deepEqual(sent.map((entry) => entry.content), ['Новый ответ'])
})

test('reset во время deferReply не даёт старому /ask начать генерацию после подтверждения Discord', async (t) => {
    const { chat, memory } = setup(t)
    const starting = deferred<void>()
    const acknowledged = deferred<void>()
    let deleted = 0
    let requests = 0
    t.mock.method(globalThis, 'fetch', async () => {
        requests++
        return modelTextResponse('Старый ответ')
    })
    const interaction = {
        id: 'delayed-ask', channelId: FLOOD_CHANNEL_ID, createdTimestamp: Date.now(),
        user: { id: 'alice', username: 'Алиса' }, guild: null, deferred: false,
        deferReply: async () => {
            starting.resolve()
            await acknowledged.promise
            interaction.deferred = true
        },
        editReply: async () => {}, deleteReply: async () => { deleted++ }
    }
    const task = chat.answerSlash(interaction as unknown as ChatInputCommandInteraction, 'Старый вопрос')
    await starting.promise
    await chat.resetMemory(resetInteraction().interaction)
    acknowledged.resolve()
    await task
    assert.equal(requests, 0)
    assert.equal(memory.count(), 0)
    assert.equal(deleted, 1)
})

test('сообщение об ошибке модели тоже удаляется, если reset пришёл во время его отправки', async (t) => {
    const { chat, memory, message } = setup(t)
    const sending = deferred<void>()
    const response = deferred<Message>()
    let deleted = 0
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('Model unavailable') })
    t.mock.method(console, 'error', () => {})
    const task = chat.onMessage(message('question', '<@123> Вопрос', { reply: async () => {
        sending.resolve()
        return response.promise
    } }))
    await sending.promise
    await chat.resetMemory(resetInteraction().interaction)
    response.resolve(message('late-error', 'Ошибка модели', {
        author: { id: '123', bot: true, username: 'Алфе' }, delete: async () => { deleted++ }
    }))
    await task
    assert.equal(deleted, 1)
    assert.equal(memory.count(), 0)
})
