import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SANICH_ROLE_ID, shouldReplySanich, type SanichEmbed, type SanichMessage } from '../src/sanich.js'

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
