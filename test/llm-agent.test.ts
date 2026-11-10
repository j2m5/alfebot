import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { runToolConversation } from '../src/llm-agent.js'
import type { ToolSession } from '../src/tool-types.js'

const definitions = [
    { name: 'read', description: 'Read', inputSchema: { type: 'object' as const }, mutating: false },
    { name: 'write', description: 'Write', inputSchema: { type: 'object' as const }, mutating: true }
]
let previousApiKey: string | undefined
beforeEach(() => { previousApiKey = process.env.OPENROUTER_API_KEY; process.env.OPENROUTER_API_KEY = 'test-key-not-a-secret' })
afterEach(() => { if (previousApiKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previousApiKey })
const choice = (delta: unknown, finish_reason: string | null = null) => ({
    id: 'gen-test', object: 'chat.completion.chunk', created: 1, model: 'test-model',
    choices: [{ index: 0, delta, finish_reason }]
})
const sse = (chunks: unknown[], done = true) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')
        + (done ? 'data: [DONE]\n\n' : '')))
    controller.close()
} }), { headers: { 'Content-Type': 'text/event-stream' } })
const textTurn = (text: string) => sse([choice({ content: text }), choice({}, 'stop')])
const toolCall = (name: string, args: unknown = {}, id = 'call_test', index = 0) =>
    ({ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const toolTurn = (name: string, args: unknown = {}, id = 'call_test') => sse([choice({ tool_calls: [toolCall(name, args, id)] }), choice({}, 'tool_calls')])
const toolCallsTurn = (calls: unknown[]) => sse([choice({ tool_calls: calls }), choice({}, 'tool_calls')])
const messages = [{ role: 'user' as const, content: 'Мой вопрос' }]
const signal = () => new AbortController().signal

test('результат чтения через инструмент возвращается модели, предварительный текст не публикуется', async (t) => {
    const requests: any[] = []
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        requests.push(JSON.parse(String(options.body)))
        return requests.length === 1
            ? sse([choice({ content: 'Сначала догадка.', tool_calls: [toolCall('read', { id: '123' })] }), choice({}, 'tool_calls')])
            : textTurn('Проверил: Алиса.')
    })
    const calls: unknown[] = []
    const session: ToolSession = { definitions, close: async () => {}, call: async (name, args) => {
        calls.push({ name, args })
        return { ok: true, message: 'Найдено', data: { name: 'Алиса' } }
    } }
    assert.equal(await runToolConversation(messages, session, signal()), 'Проверил: Алиса.')
    assert.deepEqual(calls, [{ name: 'read', args: { id: '123' } }])
    assert.equal(requests[1].messages.at(-1).role, 'tool')
    assert.equal(requests[1].messages.at(-1).tool_call_id, 'call_test')
    assert.equal(requests[1].messages.at(-2).tool_calls[0].id, requests[1].messages.at(-1).tool_call_id)
    assert.ok(requests[1].messages.every((message: any) => message.tool_name === undefined))
    assert.equal(JSON.parse(requests[1].messages.at(-1).content).data.name, 'Алиса')
    assert.equal(requests[0].reasoning.enabled, false)
    assert.ok(requests[0].max_tokens > 0 && requests[0].max_tokens <= 650)
})

test('no-tool decision delegates to ordinary chat once and discards speculative planner text', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => textTurn('Всё уже сделал.'))
    let fallbackCalls = 0, executions = 0
    const session: ToolSession = { definitions, close: async () => {}, call: async () => { executions++; return { ok: true, message: 'Готово' } } }
    const answer = await runToolConversation(messages, session, signal(), async () => { fallbackCalls++; return 'Обычный ответ.' })
    assert.equal(answer, 'Обычный ответ.')
    assert.equal(fallbackCalls, 1)
    assert.equal(executions, 0)
})

test('planner abort prevents a second chat request', async (t) => {
    const controller = new AbortController()
    let fallbackCalls = 0
    t.mock.method(globalThis, 'fetch', async () => {
        controller.abort()
        return textTurn('NO_TOOLS')
    })
    const session: ToolSession = { definitions, close: async () => {}, call: async () => ({ ok: true, message: 'Готово' }) }
    await assert.rejects(runToolConversation(messages, session, controller.signal, async () => { fallbackCalls++; return 'Не отправлять' }))
    assert.equal(fallbackCalls, 0)
})

test('подтверждение изменения возвращается из исполнителя без второй генерации и повторной операции', async (t) => {
    let requests = 0
    t.mock.method(globalThis, 'fetch', async () => {
        requests++
        return toolTurn('write')
    })
    const session: ToolSession = { definitions, close: async () => {}, call: async () => ({ ok: true, changed: true, message: 'Ник изменён.' }) }
    assert.equal(await runToolConversation(messages, session, signal()), 'Ник изменён.')
    assert.equal(requests, 1)
})

test('отказ и неопределённый результат изменения не превращаются в успех модели', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => toolTurn('write'))
    for (const outcome of [
        { ok: false, message: 'У бота нет права.' },
        { ok: false, uncertain: true, message: 'Не удалось подтвердить результат. Проверь вручную.' }
    ]) {
        const session: ToolSession = { definitions, close: async () => {}, call: async () => outcome }
        assert.equal(await runToolConversation(messages, session, signal()), outcome.message)
    }
})

test('несколько изменений в одном ответе модели не выполняются частично', async (t) => {
    let executions = 0
    t.mock.method(globalThis, 'fetch', async () => toolCallsTurn([toolCall('write', {}, 'call_1', 0), toolCall('write', {}, 'call_2', 1)]))
    const session: ToolSession = { definitions, close: async () => {}, call: async () => { executions++; return { ok: true, message: 'Успех' } } }
    assert.match(await runToolConversation(messages, session, signal()), /одно действие/i)
    assert.equal(executions, 0)
})

test('лимит обращений останавливает модель, бесконечно вызывающую инструменты', async (t) => {
    let requests = 0, executions = 0
    t.mock.method(globalThis, 'fetch', async () => {
        requests++
        return toolTurn('read', { id: String(requests) }, `call_${requests}`)
    })
    const session: ToolSession = { definitions, close: async () => {}, call: async () => { executions++; return { ok: true, message: 'Есть данные' } } }
    assert.match(await runToolConversation(messages, session, signal()), /лимит|уточни/i)
    assert.ok(requests <= 3)
    assert.ok(executions <= 4)
})

test('оборванный поток с вызовом инструмента не выполняет действие', async (t) => {
    const controller = new AbortController()
    let executions = 0
    t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(stream) {
        stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(choice({ content: 'Всё удалил.', tool_calls: [toolCall('write')] }))}\n\n`))
        controller.signal.addEventListener('abort', () => stream.error(controller.signal.reason), { once: true })
        setTimeout(() => controller.abort(), 5)
    } })))
    const session: ToolSession = { definitions, close: async () => {}, call: async () => { executions++; return { ok: true, changed: true, message: 'Готово' } } }
    const answer = await runToolConversation(messages, session, controller.signal)
    assert.equal(executions, 0)
    assert.ok(!answer.includes('Всё удалил'))
    assert.match(answer, /не выполнялось|не выполнено/i)
})

test('незавершённый текст без вызова инструмента не публикует выдуманное подтверждение', async (t) => {
    let executions = 0
    t.mock.method(globalThis, 'fetch', async () => sse([choice({ content: 'Никнейм изменён на Новый Ник.' })], false))
    const session: ToolSession = { definitions, close: async () => {}, call: async () => { executions++; return { ok: true, message: 'Готово' } } }
    const answer = await runToolConversation(messages, session, signal())
    assert.equal(executions, 0)
    assert.ok(!answer.includes('Никнейм изменён'))
    assert.match(answer, /не выполнялось|не выполнено/i)
})

test('неизвестный инструмент и лишние вызовы не попадают в исполнитель', async (t) => {
    let executions = 0
    t.mock.method(globalThis, 'fetch', async () => toolCallsTurn(Array.from({ length: 5 }, (_, index) => toolCall('unknown', {}, `call_${index}`, index))))
    const session: ToolSession = { definitions, close: async () => {}, call: async () => { executions++; return { ok: true, message: 'Успех' } } }
    assert.match(await runToolConversation(messages, session, signal()), /лимит|уточни/i)
    assert.equal(executions, 0)
})
