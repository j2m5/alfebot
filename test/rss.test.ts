import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { extractCommentId, parseDevTrackerFeed } from '../src/rss.js'

const sample = readFileSync(fileURLToPath(new URL('./fixtures/devtracker-sample.xml', import.meta.url)), 'utf8')

test('извлекает ID комментария из ссылки', () => {
    assert.equal(
        extractCommentId('https://forums.swtor.com/topic/945205-x/?do=findComment&comment=9888802'),
        '9888802'
    )
})

test('без параметра comment ключом становится вся ссылка', () => {
    const link = 'https://forums.swtor.com/topic/900001-numeric/'

    assert.equal(extractCommentId(link), link)
})

test('парсит все записи ленты', () => {
    const items = parseDevTrackerFeed(sample)

    assert.equal(items.length, 4)
})

test('CDATA в ссылке не ломает парсинг и сохраняет &comment=', () => {
    const [first] = parseDevTrackerFeed(sample)

    assert.equal(first.link, 'https://forums.swtor.com/topic/945205-game-update-791-known-issues/?do=findComment&comment=9888802')
    assert.equal(first.id, '9888802')
})

test('декодирует HTML-сущности в тексте', () => {
    const items = parseDevTrackerFeed(sample)

    assert.match(items[0].text, /It's a short one\./)
    assert.match(items[1].text, /5 < 10 && that is fine\./)
    assert.ok(!items[0].text.includes('&#39;'))
    assert.ok(!items[1].text.includes('&amp;'))
})

test('восстанавливает абзацы из двойных пробелов', () => {
    const [first] = parseDevTrackerFeed(sample)

    assert.equal(
        first.text,
        "Hello everyone,\n\nAdding the following to the known issues list.\n\nIt's a short one."
    )
})

test('одинаковые заголовки тем получают разные ID', () => {
    const items = parseDevTrackerFeed(sample)

    assert.equal(items[1].title, items[2].title)
    assert.notEqual(items[1].id, items[2].id)
})

test('числовой заголовок и текст остаются строками', () => {
    const numeric = parseDevTrackerFeed(sample)[3]

    assert.equal(typeof numeric.title, 'string')
    assert.equal(numeric.title, '12345')
    assert.equal(typeof numeric.text, 'string')
    assert.equal(numeric.text, '12345')
})

test('разбирает pubDate в Date', () => {
    const [first] = parseDevTrackerFeed(sample)

    assert.equal(first.publishedAt.toISOString(), '2026-08-11T15:08:45.000Z')
})

test('битая дата не даёт Invalid Date', () => {
    const broken = parseDevTrackerFeed(sample)[3]

    assert.ok(!Number.isNaN(broken.publishedAt.getTime()))
})

test('лента с одной записью возвращает массив, а не объект', () => {
    const single = `<?xml version="1.0"?><rss version="2.0"><channel><title>Dev Tracker</title><item><title>Only one</title><link><![CDATA[https://forums.swtor.com/topic/1-x/?do=findComment&comment=42]]></link><description>Single item feed.</description><pubDate>Tue, 11 Aug 2026 15:08:45 +0000</pubDate></item></channel></rss>`

    const items = parseDevTrackerFeed(single)

    assert.equal(items.length, 1)
    assert.equal(items[0].id, '42')
})

test('пустая лента даёт пустой массив', () => {
    const empty = `<?xml version="1.0"?><rss version="2.0"><channel><title>Dev Tracker</title></channel></rss>`

    assert.deepEqual(parseDevTrackerFeed(empty), [])
})

test('записи без ссылки пропускаются', () => {
    const broken = `<?xml version="1.0"?><rss version="2.0"><channel><item><title>No link</title><description>text</description></item></channel></rss>`

    assert.deepEqual(parseDevTrackerFeed(broken), [])
})

test('записи с относительной (не абсолютной) ссылкой пропускаются', () => {
    const broken = `<?xml version="1.0"?><rss version="2.0"><channel><item><title>Relative link</title><link>/relative/path</link><description>text</description></item></channel></rss>`

    assert.deepEqual(parseDevTrackerFeed(broken), [])
})
