import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MAX_STORED_IDS, loadPostedIds, savePostedIds, stateFileExists } from '../src/state.js'

async function tempFile(name = 'devtracker.json'): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'alfebot-state-'))

    return join(dir, name)
}

test('отсутствующий файл читается как пустой список', async () => {
    const path = await tempFile()

    assert.equal(await stateFileExists(path), false)
    assert.deepEqual(await loadPostedIds(path), [])
})

test('запись и чтение возвращают те же ID', async () => {
    const path = await tempFile()

    await savePostedIds(path, ['1', '2', '3'])

    assert.equal(await stateFileExists(path), true)
    assert.deepEqual(await loadPostedIds(path), ['1', '2', '3'])
})

test('создаёт недостающий каталог', async () => {
    const path = join(await tempFile(), 'nested', 'deeper', 'state.json')

    await savePostedIds(path, ['1'])

    assert.deepEqual(await loadPostedIds(path), ['1'])
})

test('хранит только последние MAX_STORED_IDS', async () => {
    const path = await tempFile()
    const ids = Array.from({ length: MAX_STORED_IDS + 120 }, (_, index) => String(index))

    await savePostedIds(path, ids)

    const stored = await loadPostedIds(path)

    assert.equal(stored.length, MAX_STORED_IDS)
    assert.equal(stored[stored.length - 1], String(ids.length - 1))
    assert.equal(stored[0], String(ids.length - MAX_STORED_IDS))
})

test('битый JSON читается как пустой список', async () => {
    const path = await tempFile()

    await savePostedIds(path, ['1'])
    await writeFile(path, '{ это не json', 'utf8')

    assert.deepEqual(await loadPostedIds(path), [])
})

test('JSON не-массив читается как пустой список', async () => {
    const path = await tempFile()

    await savePostedIds(path, ['1'])
    await writeFile(path, '{"ids":["1"]}', 'utf8')

    assert.deepEqual(await loadPostedIds(path), [])
})

test('нестроковые элементы отфильтровываются', async () => {
    const path = await tempFile()

    await savePostedIds(path, ['1'])
    await writeFile(path, '["1", 2, null, "3"]', 'utf8')

    assert.deepEqual(await loadPostedIds(path), ['1', '3'])
})

test('после записи не остаётся временного файла', async () => {
    const path = await tempFile()

    await savePostedIds(path, ['1'])

    assert.equal(await stateFileExists(`${path}.tmp`), false)
})

test('файл записан как валидный JSON-массив', async () => {
    const path = await tempFile()

    await savePostedIds(path, ['1', '2'])

    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), ['1', '2'])
})
