import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType, PermissionFlagsBits as P, Routes } from 'discord.js'
import { createDiscordTools } from '../src/discord-tools.js'
import type { DiscordToolContext } from '../src/tool-types.js'
import { createToolRest } from '../src/tool-rest.js'
import { askModel } from '../src/llm.js'
import { modelToolResponse, useTestModelKey } from './helpers/model-response.js'

useTestModelKey()

const G = '100000000000000001', C = '100000000000000002'
const A = '100000000000000003', B = '100000000000000004', T = '100000000000000005'
const REQUEST = '100000000000000006', MESSAGE = '100000000000000007'
const AR = '100000000000000010', BR = '100000000000000011', TR = '100000000000000012'
const EMPLOYEE = '1242979048917831763'
const MODERATOR_ROLES = ['1242978551154868326', '1278077913899597936']
const ALL = P.ViewChannel | P.ReadMessageHistory | P.ManageMessages | P.ManageNicknames | P.ChangeNickname | P.ModerateMembers | P.ManageRoles | P.SendMessages | P.SendPolls | P.CreatePublicThreads
const signal = () => new AbortController().signal
const POLL_REQUEST = 'Создай опрос «Во что играем?» с вариантами «CS2», «Dota», «Ни во что»'
const POLL_ARGS = { question: 'Во что играем?', answers: ['CS2', 'Dota', 'Ни во что'] }
const THREAD_REQUEST = 'Создай ветку «Катки на выходных»'
const THREAD_ARGS = { name: 'Катки на выходных' }
function member(id: string, roles: string[] = [], username = `user${id}`) {
    return { user: { id, username, global_name: null, bot: id === B }, nick: null as string | null, roles, communication_disabled_until: null as string | null }
}
function fixture(text = `timeout <@${T}> for 5 minutes`) {
    const roles = [
        { id: G, name: '@everyone', position: 0, permissions: String(P.ViewChannel | P.ReadMessageHistory), managed: false },
        { id: AR, name: 'actor', position: 10, permissions: String(ALL), managed: false },
        { id: BR, name: 'bot', position: 9, permissions: String(ALL), managed: false },
        { id: TR, name: 'target', position: 1, permissions: '0', managed: false },
        { id: EMPLOYEE, name: 'Employee', position: 2, permissions: '0', managed: false },
        ...MODERATOR_ROLES.map((id, i) => ({ id, name: `moderator-${i}`, position: 3 + i, permissions: '0', managed: false }))
    ]
    const members = new Map([[A, member(A, [AR, MODERATOR_ROLES[0]])], [B, member(B, [BR])], [T, member(T, [TR], 'Alice')]])
    const guild = { id: G, owner_id: '100000000000000099' }
    const channel = { id: C, guild_id: G, type: ChannelType.GuildText, permission_overwrites: [] as { id: string; type: number; allow: string; deny: string }[] }
    const calls: { method: string; route: string; options: any }[] = []
    let hook: ((method: string, route: string, options: any) => Promise<unknown> | unknown) | undefined
    const rest: any = Object.fromEntries(['get', 'patch', 'put', 'delete', 'post'].map(method => [method, async (route: string, options: any) => {
        calls.push({ method, route, options })
        assert.ok(options.signal instanceof AbortSignal)
        const custom = await hook?.(method, route, options)
        if (custom !== undefined) return custom
        if (method !== 'get') return undefined
        if (route === Routes.guild(G)) return structuredClone(guild)
        if (route === Routes.guildRoles(G)) return structuredClone(roles)
        if (route === Routes.channel(C)) return structuredClone(channel)
        for (const [id, value] of members) if (route === Routes.guildMember(G, id)) return structuredClone(value)
        if (route === Routes.guildMembers(G) || route === Routes.guildMembersSearch(G)) return structuredClone([...members.values()])
        if (route === Routes.channelMessage(C, MESSAGE)) return { id: MESSAGE, channel_id: C, author: { id: T } }
        throw Object.assign(new Error('sensitive network detail'), { status: 404 })
    }]))
    const context: DiscordToolContext = { rest, guildId: G, channelId: C, actorId: A, botId: B, requestId: REQUEST, requestText: text }
    return { context, roles, members, guild, channel, calls, hook(fn: typeof hook) { hook = fn }, writes: () => calls.filter(c => c.method !== 'get'),
        backend: () => createDiscordTools(context, [{ userId: T, names: ['начальник', 'начальника', 'начальнику'] }]) }
}

function creationFixture(text = POLL_REQUEST) {
    const f = fixture(text)
    f.hook((method, route, options) => {
        if (method === 'post') return route.endsWith('/messages')
            ? { id: MESSAGE, channel_id: C, poll: options.body.poll }
            : { id: MESSAGE, guild_id: G, parent_id: C, type: ChannelType.PublicThread }
    })
    return f
}

function notificationFixture(text = `Пингани <@${T}> и скажи ему, что мы ждём его в игре`) {
    const f = fixture(text)
    f.members.get(A)!.roles = [AR] // Notifications are not moderation.
    f.hook((method, route, options) => {
        if (method === 'post') return { id: MESSAGE, channel_id: C, content: options.body.content, author: { id: B } }
    })
    return f
}

test('notification sends one real mention and the requested message in the current channel', async () => {
    const f = notificationFixture(), backend = f.backend()
    const result = await backend.execute('notify_member', { userId: T, message: 'Мы ждём тебя в игре!' }, signal())
    assert.equal(result.ok, true, result.message)
    assert.equal(result.changed, true)
    assert.match(result.message, new RegExp(`https://discord.com/channels/${G}/${C}/${MESSAGE}`))
    const write = f.writes()[0]
    assert.equal(write.route, Routes.channelMessages(C))
    assert.deepEqual(write.options.body, { content: `<@${T}> Мы ждём тебя в игре!`,
        allowed_mentions: { parse: [], users: [T], replied_user: false }, nonce: REQUEST, enforce_nonce: true })
    assert.equal((await backend.execute('notify_member', { userId: T }, signal())).ok, false)
    assert.equal(f.writes().length, 1)
})

test('model can find a member then ping through MCP without a second generated success claim', async t => {
    const f = notificationFixture('Пингани Alice и скажи, что пора играть')
    let requests = 0
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        const body = JSON.parse(String(options!.body))
        assert.ok(body.tools.some((tool: any) => tool.function.name === 'notify_member'))
        if (++requests === 1) return modelToolResponse('get_member', { query: 'Alice' })
        assert.ok(body.messages.some((message: any) => message.role === 'tool' && message.content.includes(T)))
        return modelToolResponse('notify_member', { userId: T, message: 'Пора играть!' })
    })
    const answer = await askModel(f.context.requestText, [], signal(), [], 'chat', f.context)
    assert.match(answer, /Сообщение с упоминанием участника отправлено/)
    assert.equal(requests, 2)
    assert.equal(f.writes().length, 1)
    assert.equal(f.writes()[0].options.body.content, `<@${T}> Пора играть!`)
})

test('notifications understand polite requests, exact names, mentions, self and a trusted reply', async () => {
    for (const [text, userId] of [
        ['Алфе, можешь пингануть Alice и сказать ему, что пора играть?', T],
        [`<@${B}> позови <@!${T}> играть`, T],
        [`Если несложно, пингани ${T}`, T],
        ['Пингани меня', A], ['Пингани его и скажи, что пора', T],
        ['Передай Alice, что я не смогу сегодня', T],
        ['Пингани Alice, пожалуйста', T],
        ['Пингани Alice, плиз!', T],
        ['Пингани Alice и спроси, не занят ли он?', T],
        ['Пингани начальника и скажы ему, что мы собрались играть', T],
        ['Пингани Alice и сообщи ему, что мы ждём', T],
        ['Пингани Alice и поинтересуйся, когда он освободится', T],
        ['Пингани Alice и задай ему вопрос: не занят ли он?', T],
        ['Пингани Alice и спроси, когда он освободится?', T],
        ['Пингани Alice и узнай, играет ли он сейчас', T],
        ['Спроси у Alice, не занят ли он?', T],
        ['Можешь Alice пингануть и спросить, не занят ли он?', T],
        ['Напиши Alice: «Если сможешь, ответь мне?»', T],
        [`Ты можешь пингануть <@${T}>?`, T],
        [`Можешь позвать сюда <@${T}>?`, T],
        [`Передай привет <@${T}>`, T],
        ['Пингани Alice и скажи, что если он сможет, пусть напишет мне в личку завтра', T]
    ]) {
        const f = notificationFixture(text)
        f.context.replyUserId = T; f.context.replyMessageId = MESSAGE
        const result = await f.backend().execute('notify_member', { userId }, signal())
        assert.equal(result.ok, true, `${text}: ${result.message}`)
        assert.equal(f.writes()[0].options.body.content, `<@${userId}>`)
    }
})

test('notification message mentions cannot expand the notification audience', async () => {
    const f = notificationFixture()
    const message = `@everyone @here <@&${AR}> <@${A}> ждут тебя`
    assert.equal((await f.backend().execute('notify_member', { userId: T, message }, signal())).ok, true)
    assert.deepEqual(f.writes()[0].options.body.allowed_mentions, { parse: [], users: [T], replied_user: false })
})

test('notification cannot target someone from payload, history, a capability question or a negated request', async () => {
    for (const text of [
        `Не пингуй <@${T}>`, `Умеешь пинговать <@${T}>?`,
        `Если завтра придёт Alice, пингани <@${T}>`, `«Пингани <@${T}>»`,
        `Объясни, как пингануть <@${T}>`, 'Привет!',
        `Пингани <@${A}> и передай привет <@${T}>`,
        `Пингани <@${T}> и <@${A}>`, `Пингани @everyone`,
        `Пингани его`, `Пингани Alice.Bob`,
        `Пингани <@${T}> если он завтра придёт`,
        `Пингани <@${T}>, но не сейчас`, `Пингани <@${T}> завтра`,
        `Напиши <@${T}>: в личку, пожалуйста`,
        `Пингани <@${T}> и скажи ему в личку, что пора играть`,
        `Пингани <@${T}> в другой канал`, `Пингани <@${T}> в <#${A}>`,
        `Пингани <@${T}> <@${A}>`, 'Пингани Alice, Bob',
        `Спроси <@${T}>, в личку, не занят ли он?`,
        `Пингани <@${T}> и спроси его в личку, не занят ли он?`,
        `Пингани <@${T}> и спроси завтра, не занят ли он?`,
        `Спроси <@${T}>, завтра, не занят ли он?`,
        `Пингани <@${T}> и скажы ему в личку, что мы ждём`,
        `Пингани <@${T}> и поинтересуйся завтра, когда он освободится`,
        `Пингани <@${T}> и скажы ему, в личку, что мы ждём`,
        `Пингани <@${T}> и только когда он будет онлайн`,
        `Пингани <@${T}> и скажы ему, но не пингани сейчас`
    ]) {
        const f = notificationFixture(text)
        if (text === 'Пингани Alice, Bob') f.members.get(A)!.user.username = 'Bob'
        const result = await f.backend().execute('notify_member', { userId: T }, signal())
        assert.equal(result.ok, false, text)
        assert.equal(f.writes().length, 0, text)
    }
})

test('notification names must resolve uniquely even when model supplies a valid user ID', async () => {
    const f = notificationFixture('Пингани Alice')
    f.members.get(A)!.nick = 'Alice'
    const result = await f.backend().execute('notify_member', { userId: T }, signal())
    assert.equal(result.ok, false)
    assert.match(result.message, /неоднозначно/)
    assert.equal(f.writes().length, 0)
})

test('an explicit recipient with ordinary message prose is not rejected at the member-page limit', async () => {
    const f = notificationFixture(`Пингани <@${T}> и скажы ему, что пора играть`)
    const members = Array.from({ length: 1000 }, (_, index) => member(String(100000000000100000n + BigInt(index))))
    f.hook((method, route, options) => {
        if (method === 'get' && route === Routes.guildMembers(G)) return members
        if (method === 'post') return { id: MESSAGE, channel_id: C, content: options.body.content, author: { id: B } }
    })
    const result = await f.backend().execute('notify_member', { userId: T, message: 'Пора играть' }, signal())
    assert.equal(result.ok, true, result.message)
    assert.equal(f.writes().length, 1)
})

test('server alias resolves the agreed primary account instead of selecting among role holders', async () => {
    const f = notificationFixture('Пингани начальника и спроси, не занят ли он?')
    f.roles.find(role => role.id === TR)!.name = 'Начальник'
    f.members.get(A)!.roles.push(TR) // Same role also exists on another account.
    const backend = f.backend()
    const found = await backend.execute('get_member', { query: 'начальника' }, signal())
    assert.equal(found.ok, true, found.message)
    assert.equal((found.data as any).entries.length, 1)
    assert.equal((found.data as any).entries[0].id, T)
    const result = await backend.execute('notify_member', { userId: T, message: 'Ты сейчас не занят?' }, signal())
    assert.equal(result.ok, true, result.message)
    assert.equal(f.writes()[0].options.body.content, `<@${T}> Ты сейчас не занят?`)
    assert.ok(!f.calls.some(call => call.route === Routes.guildMembersSearch(G)))
})

test('a server alias cannot authorize another account or bypass guild membership', async () => {
    const f = notificationFixture('Пингани начальника')
    assert.equal((await f.backend().execute('notify_member', { userId: A }, signal())).ok, false)
    assert.equal(f.writes().length, 0)
    f.members.delete(T)
    assert.equal((await f.backend().execute('get_member', { query: 'начальник' }, signal())).ok, false)
    assert.equal((await f.backend().execute('notify_member', { userId: T }, signal())).ok, false)
    assert.equal(f.writes().length, 0)
})

test('notification requires caller and bot send permission plus target channel access', async () => {
    for (const [who, deny] of [[A, P.SendMessages], [B, P.SendMessages], [T, P.ViewChannel]] as const) {
        const f = notificationFixture()
        f.channel.permission_overwrites.push({ id: who, type: 1, allow: '0', deny: String(deny) })
        assert.equal((await f.backend().execute('notify_member', { userId: T }, signal())).ok, false)
        assert.equal(f.writes().length, 0)
    }
})

test('notification rechecks permissions immediately before posting and cannot ping nonmembers', async () => {
    const f = notificationFixture()
    let reads = 0
    f.hook((method, route) => {
        if (method === 'get' && route === Routes.channel(C) && ++reads === 2)
            return { ...f.channel, permission_overwrites: [{ id: A, type: 1, allow: '0', deny: String(P.SendMessages) }] }
    })
    assert.equal((await f.backend().execute('notify_member', { userId: T }, signal())).ok, false)
    assert.equal(f.writes().length, 0)
    const missing = notificationFixture()
    missing.members.delete(T)
    assert.equal((await missing.backend().execute('notify_member', { userId: T }, signal())).ok, false)
    assert.equal(missing.writes().length, 0)
})

test('notification validates message length and prevents destination or permission overrides', async () => {
    for (const extra of [{ message: 'x'.repeat(1801) }, { channelId: A }, { allowed_mentions: { parse: ['everyone'] } }, { actorId: B }]) {
        const f = notificationFixture()
        assert.equal((await f.backend().execute('notify_member', { userId: T, ...extra }, signal())).ok, false)
        assert.equal(f.writes().length, 0)
    }
})

test('notification does not retry an uncertain post or claim success for a wrong receipt', async () => {
    for (const receipt of ['network', 'wrong_channel', 'wrong_content']) {
        const f = notificationFixture(), backend = f.backend()
        f.hook((method, _route, options) => {
            if (method !== 'post') return
            if (receipt === 'network') throw new Error('lost response')
            return { id: MESSAGE, channel_id: receipt === 'wrong_channel' ? A : C,
                content: receipt === 'wrong_content' ? 'another action with same nonce' : options.body.content, author: { id: B } }
        })
        const result = await backend.execute('notify_member', { userId: T }, signal())
        assert.equal(result.ok, false)
        assert.equal(result.uncertain, true)
        await backend.execute('notify_member', { userId: T }, signal())
        assert.equal(f.writes().length, 1)
    }
})

test('poll uses native Discord payload, fixed current channel, safe mentions and default settings', async () => {
    const f = creationFixture(), backend = f.backend()
    const result = await backend.execute('create_poll', POLL_ARGS, signal())
    assert.equal(result.ok, true, result.message)
    assert.equal(result.changed, true)
    assert.match(result.message, new RegExp(`https://discord.com/channels/${G}/${C}/${MESSAGE}`))
    const write = f.writes()[0]
    assert.equal(write.method, 'post'); assert.equal(write.route, Routes.channelMessages(C))
    assert.deepEqual(write.options.body, { poll: { question: { text: POLL_ARGS.question },
        answers: POLL_ARGS.answers.map(text => ({ poll_media: { text } })), duration: 24, allow_multiselect: false, layout_type: 1 },
        allowed_mentions: { parse: [] }, nonce: REQUEST, enforce_nonce: true })
    assert.equal((await backend.execute('create_poll', POLL_ARGS, signal())).ok, false)
    assert.equal(f.writes().length, 1)
})

test('natural poll request accepts model-normalized question, numbered answers, duration and multiselect', async () => {
    const text = 'создай опрос на 1 час, вопрос - Сегодня играем? варианты ответов 1) Да 2) Конечно, можно выбрать оба варианта'
    const f = creationFixture(text)
    const result = await f.backend().execute('create_poll', { question: 'Сегодня играем?', answers: ['Да', 'Конечно'], durationHours: 1, allowMultiselect: true }, signal())
    assert.equal(result.ok, true, result.message)
    assert.deepEqual((f.writes()[0].options.body as any).poll, {
        question: { text: 'Сегодня играем?' }, answers: [{ poll_media: { text: 'Да' } }, { poll_media: { text: 'Конечно' } }],
        duration: 1, allow_multiselect: true, layout_type: 1
    })
})

test('polls accept inferred wording and defaults without a command template', async () => {
    for (const text of ['Алфе, можеш сделать голосовалку про игры на завтра?',
        'Давай голосование\nВо что играем?\n- CS2\n- Dota\n- Ни во что', 'Тогда запускай на сутки, один ответ']) {
        const f = creationFixture(text)
        const result = await f.backend().execute('create_poll', POLL_ARGS, signal())
        assert.equal(result.ok, true, result.message)
        assert.equal(f.writes()[0].options.body.poll.duration, 24)
        assert.equal(f.writes()[0].options.body.poll.allow_multiselect, false)
    }
})

test('explicit future conditions defer creation while polite requests remain conversational', async () => {
    for (const text of ['Если завтра все захотят играть, создай опрос про время начала',
        'Когда все соберутся, сделай ветку про катки', 'If everyone agrees tomorrow, create a poll']) {
        const f = creationFixture(text)
        const isThread = text.includes('ветку')
        const result = await f.backend().execute(isThread ? 'create_thread' : 'create_poll', isThread ? THREAD_ARGS : POLL_ARGS, signal())
        assert.equal(result.ok, false, text)
        assert.equal(f.writes().length, 0)
    }
    for (const text of ['Если несложно, сделай опрос про игры', 'Если можешь, создай голосование про игры', 'If possible, create a poll about games']) {
        const f = creationFixture(text)
        assert.equal((await f.backend().execute('create_poll', POLL_ARGS, signal())).ok, true, text)
    }
})

test('poll creation validates Discord limits, strict arguments and unambiguous options', async () => {
    for (const extra of [{ question: 'x'.repeat(301) }, { answers: ['one'] }, { answers: Array(11).fill('a') },
        { answers: ['a', 'a'] }, { answers: ['a', 'x'.repeat(56)] }, { durationHours: 0 }, { durationHours: 769 },
        { durationHours: 1.5 }, { channelId: T }, { guildId: T }, { content: '@everyone' }]) {
        const f = creationFixture()
        assert.equal((await f.backend().execute('create_poll', { ...POLL_ARGS, ...extra }, signal())).ok, false)
        assert.equal(f.writes().length, 0)
    }
})

test('question marks and negations inside poll content are accepted as data', async () => {
    const f = creationFixture('Создай опрос «Не играть, если дождь?» варианты: «Да», «Нет»')
    assert.equal((await f.backend().execute('create_poll', { question: 'Не играть, если дождь?', answers: ['Да', 'Нет'] }, signal())).ok, true)
})

test('public thread can be standalone, from an explicit message link or from trusted reply', async () => {
    for (const source of ['standalone', 'link', 'reply']) {
        const link = `https://discord.com/channels/${G}/${C}/${MESSAGE}`
        const suffix = source === 'link' ? ` к сообщению ${link}` : source === 'reply' ? ' к этому сообщению' : ''
        const f = creationFixture(THREAD_REQUEST + suffix)
        f.context.replyMessageId = MESSAGE
        const result = await f.backend().execute('create_thread', { ...THREAD_ARGS, ...(source === 'link' ? { messageId: link } : source === 'reply' ? { fromReply: true } : {}) }, signal())
        assert.equal(result.ok, true, result.message)
        const write = f.writes()[0]
        assert.equal(write.route, source === 'standalone' ? Routes.threads(C) : Routes.threads(C, MESSAGE))
        assert.deepEqual(write.options.body, { name: THREAD_ARGS.name, auto_archive_duration: 1440,
            ...(source === 'standalone' ? { type: ChannelType.PublicThread } : {}) })
        assert.match(result.message, new RegExp(`https://discord.com/channels/${G}/${MESSAGE}`))
    }
})

test('thread source and destination stay bound to trusted Discord context', async () => {
    for (const [text, extra] of [
        [THREAD_REQUEST, { messageId: MESSAGE }],
        [THREAD_REQUEST, { type: ChannelType.PrivateThread }], [THREAD_REQUEST, { channelId: T }],
        [`${THREAD_REQUEST} к этому сообщению`, { fromReply: true }],
        [`${THREAD_REQUEST} к сообщению https://discord.com/channels/${G}/${T}/${MESSAGE}`, { messageId: MESSAGE }],
        [`${THREAD_REQUEST} к сообщению https://discord.com/channels/${T}/${C}/${MESSAGE}`, { messageId: MESSAGE }]
    ] as const) {
        const f = creationFixture(text)
        assert.equal((await f.backend().execute('create_thread', { ...THREAD_ARGS, ...extra }, signal())).ok, false, text)
        assert.equal(f.writes().length, 0)
    }
})

test('thread accepts a natural request and a model-derived title without quotes', async () => {
    const f = creationFixture('можешь нам сделать тред для обсуждения каток в выходные?')
    const result = await f.backend().execute('create_thread', THREAD_ARGS, signal())
    assert.equal(result.ok, true, result.message)
    assert.equal(f.writes()[0].options.body.name, THREAD_ARGS.name)
})

test('thread supports an explicit source anywhere in natural text or a genuine current reply', async () => {
    for (const source of ['bare', 'link', 'reply']) {
        const f = creationFixture(source === 'bare' ? `Для сообщения ${MESSAGE} сделай ветку про катки`
            : source === 'link' ? `Вот https://discord.com/channels/${G}/${C}/${MESSAGE}, можешь завести к нему ветку?` : 'Давай тут отдельную ветку про катки')
        if (source === 'reply') f.context.replyMessageId = MESSAGE
        const result = await f.backend().execute('create_thread', { ...THREAD_ARGS, ...(source === 'reply' ? { fromReply: true } : { messageId: MESSAGE }) }, signal())
        assert.equal(result.ok, true, result.message)
        assert.equal(f.writes()[0].route, Routes.threads(C, MESSAGE))
    }
    for (const source of [`https://example.invalid/${MESSAGE}`, `ftp://example.invalid/${MESSAGE}`,
        `//discord.com/channels/${G}/${T}/${MESSAGE}`, `discord://channels/${G}/${T}/${MESSAGE}`,
        `ftp://example.invalid/https://discord.com/channels/${G}/${C}/${MESSAGE}`]) {
        const f = creationFixture(`Сделай ветку к ${source}`)
        assert.equal((await f.backend().execute('create_thread', { ...THREAD_ARGS, messageId: MESSAGE }, signal())).ok, false, source)
        assert.equal(f.writes().length, 0)
    }
})

test('both creator and bot need effective channel permissions for polls and threads', async () => {
    for (const [name, text, args, flag] of [
        ['create_poll', POLL_REQUEST, POLL_ARGS, P.SendPolls], ['create_poll', POLL_REQUEST, POLL_ARGS, P.SendMessages],
        ['create_thread', THREAD_REQUEST, THREAD_ARGS, P.CreatePublicThreads]
    ] as const) for (const who of [A, B]) {
        const f = creationFixture(text)
        f.channel.permission_overwrites.push({ id: who, type: 1, allow: '0', deny: String(flag) })
        const result = await f.backend().execute(name, args, signal())
        assert.equal(result.ok, false, `${name} ${who}`)
        assert.equal(f.writes().length, 0)
    }
})

test('creation rechecks revoked permissions and aborts before POST', async () => {
    for (const action of ['revoke', 'cancel']) {
        const f = creationFixture(), controller = new AbortController()
        let snapshots = 0
        f.hook((method, route) => {
            if (method === 'get' && route === Routes.guildRoles(G) && ++snapshots === 2) {
                if (action === 'revoke') f.roles[1].permissions = String(ALL & ~P.SendPolls)
                else controller.abort()
            }
        })
        const result = await f.backend().execute('create_poll', POLL_ARGS, controller.signal)
        assert.equal(result.ok, false); assert.equal(f.writes().length, 0)
    }
})

test('uncertain or malformed POST response never reports success or retries creation', async () => {
    for (const mode of ['network', 'malformed']) {
        const f = creationFixture()
        f.hook((method) => {
            if (method === 'post') {
                if (mode === 'network') throw new Error('socket lost')
                return { id: MESSAGE, channel_id: T }
            }
        })
        const backend = f.backend()
        const result = await backend.execute('create_poll', POLL_ARGS, signal())
        assert.equal(result.ok, false); assert.equal(result.uncertain, true)
        assert.equal((await backend.execute('create_poll', POLL_ARGS, signal())).ok, false)
        assert.equal(f.writes().length, 1)
    }
})

test('actual REST transport never repeats a rate-limited creation after caller loses permission', async () => {
    for (const [name, text, args, permission] of [
        ['create_poll', POLL_REQUEST, POLL_ARGS, P.SendPolls],
        ['create_thread', THREAD_REQUEST, THREAD_ARGS, P.CreatePublicThreads]
    ] as const) {
        const f = creationFixture(text), originalRest = f.context.rest
        let posts = 0
        f.context.rest = createToolRest('test-token', async (url, init) => {
            const route = new URL(url).pathname.replace('/api/v10', '') as `/${string}`
            if (init.method === 'GET') return Response.json(await originalRest.get(route, { signal: init.signal as AbortSignal }))
            assert.equal(init.method, 'POST')
            posts++
            if (posts === 1) {
                f.roles[1].permissions = String(ALL & ~permission)
                return Response.json({ message: 'Rate limited', retry_after: 0.001, global: false }, { status: 429,
                    headers: { 'Retry-After': '0.001', 'X-RateLimit-Limit': '10', 'X-RateLimit-Remaining': '1', 'X-RateLimit-Reset-After': '0.001' } })
            }
            const body = JSON.parse(String(init.body))
            return Response.json(name === 'create_poll'
                ? { id: MESSAGE, channel_id: C, poll: body.poll }
                : { id: MESSAGE, guild_id: G, parent_id: C, type: ChannelType.PublicThread })
        })
        const backend = f.backend()
        const result = await backend.execute(name, args, signal())
        assert.equal(posts, 1, name)
        assert.equal(result.ok, false)
        assert.ok(!result.uncertain)
        assert.match(result.message, /частоту|лимит/i)
        assert.equal((await backend.execute(name, args, signal())).ok, false)
        assert.equal(posts, 1)
    }
})

test('caller without ModerateMembers is denied even when bot has it', async () => {
    const f = fixture(); f.roles[1].permissions = String(P.ViewChannel)
    const result = await f.backend().execute('set_timeout', { userId: T, minutes: 5 }, signal())
    assert.equal(result.ok, false); assert.match(result.message, /caller.*ModerateMembers/i); assert.equal(f.writes().length, 0)
})

test('moderation actions require either approved caller role; owner and Administrator do not bypass it', async () => {
    const actions = [
        ['set_nickname', { userId: T, nickname: 'New' }, `set nickname <@${T}> to New`],
        ['set_timeout', { userId: T, minutes: 5 }, `timeout <@${T}> for 5 minutes`],
        ['delete_message', { messageId: MESSAGE }, `delete message ${MESSAGE}`],
        ['set_member_role', { userId: T, roleId: EMPLOYEE, enabled: true }, `give Employee to <@${T}>`]
    ] as const
    for (const allowedRole of MODERATOR_ROLES) for (const [name, args, text] of actions) {
        const f = fixture(text); f.members.get(A)!.roles = [AR, allowedRole]
        const result = await f.backend().execute(name, args, signal())
        assert.equal(result.ok, true, `${allowedRole} ${name}: ${result.message}`)
        assert.equal(f.writes().length, 1)
    }
    for (const mode of ['ordinary', 'owner', 'admin']) for (const [name, args, text] of actions) {
        const f = fixture(text); f.members.get(A)!.roles = [AR]
        if (mode === 'owner') f.guild.owner_id = A
        if (mode === 'admin') f.roles[1].permissions = String(ALL | P.Administrator)
        const result = await f.backend().execute(name, args, signal())
        assert.equal(result.ok, false, `${mode} ${name}`)
        assert.match(result.message, /1242978551154868326.*1278077913899597936/)
        assert.equal(f.writes().length, 0)
    }
})

test('moderation role is checked in refreshed snapshot and read/creation tools remain ungated', async () => {
    const f = fixture(`timeout <@${T}> for 5 minutes`)
    let actorReads = 0
    f.hook((_method, route) => {
        if (route === Routes.guildMember(G, A) && ++actorReads === 2) f.members.get(A)!.roles = [AR]
    })
    assert.equal((await f.backend().execute('set_timeout', { userId: T, minutes: 5 }, signal())).ok, false)
    assert.equal(f.writes().length, 0)
    const read = fixture()
    read.members.get(A)!.roles = [AR]
    assert.equal((await read.backend().execute('list_roles', {}, signal())).ok, true)
    assert.equal((await creationFixture().backend().execute('create_poll', POLL_ARGS, signal())).ok, true)
    assert.equal((await creationFixture(THREAD_REQUEST).backend().execute('create_thread', THREAD_ARGS, signal())).ok, true)
})

test('all Discord definitions have strict JSON schemas and mutation flags; forged authority is rejected before REST', async () => {
    const f = fixture(), backend = f.backend()
    assert.deepEqual(backend.definitions.map(d => d.name).sort(), ['create_poll', 'create_thread', 'delete_message', 'get_member', 'get_permissions', 'list_roles', 'notify_member', 'set_member_role', 'set_nickname', 'set_timeout'])
    for (const d of backend.definitions) { assert.equal(d.inputSchema.type, 'object'); assert.equal(d.inputSchema.additionalProperties, false); assert.equal(d.mutating, /^(set_|delete_|create_|notify_)/.test(d.name)) }
    for (const extra of [{ actorId: A }, { guildId: G }, { authorized: true }, { channelId: C }]) {
        assert.equal((await backend.execute('set_timeout', { userId: T, minutes: 5, ...extra }, signal())).ok, false)
    }
    assert.equal((await backend.execute('unknown', {}, signal())).ok, false)
    assert.equal(f.calls.length, 0)
})

test('nickname, clear nickname, timeout and clear timeout use exact routes and payloads', async () => {
    for (const [name, args, text, body] of [
        ['set_nickname', { userId: T, nickname: 'New Nick' }, `set nickname <@${T}> to New Nick`, { nick: 'New Nick' }],
        ['set_nickname', { userId: T, nickname: null }, `clear nickname <@${T}>`, { nick: null }],
        ['set_timeout', { userId: T, minutes: 5 }, `поставь таймаут <@${T}> на 5 минут`, null],
        ['set_timeout', { userId: T, minutes: 0 }, `сними таймаут <@${T}>`, { communication_disabled_until: null }]
    ] as const) {
        const f = fixture(text), before = Date.now()
        const result = await f.backend().execute(name, args, signal())
        assert.equal(result.ok, true, result.message); assert.equal(result.changed, true)
        assert.equal(f.writes().length, 1); assert.equal(f.writes()[0].route, Routes.guildMember(G, T))
        if (body) assert.deepEqual(f.writes()[0].options.body, body)
        else assert.ok(Math.abs(Date.parse(f.writes()[0].options.body.communication_disabled_until) - before - 300_000) < 2000)
        for (const route of [Routes.guild(G), Routes.guildRoles(G), Routes.channel(C), ...[A, B, T].map(id => Routes.guildMember(G, id))]) assert.ok(f.calls.some(c => c.route === route), route)
    }
})

test('nickname target and complete payload are bound to their positions in the request', async () => {
    for (const [text, nickname] of [
        [`set nickname <@${A}> to <@${T}>`, `<@${A}>`],
        [`Смени ник <@${A}> на <@${T}>`, `<@${A}>`],
        [`set nickname <@${T}> to New Nick`, 'New']
    ]) {
        const f = fixture(text)
        assert.equal((await f.backend().execute('set_nickname', { userId: T, nickname }, signal())).ok, false, text)
        assert.equal(f.writes().length, 0)
    }
    const f = fixture(`set nickname <@${T}> to <@${A}>`)
    assert.equal((await f.backend().execute('set_nickname', { userId: T, nickname: `<@${A}>` }, signal())).ok, true)
    assert.equal(f.writes()[0].route, Routes.guildMember(G, T))
})

test('unsupported numeric duration forms cannot authorize their trailing digits', async () => {
    for (const duration of ['1.5', '1,5', '+5', '-5', '−5', '1e5', '1/5', '- 5']) {
        const f = fixture(`timeout <@${T}> for ${duration} minutes`)
        assert.equal((await f.backend().execute('set_timeout', { userId: T, minutes: 5 }, signal())).ok, false, duration)
        assert.equal(f.writes().length, 0)
    }
})

test('self nickname requires ChangeNickname rather than ManageNicknames; bot still needs ManageNicknames and hierarchy', async () => {
    const f = fixture('change my nickname to Me'); f.roles[1].permissions = String(P.ViewChannel | P.ChangeNickname); f.roles[1].position = 5
    assert.equal((await f.backend().execute('set_nickname', { userId: A, nickname: 'Me' }, signal())).ok, true)
    f.roles[1].permissions = String(P.ViewChannel | P.ManageNicknames)
    assert.equal((await f.backend().execute('set_nickname', { userId: A, nickname: 'Me' }, signal())).ok, false)
    f.roles[1].permissions = String(P.ViewChannel | P.ChangeNickname); f.roles[2].permissions = String(P.ViewChannel)
    const denied = await f.backend().execute('set_nickname', { userId: A, nickname: 'Me' }, signal())
    assert.equal(denied.ok, false); assert.match(denied.message, /bot.*ManageNicknames/i)
})

test('documented Russian commands support nickname and recipient before Employee', async () => {
    for (const [tool, text, args] of [
        ['set_nickname', `Смени ник <@${T}> на Космический Кабачок`, { userId: T, nickname: 'Космический Кабачок' }],
        ['set_member_role', `Выдай <@${T}> роль Employee`, { userId: T, roleId: EMPLOYEE, enabled: true }],
        ['set_member_role', `Сними с <@${T}> роль Employee`, { userId: T, roleId: EMPLOYEE, enabled: false }]
    ] as const) {
        const f = fixture(text)
        const result = await f.backend().execute(tool, args, signal())
        assert.equal(result.ok, true, result.message)
        assert.equal(f.writes().length, 1)
    }
    const self = fixture('Выдай мне роль Employee')
    const denied = await self.backend().execute('set_member_role', { userId: A, roleId: EMPLOYEE, enabled: true }, signal())
    assert.equal(denied.ok, false)
    assert.match(denied.message, /высшая роль/i)
    assert.equal(self.writes().length, 0)
})

test('only Employee may be added/removed and managed/everyone roles are denied', async () => {
    for (const enabled of [true, false]) {
        const f = fixture(`${enabled ? 'give' : 'remove'} Employee ${enabled ? 'to' : 'from'} <@${T}>`)
        const result = await f.backend().execute('set_member_role', { userId: T, roleId: EMPLOYEE, enabled }, signal())
        assert.equal(result.ok, true, result.message); assert.equal(f.writes()[0].method, enabled ? 'put' : 'delete')
        assert.equal(f.writes()[0].route, Routes.guildMemberRole(G, T, EMPLOYEE))
    }
    for (const roleId of [AR, G, '999999999999999999']) {
        const f = fixture(`give role ${roleId} to <@${T}>`)
        assert.equal((await f.backend().execute('set_member_role', { userId: T, roleId, enabled: true }, signal())).ok, false)
        assert.equal(f.writes().length, 0)
    }
    const f = fixture(`give Employee to <@${T}>`); f.roles[4].managed = true
    assert.equal((await f.backend().execute('set_member_role', { userId: T, roleId: EMPLOYEE, enabled: true }, signal())).ok, false)
})

test('hierarchy applies to actor, bot, targets and assigned role; caller owner only bypasses own hierarchy', async () => {
    for (const which of ['actor', 'bot', 'role', 'owner', 'admin', 'self', 'botTarget']) {
        const f = fixture(); let id = T
        if (which === 'actor') f.roles[3].position = 10
        if (which === 'bot') f.roles[3].position = 9
        if (which === 'role') { f.roles[4].position = 11; f.context.requestText = `give Employee to <@${T}>` }
        if (which === 'owner') f.guild.owner_id = T
        if (which === 'admin') f.roles[3].permissions = String(P.Administrator)
        if (which === 'self') id = A
        if (which === 'botTarget') id = B
        if (which !== 'role') f.context.requestText = `timeout <@${id}> for 5 minutes`
        const result = await f.backend().execute(which === 'role' ? 'set_member_role' : 'set_timeout', which === 'role' ? { userId: T, roleId: EMPLOYEE, enabled: true } : { userId: id, minutes: 5 }, signal())
        assert.equal(result.ok, false, which); assert.equal(f.writes().length, 0)
    }
    const f = fixture(); f.guild.owner_id = A; f.roles[1].position = 0; f.roles[3].position = 8
    assert.equal((await f.backend().execute('set_timeout', { userId: T, minutes: 5 }, signal())).ok, true)
    f.roles[3].position = 9
    assert.equal((await f.backend().execute('set_timeout', { userId: T, minutes: 5 }, signal())).ok, false)
})

test('deletion uses exactly one bound message ID/link or trusted reply, never invocation or another channel', async () => {
    for (const ref of [MESSAGE, `https://discord.com/channels/${G}/${C}/${MESSAGE}`, undefined]) {
        const f = fixture(ref ? `delete message ${ref}` : 'delete the replied message'); f.context.replyMessageId = MESSAGE
        const result = await f.backend().execute('delete_message', ref ? { messageId: ref } : {}, signal())
        assert.equal(result.ok, true, result.message); assert.equal(f.writes().length, 1)
        assert.equal(f.writes()[0].route, Routes.channelMessage(C, MESSAGE))
    }
    for (const [text, ref] of [[`delete message ${REQUEST}`, REQUEST], ['delete some message', MESSAGE], [`delete message https://discord.com/channels/${G}/${T}/${MESSAGE}`, `https://discord.com/channels/${G}/${T}/${MESSAGE}`]]) {
        const f = fixture(text); assert.equal((await f.backend().execute('delete_message', { messageId: ref }, signal())).ok, false); assert.equal(f.writes().length, 0)
    }
})

test('channel overwrite order honors role union then member overwrite; ManageMessages required for caller and bot', async () => {
    const f = fixture(`delete message ${MESSAGE}`)
    f.channel.permission_overwrites = [{ id: G, type: 0, allow: '0', deny: String(P.ManageMessages) }, { id: AR, type: 0, allow: String(P.ManageMessages), deny: '0' }, { id: A, type: 1, allow: '0', deny: String(P.ManageMessages) }]
    assert.equal((await f.backend().execute('delete_message', { messageId: MESSAGE }, signal())).ok, false)
    f.channel.permission_overwrites[2].allow = String(P.ManageMessages); f.channel.permission_overwrites[2].deny = '0'
    f.channel.permission_overwrites.push({ id: BR, type: 0, allow: String(P.ManageMessages), deny: '0' })
    assert.equal((await f.backend().execute('delete_message', { messageId: MESSAGE }, signal())).ok, true)
    f.roles[2].permissions = String(P.ViewChannel)
    f.channel.permission_overwrites.pop()
    assert.equal((await f.backend().execute('delete_message', { messageId: MESSAGE }, signal())).ok, false)
})

test('all reads refresh authorization; wrong guild, hidden channels, unknown channels and threads fail closed', async () => {
    for (const mode of ['guild', 'hiddenActor', 'hiddenBot', 'thread', 'unsupported']) {
        const f = fixture()
        if (mode === 'guild') f.channel.guild_id = T
        if (mode === 'hiddenActor' || mode === 'hiddenBot') f.channel.permission_overwrites = [{ id: mode === 'hiddenActor' ? A : B, type: 1, allow: '0', deny: String(P.ViewChannel) }]
        if (mode === 'thread') f.channel.type = ChannelType.PrivateThread
        if (mode === 'unsupported') f.channel.type = 999 as any
        for (const [name, args] of [['get_member', {}], ['list_roles', {}], ['get_permissions', {}]] as const) assert.equal((await f.backend().execute(name, args, signal())).ok, false, mode)
    }
    const f = fixture(), backend = f.backend()
    assert.equal((await backend.execute('list_roles', {}, signal())).ok, true)
    f.roles[0].permissions = '0'; f.roles[1].permissions = '0'
    assert.equal((await backend.execute('list_roles', {}, signal())).ok, false)
    assert.equal(f.calls.filter(c => c.route === Routes.guildRoles(G)).length, 2)
})

test('reads return bounded roles, explicit permissions, fresh members and honest ambiguous search', async () => {
    const f = fixture(), backend = f.backend()
    const self = await backend.execute('get_member', {}, signal()); assert.equal(self.ok, true); assert.equal((self.data as any).member.id, A)
    const roles = await backend.execute('list_roles', {}, signal()); assert.equal((roles.data as any).complete, true); assert.ok((roles.data as any).entries[1].permissions.includes('ManageNicknames'))
    const search = await backend.execute('get_member', { query: 'user' }, signal()); assert.equal(search.ok, true); assert.equal((search.data as any).ambiguous, true)
    const perms = await backend.execute('get_permissions', { userId: T }, signal()); assert.equal(perms.ok, true); assert.equal((perms.data as any).member.id, T); assert.ok((perms.data as any).bot.permissions.includes('ManageMessages'))
    for (let i = 0; i < 300; i++) f.roles.push({ ...f.roles[3], id: String(200000000000000000n + BigInt(i)) })
    const bounded = await backend.execute('list_roles', {}, signal()); assert.equal((bounded.data as any).complete, false); assert.ok(JSON.stringify(bounded.data).length < 30_000)
})

test('ordinary questions, negation, history, mismatched target/value/direction cannot authorize writes', async () => {
    for (const text of [`what permissions does <@${T}> need for timeout?`, `do not timeout <@${T}> for 5 minutes`, `не ставь таймаут <@${T}> на 5 минут`, `Earlier someone said: timeout <@${T}> for 5 minutes`, `timeout <@${A}> for 5 minutes`, `timeout <@${T}> and <@${A}> for 5 minutes`, `timeout <@${T}> for 10 minutes`, `clear timeout <@${T}>`, `Explain this: "timeout <@${T}> for 5 minutes"`]) {
        const f = fixture(text); assert.equal((await f.backend().execute('set_timeout', { userId: T, minutes: 5 }, signal())).ok, false, text); assert.equal(f.writes().length, 0)
    }
    const f = fixture(`give Admin to <@${T}>`)
    assert.equal((await f.backend().execute('set_member_role', { userId: T, roleId: EMPLOYEE, enabled: true }, signal())).ok, false)
})

test('target binds to literal unique name or trusted reply, but ambiguous names deny', async () => {
    const f = fixture('timeout Alice for 5 minutes')
    assert.equal((await f.backend().execute('set_timeout', { userId: T, minutes: 5 }, signal())).ok, true)
    f.members.set('100000000000000055', member('100000000000000055', [], 'Alice'))
    assert.equal((await f.backend().execute('set_timeout', { userId: T, minutes: 5 }, signal())).ok, false)
    f.context.requestText = 'timeout the replied user for 5 minutes'; f.context.replyUserId = T
    assert.equal((await f.backend().execute('set_timeout', { userId: T, minutes: 5 }, signal())).ok, true)
})

test('validation rejects timeout bounds, empty/long nickname, conflicting search and forged extras', async () => {
    const f = fixture(), backend = f.backend()
    for (const args of [{ userId: T, minutes: -1 }, { userId: T, minutes: 40321 }, { userId: T, minutes: 1.5 }, { userId: T, minutes: '5' }]) assert.equal((await backend.execute('set_timeout', args, signal())).ok, false)
    for (const nickname of ['', 'x'.repeat(33)]) assert.equal((await backend.execute('set_nickname', { userId: T, nickname }, signal())).ok, false)
    assert.equal((await backend.execute('get_member', { userId: T, query: 'Alice' }, signal())).ok, false)
    assert.equal((await backend.execute('get_permissions', { guildId: G }, signal())).ok, false)
    assert.equal(f.calls.length, 0)
})

test('abort during checks prevents late writes even if REST ignores signal; pre-aborted does no REST', async () => {
    const f = fixture(), ctl = new AbortController(); ctl.abort()
    assert.equal((await f.backend().execute('set_timeout', { userId: T, minutes: 5 }, ctl.signal)).ok, false); assert.equal(f.calls.length, 0)
    const active = new AbortController(); let release!: () => void; let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    f.hook(async (method, route) => { if (method === 'get' && route === Routes.guildMember(G, T)) { entered(); await new Promise<void>(resolve => { release = resolve }) } })
    const call = f.backend().execute('set_timeout', { userId: T, minutes: 5 }, active.signal)
    await waiting; active.abort()
    const result = await call; assert.equal(result.ok, false); assert.notEqual(result.uncertain, true)
    release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.writes().length, 0)
})

test('one mutation attempt per session including failed/uncertain write and concurrent calls', async () => {
    for (const failure of [undefined, Object.assign(new Error('secret token'), { status: 403 }), new Error('secret token')]) {
        const f = fixture(), backend = f.backend()
        f.hook((method) => { if (method !== 'get' && failure) throw failure })
        const results = await Promise.all([backend.execute('set_timeout', { userId: T, minutes: 5 }, signal()), backend.execute('set_timeout', { userId: T, minutes: 5 }, signal())])
        assert.equal(f.writes().length, 1)
        assert.equal(results.filter(r => r.changed).length, failure ? 0 : 1)
        if (failure && !('status' in failure)) assert.equal(results.filter(r => r.uncertain).length, 1)
        assert.ok(results.every(r => !r.message.includes('secret')))
        assert.equal((await backend.execute('set_timeout', { userId: T, minutes: 5 }, signal())).ok, false)
    }
})

test('abort after dispatch gives uncertain receipt and no retry; confirmed success survives abort', async () => {
    const f = fixture(), ctl = new AbortController(); let release!: () => void; let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    f.hook(async method => { if (method !== 'get') { entered(); await new Promise<void>(resolve => { release = resolve }) } })
    const backend = f.backend(), pending = backend.execute('set_timeout', { userId: T, minutes: 5 }, ctl.signal)
    await waiting; ctl.abort(); const result = await pending
    assert.equal(result.ok, false); assert.equal(result.uncertain, true); assert.notEqual(result.changed, true)
    release(); assert.equal((await backend.execute('set_timeout', { userId: T, minutes: 5 }, signal())).ok, false); assert.equal(f.writes().length, 1)
})

test('REST authorization errors fail closed without leaked details or partial success', async () => {
    const f = fixture(); f.hook((_method, route) => { if (route === Routes.guildRoles(G)) throw Object.assign(new Error('secret'), { status: 403 }) })
    const result = await f.backend().execute('list_roles', {}, signal())
    assert.equal(result.ok, false); assert.ok(!result.message.includes('secret')); assert.equal(f.writes().length, 0)
})

test('current capability questions, quoted targets and substring collisions do not authorize mutations', async () => {
    for (const text of [`can you timeout <@${T}> for 5 minutes?`, `could you set nickname <@${T}> to New?`, `умеешь ставить таймаут <@${T}> на 5 минут?`, `timeout Malice for 5 minutes`, `timeout Alice2 for 5 minutes`, `timeout Alice_Bob for 5 minutes`, `timeout Alice.Bob for 5 minutes`, `timeout Alice-Bob for 5 minutes`, `timeout Alice\u0301 for 5 minutes`, `timeout someone named "Alice" for 5 minutes, is that possible?`]) {
        const f = fixture(text)
        const result = await f.backend().execute(text.includes('nickname') ? 'set_nickname' : 'set_timeout', text.includes('nickname') ? { userId: T, nickname: 'New' } : { userId: T, minutes: 5 }, signal())
        assert.equal(result.ok, false, text); assert.equal(f.writes().length, 0)
    }
})

test('nickname value cannot stand in for a member target; self/reply cannot be overridden by a payload mention', async () => {
    for (const [text, nickname] of [[`set my nickname to <@${T}>`, `<@${T}>`], ['set nickname to Alice', 'Alice'], [`set nickname to <@${T}>`, `<@${T}>`]]) {
        const f = fixture(text)
        assert.equal((await f.backend().execute('set_nickname', { userId: T, nickname }, signal())).ok, false, text)
        assert.equal(f.writes().length, 0)
    }
})

test('bot nickname uses ChangeNickname and current-member route; actor still needs ManageNicknames and hierarchy', async () => {
    const f = fixture(`set nickname <@${B}> to Helper`)
    f.roles[2].permissions = String(P.ViewChannel | P.ChangeNickname)
    const result = await f.backend().execute('set_nickname', { userId: B, nickname: 'Helper' }, signal())
    assert.equal(result.ok, true, result.message)
    assert.equal(f.writes()[0].route, Routes.guildMember(G, '@me'))
    f.roles[1].permissions = String(P.ViewChannel | P.ChangeNickname)
    assert.equal((await f.backend().execute('set_nickname', { userId: B, nickname: 'Helper' }, signal())).ok, false)
})

test('guild member mutations cannot gain authority from channel-only permission overwrites', async () => {
    const f = fixture(); f.roles[1].permissions = String(P.ViewChannel)
    f.channel.permission_overwrites = [{ id: A, type: 1, allow: String(P.ModerateMembers), deny: '0' }]
    assert.equal((await f.backend().execute('set_timeout', { userId: T, minutes: 5 }, signal())).ok, false)
    assert.equal(f.writes().length, 0)
})

test('permissions lost during message lookup prevent final write', async () => {
    const f = fixture(`delete message ${MESSAGE}`)
    f.hook((_method, route) => { if (route === Routes.channelMessage(C, MESSAGE)) f.roles[1].permissions = String(P.ViewChannel) })
    assert.equal((await f.backend().execute('delete_message', { messageId: MESSAGE }, signal())).ok, false)
    assert.equal(f.writes().length, 0)
})

test('current request context is copied; read partial errors are explicitly incomplete', async () => {
    const f = fixture(), backend = f.backend(); f.context.requestText = 'what can you do?'
    assert.equal((await backend.execute('set_timeout', { userId: T, minutes: 5 }, signal())).ok, true)
    const p = fixture()
    p.hook((_method, route) => { if (route === Routes.guildMember(G, T)) throw Object.assign(new Error('private'), { status: 404 }) })
    const result = await p.backend().execute('get_member', { query: 'user' }, signal())
    assert.equal(result.ok, true); assert.equal((result.data as any).complete, false)
    assert.equal((result.data as any).entries.length, 2); assert.equal((result.data as any).ambiguous, true)
})

test('receipts are Russian, specific, and cannot emit a mass mention from a nickname', async () => {
    const f = fixture(`set nickname <@${T}> to @everyone`)
    const result = await f.backend().execute('set_nickname', { userId: T, nickname: '@everyone' }, signal())
    assert.equal(result.ok, true); assert.match(result.message, /[А-Яа-яЁё]/); assert.ok(result.message.includes(T))
    assert.ok(!result.message.includes('@everyone')); assert.ok(!result.message.includes('@here'))
    const t = fixture(), ctl = new AbortController()
    t.hook(method => { if (method !== 'get') queueMicrotask(() => ctl.abort()) })
    const confirmed = await t.backend().execute('set_timeout', { userId: T, minutes: 5 }, ctl.signal)
    // If cancellation wins before REST confirms, report uncertainty; never fabricate failure/no-op.
    assert.ok(confirmed.changed === true || confirmed.uncertain === true)
})

test('forged source links and message bulk commands cannot authorize a normalized message ID', async () => {
    for (const text of [`delete message https://evil.invalid/channels/${G}/${C}/${MESSAGE}`, `delete all messages including ${MESSAGE}`, `delete messages ${MESSAGE}`, `удали все сообщения включая ${MESSAGE}`]) {
        const f = fixture(text)
        assert.equal((await f.backend().execute('delete_message', { messageId: MESSAGE }, signal())).ok, false, text)
        assert.equal(f.writes().length, 0)
    }
})

test('mentioning an action inside another requested operation cannot authorize that action', async () => {
    for (const [name, args, text] of [
        ['set_timeout', { userId: T, minutes: 5 }, `set nickname <@${T}> to timeout for 5 minutes`],
        ['set_member_role', { userId: T, roleId: EMPLOYEE, enabled: false }, `remove nickname <@${T}> Employee`],
        ['delete_message', { messageId: MESSAGE }, `remove timeout ${MESSAGE}`]
    ] as const) {
        const f = fixture(text)
        assert.equal((await f.backend().execute(name, args, signal())).ok, false, text)
        assert.equal(f.writes().length, 0)
    }
})

test('specified permissions channel must belong to this guild and be visible to caller and bot', async () => {
    const OTHER = '100000000000000088'
    for (const mode of ['foreign', 'hiddenActor', 'hiddenBot', 'allowed']) {
        const f = fixture()
        f.hook((_method, route) => {
            if (route === Routes.channel(OTHER)) return { ...structuredClone(f.channel), id: OTHER, guild_id: mode === 'foreign' ? T : G,
                permission_overwrites: mode === 'hiddenActor' || mode === 'hiddenBot' ? [{ id: mode === 'hiddenActor' ? A : B, type: 1, allow: '0', deny: String(P.ViewChannel) }] : [] }
        })
        const result = await f.backend().execute('get_permissions', { userId: T, channelId: OTHER }, signal())
        assert.equal(result.ok, mode === 'allowed', mode)
        if (result.ok) assert.equal((result.data as any).channelId, OTHER)
    }
})

test('all mutation permission gates apply independently to caller and bot', async () => {
    for (const who of [1, 2]) for (const [name, args, text, flag] of [
        ['set_nickname', { userId: T, nickname: 'New' }, `set nickname <@${T}> to New`, P.ManageNicknames],
        ['set_timeout', { userId: T, minutes: 5 }, `timeout <@${T}> for 5 minutes`, P.ModerateMembers],
        ['delete_message', { messageId: MESSAGE }, `delete message ${MESSAGE}`, P.ManageMessages],
        ['set_member_role', { userId: T, roleId: EMPLOYEE, enabled: true }, `give Employee to <@${T}>`, P.ManageRoles]
    ] as const) {
        const f = fixture(text); f.roles[who].permissions = String(ALL & ~flag)
        const result = await f.backend().execute(name, args, signal())
        assert.equal(result.ok, false, `${who} ${name}`); assert.equal(f.writes().length, 0)
        assert.match(result.message, /[А-Яа-яЁё]/)
    }
})

test('HTTP 500/408 after write are uncertain and consume the attempt, with IDs-only audit', async (t) => {
    const audit: string[] = []
    t.mock.method(console, 'info', (...parts: unknown[]) => audit.push(parts.join(' ')))
    for (const status of [500, 408]) {
        const f = fixture(), backend = f.backend()
        f.hook(method => { if (method !== 'get') throw Object.assign(new Error('sensitive'), { status }) })
        const result = await backend.execute('set_timeout', { userId: T, minutes: 5 }, signal())
        assert.equal(result.uncertain, true); assert.equal(result.ok, false); assert.notEqual(result.changed, true)
        assert.equal((await backend.execute('set_timeout', { userId: T, minutes: 5 }, signal())).ok, false)
        assert.equal(f.writes().length, 1)
    }
    assert.equal(audit.length, 4)
    for (const entry of audit) {
        const parsed = JSON.parse(entry.slice(entry.indexOf('{')))
        assert.deepEqual(Object.keys(parsed).sort(), ['actorId', 'name', 'outcome', 'requestId', 'targetId'])
        assert.ok(!entry.includes('sensitive')); assert.ok(!entry.includes('minutes'))
    }
})

test('active caller timeout suppresses moderation and effective permissions reflect target restrictions', async () => {
    const f = fixture(); f.members.get(A)!.communication_disabled_until = new Date(Date.now() + 60_000).toISOString()
    assert.equal((await f.backend().execute('set_timeout', { userId: T, minutes: 5 }, signal())).ok, false)
    f.members.get(T)!.communication_disabled_until = new Date(Date.now() + 60_000).toISOString()
    const result = await f.backend().execute('get_permissions', { userId: T }, signal())
    assert.equal(result.ok, true)
    assert.deepEqual((result.data as any).member.permissions.sort(), ['ReadMessageHistory', 'ViewChannel'])
})

test('abort during final fresh authorization sends no write', async () => {
    const f = fixture(), ctl = new AbortController(); let channels = 0
    f.hook((_method, route) => { if (route === Routes.channel(C) && ++channels === 2) ctl.abort() })
    const result = await f.backend().execute('set_timeout', { userId: T, minutes: 5 }, ctl.signal)
    assert.equal(result.ok, false); assert.notEqual(result.uncertain, true); assert.equal(f.writes().length, 0)
})
