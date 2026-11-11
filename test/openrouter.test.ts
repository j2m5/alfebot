import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { askModel, translateToRussian } from '../src/llm.js'
import { streamTurn } from '../src/openrouter.js'
import { runToolConversation } from '../src/llm-agent.js'
import type { ToolSession } from '../src/tool-types.js'

const envNames = ['OPENROUTER_API_KEY', 'OPENROUTER_MODEL'] as const
let previous: Record<string, string | undefined>
beforeEach(() => {
    previous = Object.fromEntries(envNames.map(name => [name, process.env[name]]))
    process.env.OPENROUTER_API_KEY = 'test-key-not-a-secret'
    delete process.env.OPENROUTER_MODEL
})
afterEach(() => {
    for (const name of envNames) {
        if (previous[name] === undefined) delete process.env[name]
        else process.env[name] = previous[name]
    }
})

const messages = [{ role: 'user', content: 'Привет' }]
const signal = () => new AbortController().signal
const choice = (delta: unknown, finish_reason: string | null = null) => ({
    id: 'gen-test', object: 'chat.completion.chunk', created: 1,
    model: 'nvidia/nemotron-3.5-super-vl:free',
    choices: [{ index: 0, delta, finish_reason }]
})
function sse(chunks: unknown[], done = true): Response {
    const bytes = new TextEncoder().encode(': OPENROUTER PROCESSING\r\n\r\n'
        + chunks.map(chunk => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join('')
        + (done ? 'data: [DONE]\r\n\r\n' : ''))
    return new Response(new ReadableStream({ start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7))
        controller.close()
    } }), { headers: { 'Content-Type': 'text/event-stream' } })
}
const callChunk = (name = 'read', args = '{}', id = 'call_1') => choice({ tool_calls: [
    { index: 0, id, type: 'function', function: { name, arguments: args } }
] })
const definitions = [
    { name: 'read', description: 'Read', inputSchema: { type: 'object' as const }, mutating: false },
    { name: 'write', description: 'Write', inputSchema: { type: 'object' as const }, mutating: true }
]

test('OpenRouter sends authenticated free-model requests and assembles UTF-8 SSE without reasoning', async t => {
    let request: any, url: unknown, headers: Headers
    t.mock.method(globalThis, 'fetch', async (input, options) => {
        url = input; request = JSON.parse(String(options.body)); headers = new Headers(options.headers)
        return sse([choice({ reasoning: 'Не показывать', content: 'Привет ' }),
            choice({ content: ':sanich:' }), choice({}, 'stop')])
    })
    assert.equal(await askModel('Привет', [{ id: '111111111111111111', name: 'sanich', animated: false }]),
        'Привет <:sanich:111111111111111111>')
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions')
    assert.equal(headers!.get('Authorization'), 'Bearer test-key-not-a-secret')
    assert.equal(request.model, 'nvidia/nemotron-3.5-super-vl:free')
    assert.equal(request.stream, true)
    assert.ok(request.max_tokens > 0 && request.max_tokens <= 650)
    assert.equal(request.reasoning.enabled, false)
    assert.equal(request.options, undefined)
    assert.equal(request.models, undefined) // no automatic switch to paid models
})

test('OpenRouter assembles fragmented parallel tool arguments and preserves call IDs on results', async t => {
    const requests: any[] = [], executions: unknown[] = []
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        requests.push(JSON.parse(String(options.body)))
        return requests.length === 1 ? sse([
            choice({ content: 'Предварительная догадка', tool_calls: [
                { index: 0, id: 'call_a', type: 'function', function: { name: 'read', arguments: '{"id":' } },
                { index: 1, id: 'call_b', type: 'function', function: { name: 'read', arguments: '{"id":"2"}' } }
            ] }),
            choice({ tool_calls: [{ index: 0, function: { arguments: '"1"}' } }] }),
            choice({}, 'tool_calls')
        ]) : sse([choice({ content: 'Нашёл обоих.' }, 'stop')])
    })
    const session: ToolSession = { definitions, close: async () => {}, call: async (name, args) => {
        executions.push({ name, args }); return { ok: true, message: 'Найдено' }
    } }
    assert.equal(await runToolConversation(messages, session, signal()), 'Нашёл обоих.')
    assert.deepEqual(executions, [{ name: 'read', args: { id: '1' } }, { name: 'read', args: { id: '2' } }])
    const followup = requests[1].messages
    assert.deepEqual(followup.filter((m: any) => m.role === 'tool').map((m: any) => m.tool_call_id), ['call_a', 'call_b'])
    assert.deepEqual(followup[1].tool_calls.map((c: any) => [c.id, c.type, c.function.arguments]),
        [['call_a', 'function', '{"id":"1"}'], ['call_b', 'function', '{"id":"2"}']])
    assert.equal(followup[1].content, 'Предварительная догадка')
    assert.ok(followup.every((m: any) => m.tool_name === undefined))
})

test('OpenRouter mutation returns executor receipt once without another model request', async t => {
    let requests = 0, executions = 0
    t.mock.method(globalThis, 'fetch', async () => { requests++; return sse([callChunk('write'), choice({}, 'tool_calls')]) })
    const session: ToolSession = { definitions, close: async () => {}, call: async () => {
        executions++; return { ok: true, changed: true, message: 'Готово.' }
    } }
    assert.equal(await runToolConversation(messages, session, signal()), 'Готово.')
    assert.equal(executions, 1); assert.equal(requests, 1)
})

test('OpenRouter final tool-results round retains schemas while forbidding more calls', async t => {
    const requests: any[] = []
    let executions = 0
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        const body = JSON.parse(String(options.body)); requests.push(body)
        if (requests.length < 3) return sse([callChunk('read', '{}', `call_${requests.length}`), choice({}, 'tool_calls')])
        // The provider needs schemas to validate prior assistant calls and their results.
        if (!body.tools?.length || body.tool_choice !== 'none') {
            return Response.json({ error: { message: 'Tool schemas or final tool choice missing' } }, { status: 400 })
        }
        return sse([choice({ content: 'Проверил оба источника.' }, 'stop')])
    })
    const session: ToolSession = { definitions, close: async () => {}, call: async () => {
        executions++; return { ok: true, message: 'Данные источника' }
    } }
    assert.equal(await runToolConversation(messages, session, signal()), 'Проверил оба источника.')
    assert.equal(requests.length, 3); assert.equal(executions, 2)
    assert.deepEqual(requests[2].tools, requests[0].tools)
    assert.equal(requests[0].tool_choice, 'auto')
})

test('incomplete, truncated and malformed OpenRouter tool streams never execute actions', async t => {
    let executions = 0
    const fixtures: { response: () => Response; error?: RegExp }[] = [
        { response: () => sse([callChunk('write')], false) },
        { response: () => sse([callChunk('write')]) }, // DONE alone does not confirm a complete call
        { response: () => sse([callChunk('write'), choice({}, 'length')]) },
        { response: () => sse([callChunk('write', '{"x":'), choice({}, 'tool_calls')]), error: /arguments JSON/ },
        { response: () => sse([callChunk('write', '{}', ''), choice({}, 'tool_calls')]), error: /tool call ID/ },
        { response: () => sse([callChunk('write'), { error: { code: 503, message: 'Provider failed' } }]), error: /Provider failed/ }
    ]
    const session: ToolSession = { definitions, close: async () => {}, call: async () => {
        executions++; return { ok: true, changed: true, message: 'НЕ ДОЛЖНО ВЫПОЛНЯТЬСЯ' }
    } }
    for (const fixture of fixtures) {
        const mock = t.mock.method(globalThis, 'fetch', async () => fixture.response())
        try {
            if (fixture.error) await assert.rejects(runToolConversation(messages, session, signal()), fixture.error)
            else assert.match(await runToolConversation(messages, session, signal()), /не выполнялось|не выполнено/i)
        } finally { mock.mock.restore() }
    }
    assert.equal(executions, 0)
})

test('OpenRouter shared deadline returns partial text but does not execute partial tools', async t => {
    for (const withTools of [false, true]) {
        const deadline = new AbortController()
        t.mock.method(globalThis, 'fetch', async (_url, options) => {
            assert.equal(options.signal, deadline.signal)
            return new Response(new ReadableStream({ start(controller) {
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(choice({
                    content: 'Готовая мысль. <:sanich:111',
                    ...(withTools ? { tool_calls: [{ index: 0, id: 'c', function: { name: 'write', arguments: '{}' } }] } : {})
                }))}\n\n`))
                deadline.signal.addEventListener('abort', () => controller.error(deadline.signal.reason), { once: true })
                setTimeout(() => deadline.abort(new DOMException('Deadline', 'TimeoutError')), 5)
            } }))
        })
        const turn = await streamTurn(messages, deadline.signal, definitions)
        assert.equal(turn.complete, false); assert.deepEqual(turn.toolCalls, [])
        if (withTools) assert.match(turn.content, /не выполнялось/)
        else assert.equal(turn.content, 'Готовая мысль.\n\n…')
        t.mock.restoreAll()
    }
})

test('OpenRouter errors remain errors and HTTP limits are not retried', async t => {
    let requests = 0
    t.mock.method(globalThis, 'fetch', async () => {
        requests++; return Response.json({ error: { code: 429, message: 'Daily free limit reached' } }, { status: 429 })
    })
    await assert.rejects(streamTurn(messages, signal()), /429.*Daily free limit reached/)
    assert.equal(requests, 1)
    t.mock.restoreAll()
    t.mock.method(globalThis, 'fetch', async () => sse([choice({ content: 'Начало' }),
        { error: { code: 503, message: 'Provider failed' }, choices: [{ index: 0, delta: {}, finish_reason: 'error' }] }]))
    await assert.rejects(streamTurn(messages, signal()), /Provider failed/)
})

test('OpenRouter requires an API key before making any request', async t => {
    delete process.env.OPENROUTER_API_KEY
    let requests = 0
    t.mock.method(globalThis, 'fetch', async () => { requests++; return sse([choice({ content: 'Unexpected' }, 'stop')]) })
    await assert.rejects(streamTurn(messages, signal()), /OPENROUTER_API_KEY/)
    assert.equal(requests, 0)
})

test('OpenRouter translation uses the same provider with a separate output budget and rejects truncated text', async t => {
    let body: any, url: unknown
    t.mock.method(globalThis, 'fetch', async (input, options) => {
        url = input; body = JSON.parse(String(options.body))
        return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: 'Перевод :sanich:' }, finish_reason: 'stop' }] })
    })
    assert.equal(await translateToRussian('English :sanich:'), 'Перевод :sanich:')
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions')
    assert.equal(body.stream, false); assert.ok(body.max_tokens >= 2048)
    assert.equal(body.tools, undefined)
    assert.ok(!body.messages[0].content.includes('слот'))
    t.mock.restoreAll()
    t.mock.method(globalThis, 'fetch', async () => Response.json({
        choices: [{ index: 0, message: { role: 'assistant', content: 'Обрезанный перевод' }, finish_reason: 'length' }]
    }))
    await assert.rejects(translateToRussian('English'), /incomplete|truncated/i)
})
