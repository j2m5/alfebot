import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { DevTrackerItem } from '../src/rss.js'
import { MAX_POSTS_PER_TICK, buildEmbeds, readConfig, selectNewItems } from '../src/devtracker.js'

function item(id: string, minutesAgo: number, overrides: Partial<DevTrackerItem> = {}): DevTrackerItem {
    return {
        id,
        title: `Тема ${id}`,
        link: `https://forums.swtor.com/topic/1-x/?do=findComment&comment=${id}`,
        text: `Текст ${id}`,
        publishedAt: new Date(Date.UTC(2026, 7, 11, 12, 0, 0) - minutesAgo * 60_000),
        ...overrides
    }
}

// Порядок как в живой ленте: от новых к старым.
const feed = [item('5', 0), item('4', 10), item('3', 20), item('2', 30), item('1', 40)]

test('readConfig возвращает null без DEV_TRACKER_CHANNEL_ID', () => {
    assert.equal(readConfig({}), null)
    assert.equal(readConfig({ DEV_TRACKER_CHANNEL_ID: '   ' }), null)
})

test('readConfig подставляет значения по умолчанию', () => {
    const config = readConfig({ DEV_TRACKER_CHANNEL_ID: '123' })

    assert.equal(config?.channelId, '123')
    assert.equal(config?.feedUrl, 'https://forums.swtor.com/discover/6.xml')
    assert.equal(config?.stateFile, './data/devtracker.json')
    assert.equal(config?.intervalMs, 20 * 60_000)
    assert.equal(config?.seedPostCount, 0)
})

test('readConfig читает заданные значения', () => {
    const config = readConfig({
        DEV_TRACKER_CHANNEL_ID: '123',
        DEV_TRACKER_INTERVAL_MINUTES: '45',
        DEV_TRACKER_FEED_URL: 'https://example.test/feed.xml',
        DEV_TRACKER_STATE_FILE: '/data/x.json',
        DEV_TRACKER_SEED_POST_COUNT: '3'
    })

    assert.equal(config?.intervalMs, 45 * 60_000)
    assert.equal(config?.feedUrl, 'https://example.test/feed.xml')
    assert.equal(config?.stateFile, '/data/x.json')
    assert.equal(config?.seedPostCount, 3)
})

test('readConfig игнорирует мусорные числа', () => {
    const config = readConfig({
        DEV_TRACKER_CHANNEL_ID: '123',
        DEV_TRACKER_INTERVAL_MINUTES: 'что-то',
        DEV_TRACKER_SEED_POST_COUNT: '-5'
    })

    assert.equal(config?.intervalMs, 20 * 60_000)
    assert.equal(config?.seedPostCount, 0)
})

test('selectNewItems отбрасывает уже опубликованные', () => {
    const selected = selectNewItems(feed, new Set(['1', '2', '3']), MAX_POSTS_PER_TICK, 'oldest')

    assert.deepEqual(selected.map((entry) => entry.id), ['4', '5'])
})

test('selectNewItems возвращает записи в хронологическом порядке', () => {
    const selected = selectNewItems(feed, new Set(), MAX_POSTS_PER_TICK, 'oldest')

    assert.deepEqual(selected.map((entry) => entry.id), ['1', '2', '3', '4', '5'])
})

test('selectNewItems соблюдает предохранитель и берёт самые старые', () => {
    const selected = selectNewItems(feed, new Set(), 2, 'oldest')

    assert.deepEqual(selected.map((entry) => entry.id), ['1', '2'])
})

test('selectNewItems с prefer=newest берёт самые свежие, но отдаёт по хронологии', () => {
    const selected = selectNewItems(feed, new Set(), 3, 'newest')

    assert.deepEqual(selected.map((entry) => entry.id), ['3', '4', '5'])
})

test('selectNewItems с limit=0 возвращает пустой массив', () => {
    assert.deepEqual(selectNewItems(feed, new Set(), 0, 'newest'), [])
    assert.deepEqual(selectNewItems(feed, new Set(), 0, 'oldest'), [])
})

test('selectNewItems на пустой ленте возвращает пустой массив', () => {
    assert.deepEqual(selectNewItems([], new Set(), 10, 'oldest'), [])
})

test('buildEmbeds: короткий пост с переводом даёт два эмбеда', () => {
    const embeds = buildEmbeds(item('1', 0), 'Перевод текста').map((embed) => embed.toJSON())

    assert.equal(embeds.length, 2)
    assert.equal(embeds[0].title, 'Тема 1')
    assert.equal(embeds[0].url, 'https://forums.swtor.com/topic/1-x/?do=findComment&comment=1')
    assert.equal(embeds[0].description, 'Текст 1')
    assert.match(embeds[1].description ?? '', /Перевод текста/)
})

test('buildEmbeds: title и url только на первом эмбеде, footer только на последнем', () => {
    const embeds = buildEmbeds(item('1', 0), 'Перевод текста').map((embed) => embed.toJSON())

    assert.equal(embeds[1].title, undefined)
    assert.equal(embeds[1].url, undefined)
    assert.equal(embeds[0].footer, undefined)
    assert.equal(embeds[embeds.length - 1].footer?.text, 'SWTOR Dev Tracker')
    assert.equal(embeds[embeds.length - 1].timestamp, item('1', 0).publishedAt.toISOString())
})

test('buildEmbeds: длинный пост режется, каждый эмбед влезает в лимит Discord', () => {
    const long = Array.from({ length: 9 }, () =>
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(20).trim()
    ).join('\n\n')

    const embeds = buildEmbeds(item('1', 0, { text: long }), long).map((embed) => embed.toJSON())

    assert.ok(embeds.length > 4, `ожидалось больше четырёх эмбедов, получено ${embeds.length}`)

    for (const embed of embeds) {
        assert.ok((embed.description ?? '').length <= 4096, `описание длиннее 4096: ${(embed.description ?? '').length}`)
    }
})

test('buildEmbeds без перевода добавляет пометку', () => {
    const embeds = buildEmbeds(item('1', 0), null).map((embed) => embed.toJSON())

    assert.equal(embeds.length, 2)
    assert.equal(embeds[1].description, '_перевод недоступен_')
})

test('buildEmbeds не падает на пустом тексте поста', () => {
    const embeds = buildEmbeds(item('1', 0, { text: '' }), null).map((embed) => embed.toJSON())

    assert.ok((embeds[0].description ?? '').length > 0)
})

test('buildEmbeds обрезает заголовок до лимита Discord', () => {
    const embeds = buildEmbeds(item('1', 0, { title: 'я'.repeat(400) }), null).map((embed) => embed.toJSON())

    assert.equal(embeds[0].title?.length, 256)
})

test('buildEmbeds игнорирует пробельный перевод', () => {
    const embeds = buildEmbeds(item('1', 0), '   \n  ').map((embed) => embed.toJSON())

    assert.equal(embeds[1].description, '_перевод недоступен_')
})
