import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Collection } from 'discord.js'

import {
    SANICH_ROLE_ID,
    sanichEmojiText,
    shouldReplySanich,
    type SanichEmbed,
    type SanichMessage
} from '../src/sanich.js'

function guild(...names: string[]) {
    const emojis = names.map((name, index) => [String(index), { name, toString: () => `<:${name}:${index}>` }] as const)

    return { emojis: { cache: new Collection(emojis) } }
}

test('находит эмодзи sanich среди эмодзи сервера', () => {
    assert.equal(sanichEmojiText(guild('kek', 'sanich')), '<:sanich:1>')
})

test('возвращает null, если эмодзи sanich на сервере нет', () => {
    assert.equal(sanichEmojiText(guild('kek')), null)
})

test('возвращает null вне сервера', () => {
    assert.equal(sanichEmojiText(null), null)
})

function embeds(...types: string[]): SanichEmbed[] {
    return types.map((type) => ({ data: { type } }))
}

function message(overrides: { bot?: boolean; embeds?: string[]; roles?: string[] | null } = {}): SanichMessage {
    const roles = overrides.roles === undefined ? [SANICH_ROLE_ID] : overrides.roles

    return {
        author: { bot: overrides.bot ?? false },
        embeds: embeds(...(overrides.embeds ?? ['video'])),
        member: roles === null ? null : { roles: { cache: new Set(roles) } }
    }
}

test('отвечает на сообщение с превью от участника с ролью', () => {
    assert.equal(shouldReplySanich(message(), []), true)
})

test('не отвечает на сообщение без превью', () => {
    assert.equal(shouldReplySanich(message({ embeds: [] }), []), false)
})

test('не отвечает повторно, если превью уже было до обновления', () => {
    assert.equal(shouldReplySanich(message(), embeds('video')), false)
})

test('не отвечает на гифку', () => {
    assert.equal(shouldReplySanich(message({ embeds: ['gifv'] }), []), false)
})

test('отвечает, если рядом с гифкой есть обычное превью', () => {
    assert.equal(shouldReplySanich(message({ embeds: ['gifv', 'article'] }), []), true)
})

test('отвечает, если к гифке позже догрузилось обычное превью', () => {
    assert.equal(shouldReplySanich(message({ embeds: ['gifv', 'article'] }), embeds('gifv')), true)
})

test('не отвечает участнику без роли', () => {
    assert.equal(shouldReplySanich(message({ roles: ['123'] }), []), false)
})

test('не отвечает, если участник неизвестен', () => {
    assert.equal(shouldReplySanich(message({ roles: null }), []), false)
})

test('не отвечает ботам', () => {
    assert.equal(shouldReplySanich(message({ bot: true }), []), false)
})
