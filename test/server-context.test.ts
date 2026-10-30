import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionFlagsBits, Routes, type Guild } from 'discord.js'
import { getServerContext } from '../src/server-context.js'

function member(id: string, roles: string[] = []) {
    return { user: { id, username: `user-${id}`, global_name: `Участник ${id}`, bot: false }, nick: null, roles }
}

function fixture(id = '100') {
    const roles = [
        { id, name: '@everyone', position: 0, permissions: String(PermissionFlagsBits.ViewChannel) },
        { id: '900', name: 'Командир', position: 2, permissions: String(PermissionFlagsBits.Administrator) }
    ]
    const members = [member('200', ['900']), { ...member('201'), nick: 'Алфе', user: { ...member('201').user, bot: true } }]
    const calls: { route: string; options: any }[] = []
    const guild = {
        id, name: `Сервер ${id}`, ownerId: '200', memberCount: members.length,
        client: { rest: { get: async (route: string, options: any) => {
            calls.push({ route, options })
            if (route === Routes.guildRoles(id)) return roles
            assert.equal(route, Routes.guildMembers(id))
            return members
        } } }
    } as unknown as Guild
    return { guild, roles, members, calls }
}

function snapshot(turn: Awaited<ReturnType<typeof getServerContext>>) {
    assert.ok(turn)
    assert.equal(turn.role, 'user')
    return JSON.parse(turn.content.slice(turn.content.indexOf('\n') + 1))
}

test('справочник содержит всех участников, их роли и явно выданные разрешения', async () => {
    const { guild, calls } = fixture()
    const data = snapshot(await getServerContext(guild))
    assert.equal(data.guild.id, guild.id)
    assert.equal(data.guild.ownerId, '200')
    assert.equal(data.members.complete, true)
    assert.equal(data.roles.complete, true)
    assert.equal(data.members.entries.length, 2)
    assert.deepEqual(data.members.entries[0], {
        id: '200', username: 'user-200', displayName: 'Участник 200', bot: false, roleIds: ['100', '900']
    })
    assert.equal(data.members.entries[1].displayName, 'Алфе')
    assert.equal(data.members.entries[1].bot, true)
    assert.deepEqual(data.roles.entries.find((r: any) => r.id === '900').permissions, ['Administrator'])
    assert.deepEqual(data.roles.entries.find((r: any) => r.id === '100').permissions, ['ViewChannel'])
    assert.equal(calls.length, 2)
    assert.ok(calls.every(c => c.options.signal instanceof AbortSignal))
})

test('следующий вопрос получает свежие роли и состав, серверы и личка изолированы', async () => {
    const { guild, members, roles } = fixture()
    const first = snapshot(await getServerContext(guild))
    members.splice(0, 1, member('202'))
    roles[1].name = 'Новое название'
    const second = snapshot(await getServerContext(guild))
    assert.equal(first.members.entries[0].id, '200')
    assert.equal(second.members.entries[0].id, '202')
    assert.equal(second.roles.entries[1].name, 'Новое название')
    const other = snapshot(await getServerContext(fixture('101').guild))
    assert.equal(other.guild.id, '101')
    assert.deepEqual(other.members.entries[0].roleIds, ['101', '900'])
    assert.equal(await getServerContext(null), null)
})

test('пагинация читает следующую страницу после максимального ID', async (t) => {
    const { guild, roles } = fixture()
    const cursors: (string | null)[] = []
    t.mock.method(guild.client.rest, 'get', async (route, options) => {
        if (route === Routes.guildRoles(guild.id)) return roles
        cursors.push(options.query.get('after'))
        assert.equal(options.query.get('limit'), '1000')
        if (!options.query.has('after')) return Array.from({ length: 1000 }, (_, i) => member(String(3000 - i)))
        return [member('3001')]
    })
    const data = snapshot(await getServerContext(guild))
    assert.deepEqual(cursors, [null, '3000'])
    assert.equal(data.members.fetched, 1001)
    assert.equal(data.members.complete, false) // Все страницы прочитаны, но в промпт поместилась лишь часть.
})

test('отказ читать участников не превращает кэш в полный список и сохраняет роли', async (t) => {
    const { guild, roles } = fixture()
    t.mock.method(guild.client.rest, 'get', async (route) => {
        if (route === Routes.guildRoles(guild.id)) return roles
        throw new Error('Missing access')
    })
    const data = snapshot(await getServerContext(guild))
    assert.equal(data.members.complete, false)
    assert.equal(data.members.fetched, 0)
    assert.deepEqual(data.members.entries, [])
    assert.equal(data.roles.complete, true)
})

test('при ошибке ролей сохраняются исходные ID ролей участников', async (t) => {
    const { guild, members } = fixture()
    t.mock.method(guild.client.rest, 'get', async (route) => {
        if (route === Routes.guildRoles(guild.id)) throw new Error('Unavailable')
        return members
    })
    const data = snapshot(await getServerContext(guild))
    assert.equal(data.roles.complete, false)
    assert.equal(data.members.complete, true)
    assert.deepEqual(data.members.entries[0].roleIds, ['100', '900'])
})

test('отмена запроса прерывает ожидание Discord даже при зависшем REST', async (t) => {
    const { guild, roles } = fixture()
    const controller = new AbortController()
    let restSignal: AbortSignal | undefined
    t.mock.method(guild.client.rest, 'get', async (route, options) => {
        restSignal = options.signal
        if (route === Routes.guildRoles(guild.id)) return roles
        queueMicrotask(() => controller.abort())
        return new Promise(() => {})
    })
    const data = snapshot(await getServerContext(guild, controller.signal))
    assert.equal(restSignal?.aborted, true)
    assert.equal(data.members.complete, false)
})

test('сбор справочника ограничен тремя секундами, зависшие запросы отменяются', { timeout: 5000 }, async (t) => {
    const { guild } = fixture()
    const signals: AbortSignal[] = []
    t.mock.method(guild.client.rest, 'get', async (_route, options) => {
        signals.push(options.signal)
        return new Promise(() => {})
    })
    const start = Date.now()
    const data = snapshot(await getServerContext(guild))
    assert.ok(Date.now() - start < 4000)
    assert.equal(data.members.complete, false)
    assert.equal(data.roles.complete, false)
    assert.ok(signals.every(s => s.aborted))
})

test('большой каталог ограничивает размер промпта и явно отмечает неполноту', async (t) => {
    const { guild, roles } = fixture()
    t.mock.method(guild.client.rest, 'get', async (route, options) => {
        if (route === Routes.guildRoles(guild.id)) return roles
        if (options.query.has('after')) return []
        return Array.from({ length: 1000 }, (_, i) => ({ ...member(String(i + 1)), nick: 'Я'.repeat(32) }))
    })
    const turn = await getServerContext(guild)
    const data = snapshot(turn)
    assert.ok(turn!.content.length <= 20_000)
    assert.equal(data.members.fetched, 1000)
    assert.equal(data.members.complete, false)
    assert.ok(data.members.entries.length > 0 && data.members.entries.length < 1000)
    assert.equal(data.roles.complete, true)
})
