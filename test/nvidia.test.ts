import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { askModel, translateToRussian } from '../src/llm.js'
import { streamTurn } from '../src/model-client.js'
import { runToolConversation } from '../src/llm-agent.js'
import { answerError } from '../src/flood-chat.js'
import { modelTextResponse, modelToolResponse } from './helpers/model-response.js'
import type { ToolSession } from '../src/tool-types.js'

const envNames = ['LLM_PROVIDER', 'LLM_FALLBACK_PROVIDER', 'NVIDIA_API_KEY', 'NVIDIA_MODEL',
    'OPENROUTER_API_KEY', 'OPENROUTER_MODEL'] as const
let previous: Record<string, string | undefined>
beforeEach(() => {
    previous = Object.fromEntries(envNames.map(name => [name, process.env[name]]))
    for (const name of envNames) delete process.env[name]
    process.env.LLM_PROVIDER = 'nvidia'
    process.env.NVIDIA_API_KEY = 'nvidia-test-key'
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key'
})
afterEach(() => {
    for (const name of envNames) {
        if (previous[name] === undefined) delete process.env[name]
        else process.env[name] = previous[name]
    }
})

const messages = [{ role: 'user', content: 'Привет' }]
const signal = () => new AbortController().signal
const nvidiaUrl = 'https://integrate.api.nvidia.com/v1/chat/completions'
const openrouterUrl = 'https://openrouter.ai/api/v1/chat/completions'

test('NVIDIA chat uses native model, key and disabled thinking without OpenRouter extensions', async t => {
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        const body = JSON.parse(String(options.body))
        assert.equal(url, nvidiaUrl)
        assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer nvidia-test-key')
        assert.equal(body.model, 'nvidia/nemotron-3.5-super-vl-120b-a12b')
        assert.equal(body.stream, true)
        assert.ok(body.max_tokens > 0 && body.max_tokens <= 650)
        assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false })
        assert.equal(body.reasoning, undefined)
        assert.equal(body.provider, undefined)
        return modelTextResponse('Привет :sanich:')
    })
    assert.equal(await askModel('Привет', [{ id: '111111111111111111', name: 'sanich', animated: false }]),
        'Привет <:sanich:111111111111111111>')
})

test('NVIDIA preserves tool call IDs and returns the grounded answer', async t => {
    let requests = 0, executions = 0
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.equal(url, nvidiaUrl)
        const body = JSON.parse(String(options.body))
        assert.equal(body.tools[0].function.name, 'read')
        assert.equal(body.tool_choice, 'auto')
        assert.equal(body.provider, undefined)
        if (++requests === 1) return modelToolResponse('read', { id: '42' })
        assert.equal(body.messages[1].tool_calls[0].id, 'call_fixture')
        assert.equal(body.messages[1].tool_calls[0].function.arguments, '{"id":"42"}')
        assert.equal(body.messages[2].tool_call_id, 'call_fixture')
        return modelTextResponse('Сервис работает.')
    })
    const session: ToolSession = {
        definitions: [{ name: 'read', description: 'Read status', inputSchema: { type: 'object' }, mutating: false }],
        close: async () => {}, call: async (name, args) => {
            assert.equal(name, 'read'); assert.deepEqual(args, { id: '42' }); executions++
            return { ok: true, message: 'Сервис работает.' }
        }
    }
    assert.equal(await runToolConversation(messages, session, signal()), 'Сервис работает.')
    assert.equal(executions, 1)
})

test('NVIDIA translation uses the configured model and non-streaming output budget', async t => {
    process.env.NVIDIA_MODEL = 'nvidia/test-model'
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        const body = JSON.parse(String(options.body))
        assert.equal(url, nvidiaUrl); assert.equal(body.model, 'nvidia/test-model')
        assert.equal(body.stream, false); assert.ok(body.max_tokens >= 2048)
        assert.equal(body.tools, undefined)
        assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false })
        return Response.json({ choices: [{ message: { content: 'Перевод.' }, finish_reason: 'stop' }] })
    })
    assert.equal(await translateToRussian('Translation.'), 'Перевод.')
})

test('NVIDIA requires its own key and rejects unknown provider before sending anything', async t => {
    let requests = 0
    t.mock.method(globalThis, 'fetch', async () => { requests++; return modelTextResponse('Unexpected') })
    delete process.env.NVIDIA_API_KEY
    await assert.rejects(streamTurn(messages, signal()), /NVIDIA_API_KEY/)
    process.env.LLM_PROVIDER = 'typo'
    await assert.rejects(streamTurn(messages, signal()), /LLM_PROVIDER/)
    assert.equal(requests, 0)
})

test('configured free OpenRouter reserve handles NVIDIA overload after one retry and connection errors immediately', async t => {
    process.env.LLM_FALLBACK_PROVIDER = 'openrouter'
    for (const failure of [429, 503, 'network'] as const) {
        const urls: unknown[] = []
        const deadline = signal()
        const mock = t.mock.method(globalThis, 'fetch', async (url, options) => {
            urls.push(url)
            assert.equal(options.signal, deadline)
            if (url === nvidiaUrl) {
                if (failure === 'network') throw new TypeError('fetch failed')
                return Response.json({ error: { message: 'Busy' } }, { status: failure })
            }
            const body = JSON.parse(String(options.body))
            assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer openrouter-test-key')
            assert.equal(body.model, 'nvidia/nemotron-3.5-super-vl:free')
            assert.equal(body.chat_template_kwargs, undefined)
            assert.equal(body.reasoning.enabled, false)
            return modelTextResponse('Ответ резерва.')
        })
        try {
            assert.equal((await streamTurn(messages, deadline)).content, 'Ответ резерва.')
            assert.deepEqual(urls, failure === 503 ? [nvidiaUrl, nvidiaUrl, openrouterUrl] : [nvidiaUrl, openrouterUrl])
        } finally { mock.mock.restore() }
    }
})

test('reserve does not run for rejected input, bad credentials, absent config or paid OpenRouter model', async t => {
    for (const scenario of [
        { status: 400, reserve: 'openrouter' }, { status: 401, reserve: 'openrouter' },
        { status: 429, reserve: '' }, { status: 503, reserve: 'openrouter', model: 'paid/model' },
        { status: 503, reserve: 'openrouter', noKey: true }
    ]) {
        process.env.LLM_FALLBACK_PROVIDER = scenario.reserve
        process.env.OPENROUTER_MODEL = scenario.model ?? ''
        process.env.OPENROUTER_API_KEY = scenario.noKey ? '' : 'openrouter-test-key'
        let requests = 0
        const mock = t.mock.method(globalThis, 'fetch', async () => {
            requests++; return Response.json({ error: { message: 'Unavailable' } }, { status: scenario.status })
        })
        try {
            await assert.rejects(streamTurn(messages, signal()), new RegExp(`NVIDIA HTTP ${scenario.status}`))
            assert.equal(requests, scenario.status === 503 ? 2 : 1)
        } finally { mock.mock.restore() }
    }
})

test('exhausted reserve surfaces its own error without retry loops', async t => {
    process.env.LLM_FALLBACK_PROVIDER = 'openrouter'
    let requests = 0
    t.mock.method(globalThis, 'fetch', async () => {
        requests++; return Response.json({ error: { message: requests === 1 ? 'Busy' : 'Daily free limit reached' } }, { status: 429 })
    })
    await assert.rejects(streamTurn(messages, signal()), error => {
        assert.ok(error instanceof AggregateError)
        assert.match(error.errors[0].message, /NVIDIA HTTP 429.*Busy/)
        assert.match(error.errors[1].message, /OpenRouter HTTP 429.*Daily free limit/)
        const notice = answerError(error)
        assert.match(notice, /резерв/i)
        assert.match(notice, /дневн.*квот/i)
        assert.doesNotMatch(notice, /зодумолся|Daily free|HTTP/)
        return true
    })
    assert.equal(requests, 2)
})

test('a primary provider outage is explained without pretending the daily quota is exhausted', async t => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({
        error: { message: 'content safety screening is temporarily unavailable' }
    }, { status: 503 }))
    await assert.rejects(streamTurn(messages, signal()), error => {
        const notice = answerError(error)
        assert.match(notice, /сервис модели.*недоступен/i)
        assert.doesNotMatch(notice, /зодумолся|квот|content safety/)
        return true
    })
})

test('transient NVIDIA 503 retries the same request once without spending the reserve quota', async t => {
    process.env.LLM_FALLBACK_PROVIDER = 'openrouter'
    const urls: unknown[] = [], bodies: string[] = []
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        urls.push(url); bodies.push(String(options.body))
        if (urls.length === 1) return Response.json({ error: { message: 'content safety screening is temporarily unavailable' } }, { status: 503 })
        return modelTextResponse('Ответ после восстановления NVIDIA.')
    })
    assert.equal((await streamTurn(messages, signal())).content, 'Ответ после восстановления NVIDIA.')
    assert.deepEqual(urls, [nvidiaUrl, nvidiaUrl])
    assert.equal(bodies[0], bodies[1])
})

test('cancellation during NVIDIA retry delay prevents both retry and reserve requests', async t => {
    process.env.LLM_FALLBACK_PROVIDER = 'openrouter'
    const controller = new AbortController()
    let requests = 0
    t.mock.method(globalThis, 'fetch', async () => {
        requests++
        return Response.json({ error: { message: 'Temporarily unavailable' } }, { status: 503 })
    })
    const timer = setTimeout(() => controller.abort(), 30)
    t.after(() => clearTimeout(timer))
    await assert.rejects(streamTurn(messages, controller.signal), { name: 'AbortError' })
    assert.equal(requests, 1)
})

test('HTTP overload still uses reserve when its diagnostic body disconnects or stalls', async t => {
    process.env.LLM_FALLBACK_PROVIDER = 'openrouter'
    for (const stalled of [false, true]) {
        let requests = 0
        const mock = t.mock.method(globalThis, 'fetch', async (url) => {
            requests++
            if (url === openrouterUrl) return modelTextResponse('Резерв доступен.')
            return new Response(new ReadableStream({ start(controller) {
                if (!stalled) controller.error(new TypeError('terminated'))
            } }), { status: 503, statusText: 'Service Unavailable' })
        })
        try {
            const turn = await streamTurn(messages, AbortSignal.timeout(5000))
            assert.equal(turn.content, 'Резерв доступен.')
            assert.equal(requests, 3)
        } finally { mock.mock.restore() }
    }
})

test('reserve tool call executes once and returns the action receipt without replaying the mutation', async t => {
    process.env.LLM_FALLBACK_PROVIDER = 'openrouter'
    let requests = 0, executions = 0
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        requests++
        if (url === nvidiaUrl) return Response.json({ error: { message: 'Busy' } }, { status: 503 })
        assert.equal(url, openrouterUrl)
        const body = JSON.parse(String(options.body))
        assert.equal(body.tools[0].function.name, 'write')
        assert.deepEqual(body.provider, { require_parameters: true })
        assert.equal(body.tool_choice, 'auto')
        return modelToolResponse('write', { text: 'Напоминание' })
    })
    const session: ToolSession = {
        definitions: [{ name: 'write', description: 'Write', inputSchema: { type: 'object' }, mutating: true }],
        close: async () => {}, call: async (name, args) => {
            executions++; assert.equal(name, 'write'); assert.deepEqual(args, { text: 'Напоминание' })
            return { ok: true, changed: true, message: 'Напоминание сохранено.' }
        }
    }
    assert.equal(await runToolConversation(messages, session, signal()), 'Напоминание сохранено.')
    assert.equal(executions, 1); assert.equal(requests, 3)
})

test('translation reserve retains its separate budget and the non-streaming protocol', async t => {
    process.env.LLM_FALLBACK_PROVIDER = 'openrouter'
    let requests = 0
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        requests++
        if (url === nvidiaUrl) return Response.json({ error: { message: 'Busy' } }, { status: 503 })
        assert.equal(url, openrouterUrl)
        const body = JSON.parse(String(options.body))
        assert.equal(body.stream, false); assert.equal(body.max_tokens, 4096)
        assert.equal(body.chat_template_kwargs, undefined); assert.equal(body.tools, undefined)
        return Response.json({ choices: [{ message: { content: 'Перевод резерва.' }, finish_reason: 'stop' }] })
    })
    assert.equal(await translateToRussian('Translation.'), 'Перевод резерва.')
    assert.equal(requests, 3)
})

test('started or aborted model streams never restart on the reserve or execute partial tools', async t => {
    process.env.LLM_FALLBACK_PROVIDER = 'openrouter'
    for (const mode of ['stream-error', 'partial-tool', 'deadline'] as const) {
        let requests = 0
        const deadline = new AbortController()
        const mock = t.mock.method(globalThis, 'fetch', async () => {
            requests++
            if (mode === 'deadline') {
                deadline.abort(new DOMException('Deadline', 'TimeoutError'))
                throw deadline.signal.reason
            }
            if (mode === 'partial-tool') return new Response('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"write","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n')
            return new Response('data: {"error":{"message":"Stream failed"}}\n\n')
        })
        try {
            if (mode === 'partial-tool') {
                const turn = await streamTurn(messages, deadline.signal)
                assert.equal(turn.complete, false); assert.deepEqual(turn.toolCalls, [])
            } else await assert.rejects(streamTurn(messages, deadline.signal), /Stream failed|Deadline/)
            assert.equal(requests, 1)
        } finally { mock.mock.restore() }
    }
})
