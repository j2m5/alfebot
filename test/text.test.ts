import { test } from 'node:test'
import assert from 'node:assert/strict'

import { splitText } from '../src/text.js'

test('короткий текст остаётся одним чанком', () => {
    assert.deepEqual(splitText('привет', 100), ['привет'])
})

test('пустая строка даёт пустой массив', () => {
    assert.deepEqual(splitText('', 100), [])
    assert.deepEqual(splitText('   \n  ', 100), [])
})

test('режет по границе абзаца, а не посреди слова', () => {
    const text = 'первый абзац\n\nвторой абзац'
    const chunks = splitText(text, 15)

    assert.deepEqual(chunks, ['первый абзац', 'второй абзац'])
})

test('режет по пробелу, когда абзацев нет', () => {
    const text = 'один два три четыре пять'
    const chunks = splitText(text, 10)

    for (const chunk of chunks) {
        assert.ok(chunk.length <= 10, `чанк длиннее лимита: ${JSON.stringify(chunk)}`)
    }

    assert.equal(chunks.join(' '), text)
})

test('режет длинный пост так, что каждый чанк влезает в лимит Discord', () => {
    const paragraph = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(20).trim()
    const text = Array.from({ length: 9 }, () => paragraph).join('\n\n')

    assert.ok(text.length > 9000, 'фикстура должна быть длиннее 9000 символов')

    const chunks = splitText(text, 4000)

    assert.ok(chunks.length > 2, 'ожидалось больше двух чанков')

    for (const chunk of chunks) {
        assert.ok(chunk.length <= 4000, `чанк длиннее 4000: ${chunk.length}`)
    }

    const normalise = (value: string) => value.replace(/\s+/g, ' ').trim()

    assert.equal(normalise(chunks.join('\n')), normalise(text))
})

test('слово длиннее лимита режется принудительно', () => {
    const chunks = splitText('a'.repeat(25), 10)

    assert.equal(chunks.length, 3)
    assert.ok(chunks.every((chunk) => chunk.length <= 10))
})
