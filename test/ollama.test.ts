import { test } from 'node:test'
import assert from 'node:assert/strict'
import { askOllama, translateToRussian } from '../src/ollama.js'

const emojis = [
    { id: '111111111111111111', name: 'sanich', animated: false },
    { id: '222222222222222222', name: 'dance', animated: true }
]

test('ask отключает рассуждения, ограничивает генерацию и собирает поток без thinking', async (t) => {
    let body: any
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        body = JSON.parse(String(options.body))
        const bytes = new TextEncoder().encode([
            JSON.stringify({ message: { thinking: 'Скрытые рассуждения', content: 'Привет ' }, done: false }),
            JSON.stringify({ message: { content: ':sanich:' }, done: true, done_reason: 'stop' })
        ].join('\n'))
        return new Response(new ReadableStream({ start(controller) {
            for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7))
            controller.close()
        } }))
    })
    assert.equal(await askOllama('Привет', emojis), 'Привет <:sanich:111111111111111111>')
    assert.equal(body.stream, true)
    assert.equal(body.think, false)
    assert.ok(body.options.num_predict > 0 && body.options.num_predict <= 650)
})

test('при истечении срока ask возвращает уже полученный текст, не продолжая ждать', async (t) => {
    const deadline = new AbortController()
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        assert.equal(options.signal, deadline.signal)
        return new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ message: { content: 'Уже готовый ответ.' }, done: false }) + '\n'))
            options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true })
            setTimeout(() => deadline.abort(new DOMException('Deadline', 'TimeoutError')), 10)
        }
        }))
    })
    assert.equal(await askOllama('Вопрос', [], deadline.signal), 'Уже готовый ответ.\n\n…')
})

test('таймаут без текста отличим от обычной ошибки модели', async (t) => {
    const deadline = new AbortController()
    deadline.abort(new DOMException('Deadline', 'TimeoutError'))
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        options.signal.throwIfAborted()
        return Response.json({ message: { content: 'Не должно выполняться' } })
    })
    await assert.rejects(askOllama('Вопрос', [], deadline.signal), { name: 'TimeoutError' })
})

test('лимит токенов помечает сокращение и удаляет оборванный код эмодзи', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({
        message: { content: 'Готовая мысль. <:sanich:111' }, done: true, done_reason: 'length'
    }))
    assert.equal(await askOllama('Вопрос', emojis), 'Готовая мысль.\n\n…')
})

test('ошибка внутри потока не превращается в успешный неполный ответ', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response([
        JSON.stringify({ message: { content: 'Начало' }, done: false }),
        JSON.stringify({ error: 'upstream unavailable' })
    ].join('\n')))
    await assert.rejects(askOllama('Вопрос'), /upstream unavailable/)
})

test('ask передаёт эмодзи сервера и исправляет сокращения, анимацию и выдуманный ID', async (t) => {
    let system = ''
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        const body = JSON.parse(String(options.body))
        system = body.messages[0].content
        return Response.json({ message: { role: 'assistant', content:
            'Привет :sanich: <a:sanich:999999999999999999> <:dance:222222222222222222> <:alien:333333333333333333>' } })
    })
    const answer = await askOllama('Привет', emojis)
    assert.ok(system.includes('<:sanich:111111111111111111>'))
    assert.ok(system.includes('<a:dance:222222222222222222>'))
    assert.equal(answer.trim(), 'Привет <:sanich:111111111111111111> <:sanich:111111111111111111> <a:dance:222222222222222222>')
})

test('списки эмодзи из разных запросов изолированы, личка не получает чужие эмодзи', async (t) => {
    const systems: string[] = []
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        systems.push(JSON.parse(String(options.body)).messages[0].content)
        return Response.json({ message: { role: 'assistant', content: '<:sanich:111111111111111111> ответ' } })
    })
    await askOllama('Первый сервер', emojis)
    const other = await askOllama('Второй сервер', [{ id: '444444444444444444', name: 'other', animated: false }])
    const dm = await askOllama('Личка')
    assert.ok(systems[1].includes('<:other:444444444444444444>'))
    assert.ok(!systems[1].includes('111111111111111111'))
    assert.ok(!systems[2].includes('111111111111111111'))
    assert.equal(other.trim(), 'ответ')
    assert.equal(dm.trim(), 'ответ')
})

test('разметка в примерах кода не изменяется', async (t) => {
    const content = '`<:example:999999999999999999>`\n```text\n:sanich:\n```\n:sanich:'
    t.mock.method(globalThis, 'fetch', async () => Response.json({ message: { role: 'assistant', content } }))
    assert.equal(await askOllama('Пример', emojis), '`<:example:999999999999999999>`\n```text\n:sanich:\n```\n<:sanich:111111111111111111>')
})

test('переводчик не получает каталог эмодзи и не заменяет содержимое перевода', async (t) => {
    let system = ''
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        system = JSON.parse(String(options.body)).messages[0].content
        return Response.json({ message: { role: 'assistant', content: 'Текст :sanich:' } })
    })
    assert.equal(await translateToRussian('Text :sanich:'), 'Текст :sanich:')
    assert.ok(!system.includes('111111111111111111'))
})
