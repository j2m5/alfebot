# SWTOR Dev Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Бот раз в 20 минут читает RSS-ленту Dev Tracker форума swtor.com и постит новые сообщения разработчиков в Discord-канал — оригинал плюс русский перевод от Ollama.

**Architecture:** Пять узких модулей: `text.ts` (разбиение строк), `rss.ts` (загрузка и парсинг ленты), `state.ts` (JSON-файл с ID опубликованного), `ollama.ts` (перевод), `devtracker.ts` (оркестрация и отправка в Discord). Вся сетевая и Discord-логика собрана в `devtracker.ts`, остальные модули — чистые функции, которые тестируются без сети.

**Tech Stack:** TypeScript (ESM, NodeNext), discord.js 14.27, fast-xml-parser 5, tsx, встроенный `node:test`.

**Спека:** `docs/superpowers/specs/2026-08-11-swtor-dev-tracker-rss-design.md`

## Global Constraints

- ESM-проект (`"type": "module"`): все относительные импорты пишутся **с расширением `.js`**, даже когда файл `.ts`. Пример: `import { splitText } from './text.js'`.
- `tsconfig.json` компилирует только `src` (`"include": ["src"]`). Каталог `test/` намеренно не попадает в `dist` и не проверяется `npm run build`.
- Тесты запускаются **только явным списком файлов**: `npx tsx --test test/a.test.ts test/b.test.ts`. Режим каталога (`--test test/`) падает с `ERR_UNSUPPORTED_DIR_IMPORT` — не использовать.
- Никаких новых зависимостей, кроме `fast-xml-parser` (Task 2).
- Все логи Dev Tracker пишутся с префиксом `[devtracker]`.
- Ни одна ошибка Dev Tracker не должна ронять процесс или ломать слэш-команду `/ask`.
- Комментарии в коде — только там, где решение неочевидно. Существующий код комментариев почти не имеет, стиль не меняем.
- Строки, видимые пользователю, — на русском (как в существующем коде).

---

## File Structure

| Файл | Статус | Ответственность |
|---|---|---|
| `src/text.ts` | создать (Task 1) | `splitText` — разбиение текста по границам абзацев/слов |
| `src/rss.ts` | создать (Task 2) | загрузка ленты, парсинг XML, тип `DevTrackerItem` |
| `src/state.ts` | создать (Task 3) | чтение/запись JSON со списком опубликованных ID |
| `src/ollama.ts` | изменить (Task 4) | + `translateToRussian`, общий `chatOllama` |
| `src/devtracker.ts` | создать (Task 5) | конфиг, выбор новых записей, сборка эмбедов, планировщик |
| `src/index.ts` | изменить (Task 1, Task 6) | убрать `splitText`, запустить Dev Tracker в `ClientReady` |
| `test/*.test.ts` | создать (Tasks 1–3, 5) | тесты чистых функций |
| `test/fixtures/devtracker-sample.xml` | создать (Task 2) | рукописная лента с граничными случаями |
| `.env.example`, `docker/docker-compose.yml`, `.gitignore`, `package.json` | изменить (Task 6, Task 2) | конфигурация и запуск |

---

### Task 1: Вынести `splitText` в отдельный модуль

Функция уже существует в `src/index.ts` и нужна в трёх местах: `/ask`, разбиение поста на эмбеды, разбиение текста перед отправкой в Ollama. Выносим её как есть, попутно убирая из неё чужую ответственность — фолбэк-строку «Модель не вернула текст.», которая относится только к `/ask`.

**Files:**
- Create: `src/text.ts`
- Create: `test/text.test.ts`
- Modify: `src/index.ts` (удалить функцию `splitText`, строки 59–81; добавить импорт; поправить `sendLongReply`)
- Modify: `package.json` (добавить скрипт `test`)

**Interfaces:**
- Consumes: ничего
- Produces: `splitText(text: string, maxLength?: number): string[]` — возвращает массив непустых чанков, каждый не длиннее `maxLength`. Для пустой/пробельной строки возвращает `[]`. Значение по умолчанию `maxLength = 1900`.

- [ ] **Step 1: Написать падающий тест**

Создать `test/text.test.ts`:

```ts
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
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npx tsx --test test/text.test.ts`
Expected: FAIL — `Cannot find module '.../src/text.js'`

- [ ] **Step 3: Создать `src/text.ts`**

```ts
export function splitText(text: string, maxLength = 1900): string[] {
    const chunks: string[] = []

    let remaining = text.trim()

    while (remaining.length > maxLength) {
        let index = remaining.lastIndexOf('\n', maxLength)

        if (index < 1) index = remaining.lastIndexOf(' ', maxLength)

        if (index < 1) index = maxLength

        chunks.push(remaining.slice(0, index).trim())

        remaining = remaining.slice(index).trim()
    }

    if (remaining) chunks.push(remaining)

    return chunks
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `npx tsx --test test/text.test.ts`
Expected: PASS, 6 тестов

- [ ] **Step 5: Убрать `splitText` из `src/index.ts`**

Добавить импорт после существующих импортов (строка 3):

```ts
import { splitText } from './text.js'
```

Удалить функцию `splitText` целиком (строки 59–81 включительно, от `function splitText(` до закрывающей скобки).

Заменить тело `sendLongReply` так, чтобы фолбэк-строка жила здесь, а не в `splitText`:

```ts
async function sendLongReply(
    interaction: {
        editReply(content: string): Promise<unknown>
        followUp(content: string): Promise<unknown>
    },

    text: string
): Promise<void> {
    const chunks = splitText(text)

    if (chunks.length === 0) chunks.push('Модель не вернула текст.')

    await interaction.editReply(chunks[0])

    for (const chunk of chunks.slice(1)) {
        await interaction.followUp(chunk)
    }
}
```

- [ ] **Step 6: Проверить, что проект собирается**

Run: `npm run build`
Expected: выходит без ошибок, в `dist/` появляется `text.js`

- [ ] **Step 7: Добавить скрипт `test` в `package.json`**

В секцию `"scripts"` добавить:

```json
"test": "tsx --test test/text.test.ts"
```

По мере появления новых тестовых файлов этот список расширяется вручную в каждой задаче — режим каталога у `tsx --test` не работает.

- [ ] **Step 8: Запустить и закоммитить**

Run: `npm test`
Expected: PASS, 6 тестов

```bash
git add src/text.ts src/index.ts test/text.test.ts package.json
git commit -m "refactor: вынести splitText в src/text.ts с тестами"
```

---

### Task 2: Загрузка и парсинг RSS-ленты

**Files:**
- Create: `src/rss.ts`
- Create: `test/rss.test.ts`
- Create: `test/fixtures/devtracker-sample.xml`
- Modify: `package.json` (зависимость `fast-xml-parser`, расширить скрипт `test`)

**Interfaces:**
- Consumes: ничего
- Produces:
  - `type DevTrackerItem = { id: string; title: string; link: string; text: string; publishedAt: Date }`
  - `extractCommentId(link: string): string`
  - `parseDevTrackerFeed(xml: string): DevTrackerItem[]` — порядок записей сохраняется как в ленте (от новых к старым)
  - `fetchDevTrackerFeed(url: string): Promise<DevTrackerItem[]>` — бросает `Error` при не-200

**Почему именно такие опции парсера** (проверено на живой ленте, не угадано):

| Опция | Зачем |
|---|---|
| `htmlEntities: true` | Без неё `&#39;`, `&nbsp;`, `&rsquo;` остаются сырыми в тексте. `&amp;`/`&lt;` декодируются и без неё. |
| `parseTagValue: false` | Иначе описание вида `12345` превратится в `number`, а не строку. |
| `isArray` на `rss.channel.item` | Лента с одной записью возвращает объект, а не массив. |
| `ignoreAttributes: true` | Атрибуты в этой ленте не нужны. |

- [ ] **Step 1: Установить зависимость**

Run: `npm install fast-xml-parser`
Expected: в `package.json` появляется `"fast-xml-parser": "^5.x"` в `dependencies` (не в `devDependencies` — модуль нужен в рантайме)

- [ ] **Step 2: Создать фикстуру**

Создать `test/fixtures/devtracker-sample.xml`. Это рукописная лента, а не снимок живой: она детерминирована и специально содержит все граничные случаи — CDATA в `link`, сущности `&amp;`/`&#39;`/`&lt;`, две записи с одинаковым заголовком темы но разными `comment=`, абзацы схлопнутые в двойные пробелы, ссылку без параметра `comment`, и запись с битой датой.

```xml
<?xml version="1.0"?>
<rss version="2.0"><channel><title>Dev Tracker</title><link>https://forums.swtor.com/discover/6/</link><description>SWTOR | Forums - Dev Tracker</description><language>en</language><item><title>Game Update 7.9.1 Known Issues</title><link><![CDATA[https://forums.swtor.com/topic/945205-game-update-791-known-issues/?do=findComment&comment=9888802]]></link><description>Hello everyone,  Adding the following to the known issues list.  It&#39;s a short one.</description><pubDate>Tue, 11 Aug 2026 15:08:45 +0000</pubDate></item><item><title>Issues with EA account link</title><link><![CDATA[https://forums.swtor.com/topic/945230-issues-with-ea-account-link/?do=findComment&comment=9888457]]></link><description>Second dev reply in the same topic. 5 &lt; 10 &amp;&amp; that is fine.</description><pubDate>Sat, 08 Aug 2026 21:57:34 +0000</pubDate></item><item><title>Issues with EA account link</title><link><![CDATA[https://forums.swtor.com/topic/945230-issues-with-ea-account-link/?do=findComment&comment=9888339]]></link><description>First dev reply in the same topic.</description><pubDate>Fri, 07 Aug 2026 16:27:39 +0000</pubDate></item><item><title>12345</title><link><![CDATA[https://forums.swtor.com/topic/900001-numeric/]]></link><description>12345</description><pubDate>not a real date</pubDate></item></channel></rss>
```

- [ ] **Step 3: Написать падающий тест**

Создать `test/rss.test.ts`:

```ts
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
```

- [ ] **Step 4: Запустить тест и убедиться, что он падает**

Run: `npx tsx --test test/rss.test.ts`
Expected: FAIL — `Cannot find module '.../src/rss.js'`

- [ ] **Step 5: Создать `src/rss.ts`**

```ts
import { XMLParser } from 'fast-xml-parser'

export type DevTrackerItem = {
    id: string
    title: string
    link: string
    text: string
    publishedAt: Date
}

type RawItem = {
    title?: unknown
    link?: unknown
    description?: unknown
    pubDate?: unknown
}

type RawFeed = {
    rss?: {
        channel?: {
            item?: RawItem[]
        }
    }
}

const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    htmlEntities: true,
    trimValues: true,
    isArray: (_name, jpath) => jpath === 'rss.channel.item'
})

export function extractCommentId(link: string): string {
    const match = link.match(/[?&]comment=(\d+)/)

    return match ? match[1] : link
}

export function parseDevTrackerFeed(xml: string): DevTrackerItem[] {
    const feed = parser.parse(xml) as RawFeed
    const rawItems = feed.rss?.channel?.item ?? []

    const items: DevTrackerItem[] = []

    for (const raw of rawItems) {
        const link = String(raw.link ?? '').trim()

        if (!link) continue

        const publishedAt = new Date(String(raw.pubDate ?? ''))

        items.push({
            id: extractCommentId(link),
            title: String(raw.title ?? '').trim() || 'SWTOR Dev Tracker',
            link,
            text: restoreParagraphs(String(raw.description ?? '')),
            publishedAt: Number.isNaN(publishedAt.getTime()) ? new Date() : publishedAt
        })
    }

    return items
}

export async function fetchDevTrackerFeed(url: string): Promise<DevTrackerItem[]> {
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'alfebot/1.0 (+https://github.com/)',
            'Accept': 'application/rss+xml, application/xml, text/xml'
        },
        signal: AbortSignal.timeout(30_000)
    })

    if (!response.ok) {
        throw new Error(`Лента вернула ${response.status} ${response.statusText}`)
    }

    return parseDevTrackerFeed(await response.text())
}

// В ленте переводы строк отсутствуют: форум схлопывает абзацы в подряд идущие пробелы.
function restoreParagraphs(text: string): string {
    return text.replace(/ {2,}/g, '\n\n').trim()
}
```

- [ ] **Step 6: Запустить тест и убедиться, что он проходит**

Run: `npx tsx --test test/rss.test.ts`
Expected: PASS, 13 тестов

- [ ] **Step 7: Проверить на живой ленте**

Run: `npx tsx -e "import('./src/rss.ts').then(async (m) => { const items = await m.fetchDevTrackerFeed('https://forums.swtor.com/discover/6.xml'); console.log(items.length, 'записей'); console.log(items[0]) })"`
Expected: печатает ~25 записей и первую запись со всеми полями, `publishedAt` — валидная дата

- [ ] **Step 8: Расширить скрипт `test` и закоммитить**

В `package.json`:

```json
"test": "tsx --test test/text.test.ts test/rss.test.ts"
```

Run: `npm test`
Expected: PASS, 19 тестов

```bash
git add src/rss.ts test/rss.test.ts test/fixtures/devtracker-sample.xml package.json package-lock.json
git commit -m "feat: парсинг RSS-ленты Dev Tracker"
```

---

### Task 3: Хранение опубликованных ID

**Files:**
- Create: `src/state.ts`
- Create: `test/state.test.ts`
- Modify: `package.json` (расширить скрипт `test`)

**Interfaces:**
- Consumes: ничего
- Produces:
  - `stateFileExists(filePath: string): Promise<boolean>`
  - `loadPostedIds(filePath: string): Promise<string[]>` — отсутствующий или битый файл читается как `[]`
  - `savePostedIds(filePath: string, ids: string[]): Promise<void>` — создаёт каталог, пишет атомарно, хранит последние 500 ID
  - `MAX_STORED_IDS = 500`

Существование файла проверяется отдельной функцией, потому что `loadPostedIds` возвращает `[]` и для отсутствующего файла, и для пустого списка — а отличить их нужно: отсутствие файла означает первый запуск.

Битый JSON намеренно читается как `[]`, а не бросает исключение: иначе бот навсегда застрянет на ошибке. Ущерб ограничен предохранителем в 10 постов за тик из Task 5.

- [ ] **Step 1: Написать падающий тест**

Создать `test/state.test.ts`:

```ts
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
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npx tsx --test test/state.test.ts`
Expected: FAIL — `Cannot find module '.../src/state.js'`

- [ ] **Step 3: Создать `src/state.ts`**

```ts
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const MAX_STORED_IDS = 500

export async function stateFileExists(filePath: string): Promise<boolean> {
    try {
        await access(filePath)

        return true
    } catch {
        return false
    }
}

export async function loadPostedIds(filePath: string): Promise<string[]> {
    let raw: string

    try {
        raw = await readFile(filePath, 'utf8')
    } catch {
        return []
    }

    try {
        const parsed = JSON.parse(raw) as unknown

        if (!Array.isArray(parsed)) {
            console.warn('[devtracker] файл состояния не является массивом, начинаю с пустого списка')

            return []
        }

        return parsed.filter((id): id is string => typeof id === 'string')
    } catch {
        console.warn('[devtracker] файл состояния повреждён, начинаю с пустого списка')

        return []
    }
}

export async function savePostedIds(filePath: string, ids: string[]): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true })

    const tempPath = `${filePath}.tmp`

    await writeFile(tempPath, JSON.stringify(ids.slice(-MAX_STORED_IDS)), 'utf8')
    await rename(tempPath, filePath)
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `npx tsx --test test/state.test.ts`
Expected: PASS, 9 тестов

- [ ] **Step 5: Расширить скрипт `test` и закоммитить**

В `package.json`:

```json
"test": "tsx --test test/text.test.ts test/rss.test.ts test/state.test.ts"
```

Run: `npm test`
Expected: PASS, 28 тестов

```bash
git add src/state.ts test/state.test.ts package.json
git commit -m "feat: хранение опубликованных ID Dev Tracker"
```

---

### Task 4: Перевод через Ollama

**Files:**
- Modify: `src/ollama.ts` (полностью переписать: выделить `chatOllama`, добавить `translateToRussian`)

**Interfaces:**
- Consumes: `splitText` из `src/text.js` (Task 1)
- Produces: `translateToRussian(text: string): Promise<string>` — бросает `Error`, если хотя бы одна порция не перевелась. `askOllama(prompt: string): Promise<string>` сохраняет прежнюю сигнатуру и поведение.

Автоматических тестов у этой задачи нет: обе функции — это HTTP-вызов к внешнему сервису, мокать который здесь смысла нет. Логика разбиения на порции уже покрыта тестами `splitText` из Task 1. Проверка — ручная, шагом 3.

**Почему порции по 3000 символов:** контекст Ollama по умолчанию 4096 токенов. Пост на 9.5к символов модель молча обрежет, и перевод потеряет хвост без единой ошибки. Порции плюс явный `num_ctx: 8192` это исключают.

- [ ] **Step 1: Переписать `src/ollama.ts`**

```ts
import { splitText } from './text.js'

type OllamaChatResponse = {
    message: {
        role: 'assistant',
        content: string
    }
}

type OllamaMessage = {
    role: 'system' | 'user'
    content: string
}

const TRANSLATION_CHUNK_SIZE = 3000

const TRANSLATION_SYSTEM_PROMPT = [
    'Ты профессиональный переводчик. Переводи текст с английского на русский.',
    'Сохраняй разбиение на абзацы.',
    'Не переводи имена собственные и игровые термины Star Wars: The Old Republic:',
    'названия классов, дисциплин, планет, способностей и предметов оставляй как в оригинале.',
    'Ничего не добавляй от себя, не комментируй и не сокращай.',
    'В ответе верни только перевод.'
].join(' ')

async function chatOllama(messages: OllamaMessage[], timeoutMs: number, numCtx?: number): Promise<string> {
    const baseUrl = process.env.OLLAMA_URL
    const model = process.env.OLLAMA_MODEL

    const response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            messages,
            stream: false,
            ...(numCtx ? { options: { num_ctx: numCtx } } : {})
        }),
        signal: AbortSignal.timeout(timeoutMs)
    })

    if (!response.ok) {
        const errorText = await response.text()

        throw new Error(errorText)
    }

    const data = await response.json() as OllamaChatResponse

    return data.message.content.trim()
}

export async function askOllama(prompt: string): Promise<string> {
    return chatOllama([
        {
            role: 'system',
            content: 'Ты полезный ассистент в Discord. Отвечай по русски. Отвечай понятно и без лишней воды. ' + process.env.OLLAMA_SYSTEM_PROMPT_SECRET_PART,
        },
        {
            role: 'user',
            content: prompt
        }
    ], 120_000)
}

export async function translateToRussian(text: string): Promise<string> {
    const parts = splitText(text, TRANSLATION_CHUNK_SIZE)

    const translated: string[] = []

    for (const part of parts) {
        translated.push(await chatOllama([
            {
                role: 'system',
                content: TRANSLATION_SYSTEM_PROMPT
            },
            {
                role: 'user',
                content: part
            }
        ], 240_000, 8192))
    }

    return translated.join('\n\n')
}
```

- [ ] **Step 2: Проверить, что проект собирается**

Run: `npm run build`
Expected: выходит без ошибок

- [ ] **Step 3: Проверить перевод вручную**

Требуется поднятая Ollama и заполненные `OLLAMA_URL` / `OLLAMA_MODEL` в `.env`.

Run:
```bash
npx tsx -e "import('dotenv/config').then(() => import('./src/ollama.ts')).then(async (m) => { console.log(await m.translateToRussian('Hello everyone,\n\nAdding the following to the known issues list.')) })"
```
Expected: осмысленный русский перевод, без английского текста и без комментариев модели

- [ ] **Step 4: Закоммитить**

```bash
git add src/ollama.ts
git commit -m "feat: перевод текста на русский через Ollama"
```

---

### Task 5: Оркестрация Dev Tracker

**Files:**
- Create: `src/devtracker.ts`
- Create: `test/devtracker.test.ts`
- Modify: `package.json` (расширить скрипт `test`)

**Interfaces:**
- Consumes: `DevTrackerItem`, `fetchDevTrackerFeed` из `src/rss.js`; `loadPostedIds`, `savePostedIds`, `stateFileExists` из `src/state.js`; `translateToRussian` из `src/ollama.js`; `splitText` из `src/text.js`
- Produces:
  - `type DevTrackerConfig = { channelId: string; feedUrl: string; stateFile: string; intervalMs: number; seedPostCount: number }`
  - `readConfig(env: NodeJS.ProcessEnv): DevTrackerConfig | null` — `null`, если не задан `DEV_TRACKER_CHANNEL_ID`
  - `selectNewItems(items: DevTrackerItem[], postedIds: Set<string>, limit: number, prefer: 'oldest' | 'newest'): DevTrackerItem[]` — всегда возвращает в хронологическом порядке (от старых к новым)
  - `buildEmbeds(item: DevTrackerItem, translation: string | null): EmbedBuilder[]`
  - `startDevTracker(client: Client): Promise<void>`
  - `MAX_POSTS_PER_TICK = 10`

**Осторожно с `slice(-limit)`:** при `limit === 0` выражение `array.slice(-0)` эквивалентно `array.slice(0)` и вернёт **весь массив**. Поэтому проверка `limit <= 0` стоит первой, до любых `slice`. Это ровно тот случай, который срабатывает при `DEV_TRACKER_SEED_POST_COUNT=0` — то есть в конфигурации по умолчанию, и без проверки бот залил бы канал всей лентой при первом запуске.

- [ ] **Step 1: Написать падающий тест**

Создать `test/devtracker.test.ts`:

```ts
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
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npx tsx --test test/devtracker.test.ts`
Expected: FAIL — `Cannot find module '.../src/devtracker.js'`

- [ ] **Step 3: Создать `src/devtracker.ts`**

```ts
import { Client, EmbedBuilder, type SendableChannels } from 'discord.js'

import { translateToRussian } from './ollama.js'
import { fetchDevTrackerFeed, type DevTrackerItem } from './rss.js'
import { loadPostedIds, savePostedIds, stateFileExists } from './state.js'
import { splitText } from './text.js'

export type DevTrackerConfig = {
    channelId: string
    feedUrl: string
    stateFile: string
    intervalMs: number
    seedPostCount: number
}

export const MAX_POSTS_PER_TICK = 10

const DEFAULT_FEED_URL = 'https://forums.swtor.com/discover/6.xml'
const DEFAULT_STATE_FILE = './data/devtracker.json'
const DEFAULT_INTERVAL_MINUTES = 20

const EMBED_COLOR = 0xE6B800
const EMBED_TITLE_LIMIT = 256
const EMBED_CHUNK_SIZE = 4000
const TRANSLATION_HEADER = '🇷🇺 **Перевод**\n\n'
const SEND_DELAY_MS = 1000

export function readConfig(env: NodeJS.ProcessEnv): DevTrackerConfig | null {
    const channelId = env.DEV_TRACKER_CHANNEL_ID?.trim()

    if (!channelId) return null

    return {
        channelId,
        feedUrl: env.DEV_TRACKER_FEED_URL?.trim() || DEFAULT_FEED_URL,
        stateFile: env.DEV_TRACKER_STATE_FILE?.trim() || DEFAULT_STATE_FILE,
        intervalMs: positiveNumber(env.DEV_TRACKER_INTERVAL_MINUTES, DEFAULT_INTERVAL_MINUTES) * 60_000,
        seedPostCount: positiveNumber(env.DEV_TRACKER_SEED_POST_COUNT, 0)
    }
}

export function selectNewItems(
    items: DevTrackerItem[],
    postedIds: Set<string>,
    limit: number,
    prefer: 'oldest' | 'newest'
): DevTrackerItem[] {
    // slice(-0) вернул бы весь массив, поэтому выходим до любых slice.
    if (limit <= 0) return []

    const fresh = items
        .filter((entry) => !postedIds.has(entry.id))
        .sort((left, right) => left.publishedAt.getTime() - right.publishedAt.getTime())

    return prefer === 'newest' ? fresh.slice(-limit) : fresh.slice(0, limit)
}

export function buildEmbeds(item: DevTrackerItem, translation: string | null): EmbedBuilder[] {
    const blocks = splitText(item.text, EMBED_CHUNK_SIZE)

    if (blocks.length === 0) blocks.push('_пустое сообщение_')

    const translatedBlocks = translation ? splitText(translation, EMBED_CHUNK_SIZE) : []

    if (translatedBlocks.length > 0) {
        translatedBlocks[0] = TRANSLATION_HEADER + translatedBlocks[0]
        blocks.push(...translatedBlocks)
    } else {
        blocks.push('_перевод недоступен_')
    }

    return blocks.map((block, index) => {
        const embed = new EmbedBuilder()
            .setColor(EMBED_COLOR)
            .setDescription(block)

        if (index === 0) {
            embed.setTitle(item.title.slice(0, EMBED_TITLE_LIMIT)).setURL(item.link)
        }

        if (index === blocks.length - 1) {
            embed.setFooter({ text: 'SWTOR Dev Tracker' }).setTimestamp(item.publishedAt)
        }

        return embed
    })
}

export async function startDevTracker(client: Client): Promise<void> {
    const config = readConfig(process.env)

    if (!config) {
        console.warn('[devtracker] DEV_TRACKER_CHANNEL_ID не задан, лента отключена')

        return
    }

    const channel = await client.channels.fetch(config.channelId).catch(() => null)

    if (!channel?.isSendable()) {
        console.error(`[devtracker] канал ${config.channelId} не найден или в него нельзя писать, лента отключена`)

        return
    }

    const postedIds = new Set(await loadPostedIds(config.stateFile))

    let isFirstRun = !(await stateFileExists(config.stateFile))
    let isRunning = false

    const tick = async (): Promise<void> => {
        if (isRunning) {
            console.warn('[devtracker] предыдущая проверка ещё идёт, пропускаю')

            return
        }

        isRunning = true

        try {
            await runTick(channel, config, postedIds, isFirstRun)

            isFirstRun = false
        } catch (error) {
            console.error('[devtracker] проверка не удалась:', error)
        } finally {
            isRunning = false
        }
    }

    console.log(`[devtracker] запущен, канал ${config.channelId}, интервал ${config.intervalMs / 60_000} мин`)

    await tick()

    setInterval(() => void tick(), config.intervalMs)
}

async function runTick(
    channel: SendableChannels,
    config: DevTrackerConfig,
    postedIds: Set<string>,
    isFirstRun: boolean
): Promise<void> {
    const items = await fetchDevTrackerFeed(config.feedUrl)

    if (items.length === 0) {
        console.warn('[devtracker] лента пуста')

        return
    }

    const toPost = isFirstRun
        ? selectNewItems(items, postedIds, config.seedPostCount, 'newest')
        : selectNewItems(items, postedIds, MAX_POSTS_PER_TICK, 'oldest')

    if (isFirstRun) {
        const selectedIds = new Set(toPost.map((entry) => entry.id))

        for (const entry of items) {
            if (!selectedIds.has(entry.id)) postedIds.add(entry.id)
        }

        await savePostedIds(config.stateFile, [...postedIds])

        console.log(`[devtracker] первый запуск: помечено виденными ${items.length - toPost.length}, публикую ${toPost.length}`)
    }

    for (const item of toPost) {
        let translation: string | null = null

        try {
            translation = await translateToRussian(item.text)
        } catch (error) {
            console.error(`[devtracker] перевод не удался для ${item.id}:`, error)
        }

        const embeds = buildEmbeds(item, translation)

        for (const [index, embed] of embeds.entries()) {
            await channel.send({ embeds: [embed] })

            if (index < embeds.length - 1) await delay(SEND_DELAY_MS)
        }

        postedIds.add(item.id)

        await savePostedIds(config.stateFile, [...postedIds])

        console.log(`[devtracker] опубликовано ${item.id}: ${item.title}`)

        await delay(SEND_DELAY_MS)
    }
}

function positiveNumber(raw: string | undefined, fallback: number): number {
    const value = Number(raw)

    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `npx tsx --test test/devtracker.test.ts`
Expected: PASS, 17 тестов

- [ ] **Step 5: Проверить сборку**

Run: `npm run build`
Expected: выходит без ошибок

- [ ] **Step 6: Расширить скрипт `test` и закоммитить**

В `package.json`:

```json
"test": "tsx --test test/text.test.ts test/rss.test.ts test/state.test.ts test/devtracker.test.ts"
```

Run: `npm test`
Expected: PASS, 45 тестов

```bash
git add src/devtracker.ts test/devtracker.test.ts package.json
git commit -m "feat: оркестрация публикации Dev Tracker в Discord"
```

---

### Task 6: Подключение, конфигурация и ручная проверка

**Files:**
- Modify: `src/index.ts` (запуск Dev Tracker в `ClientReady`)
- Modify: `.env.example`
- Modify: `.gitignore`
- Modify: `docker/docker-compose.yml`

**Interfaces:**
- Consumes: `startDevTracker(client: Client): Promise<void>` из `src/devtracker.js` (Task 5)
- Produces: ничего

- [ ] **Step 1: Подключить Dev Tracker в `src/index.ts`**

Добавить импорт рядом с остальными:

```ts
import { startDevTracker } from './devtracker.js'
```

Заменить обработчик `ClientReady`:

```ts
client.once(Events.ClientReady, () => {
    console.log('Starting...')

    void startDevTracker(client)
})
```

`void` здесь намеренно: `startDevTracker` сам ловит свои ошибки и не должен блокировать готовность бота. Обработчик остаётся синхронным.

- [ ] **Step 2: Обновить `.env.example`**

Дописать в конец файла:

```
DEV_TRACKER_CHANNEL_ID=
DEV_TRACKER_INTERVAL_MINUTES=20
DEV_TRACKER_FEED_URL=https://forums.swtor.com/discover/6.xml
DEV_TRACKER_STATE_FILE=./data/devtracker.json
DEV_TRACKER_SEED_POST_COUNT=0
```

- [ ] **Step 3: Добавить каталог состояния в `.gitignore`**

Дописать в конец файла:

```
/data
```

- [ ] **Step 4: Исключить тесты и документацию из Docker-образа**

В `.dockerignore` дописать в конец (каталоги `test` и `docs` в рантайме не нужны, `tsconfig.json` их не компилирует):

```
test
docs
```

- [ ] **Step 5: Добавить volume в `docker/docker-compose.yml`**

Файл целиком после правки:

```yaml
services:
  alfebot:
    build:
      context: ..
      dockerfile: docker/Dockerfile

    container_name: alfebot

    restart: unless-stopped

    env_file:
      - ../.env

    volumes:
      - alfebot-data:/app/data

    extra_hosts:
      - "host.docker.internal:host-gateway"

    deploy:
      resources:
        limits:
          memory: 512M

volumes:
  alfebot-data:
```

Без named volume состояние жило бы внутри контейнера и терялось при каждом пересоздании — бот заливал бы канал повторно.

- [ ] **Step 6: Убедиться, что всё собирается и тесты проходят**

Run: `npm run build && npm test`
Expected: сборка без ошибок, PASS 45 тестов

- [ ] **Step 7: Ручная проверка на тестовом канале**

1. Создать в Discord тестовый канал, скопировать его ID (включив режим разработчика в настройках Discord).
2. Убедиться, что у бота есть права **View Channel**, **Send Messages** и **Embed Links** в этом канале.
3. В `.env` прописать `DEV_TRACKER_CHANNEL_ID=<id>` и `DEV_TRACKER_SEED_POST_COUNT=3`.
4. Убедиться, что файла `./data/devtracker.json` нет (`rm -f data/devtracker.json`).
5. Run: `npm run dev`

Expected:
- В логе `[devtracker] запущен, канал <id>, интервал 20 мин`
- В логе `[devtracker] первый запуск: помечено виденными 22, публикую 3`
- В канал приходят 3 самые свежие записи, от старой к новой
- У первого эмбеда каждой записи кликабельный заголовок, ведущий на пост форума
- Ниже оригинала идёт блок «🇷🇺 **Перевод**» с русским текстом
- У последнего эмбеда каждой записи футер «SWTOR Dev Tracker» и дата поста
- Появился файл `data/devtracker.json` с 25 ID

6. Перезапустить `npm run dev` и убедиться, что **ничего не публикуется повторно** и в логе нет строки про первый запуск.
7. Проверить фолбэк перевода: остановить Ollama (или поставить `OLLAMA_URL` на несуществующий адрес), удалить `data/devtracker.json`, запустить снова. Ожидается: записи публикуются с пометкой `_перевод недоступен_`, в логе есть `[devtracker] перевод не удался`, бот не падает.
8. Проверить, что `/ask` продолжает работать при выключенной ленте: убрать `DEV_TRACKER_CHANNEL_ID` из `.env`, запустить, увидеть в логе `[devtracker] DEV_TRACKER_CHANNEL_ID не задан, лента отключена`, выполнить `/ask` в Discord и получить ответ.
9. Вернуть `DEV_TRACKER_SEED_POST_COUNT=0` в `.env`.

- [ ] **Step 8: Закоммитить**

```bash
git add src/index.ts .env.example .gitignore .dockerignore docker/docker-compose.yml
git commit -m "feat: подключить Dev Tracker к боту и настроить хранение состояния"
```

---

## Проверка после всех задач

- [ ] `npm test` — 45 тестов проходят
- [ ] `npm run build` — без ошибок
- [ ] `docker compose -f docker/docker-compose.yml up --build` — бот стартует, в логе строка `[devtracker] запущен`
- [ ] `docker compose -f docker/docker-compose.yml restart` — после перезапуска повторных публикаций нет
