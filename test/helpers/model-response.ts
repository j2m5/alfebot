import { afterEach, beforeEach, type TestContext } from 'node:test'

export function useTestModelKey(): void {
    const names = ['LLM_PROVIDER', 'LLM_FALLBACK_PROVIDER', 'OPENROUTER_API_KEY'] as const
    let previous: Record<string, string | undefined>
    beforeEach(() => {
        previous = Object.fromEntries(names.map(name => [name, process.env[name]]))
        process.env.LLM_PROVIDER = 'openrouter'
        delete process.env.LLM_FALLBACK_PROVIDER
        process.env.OPENROUTER_API_KEY = 'test-key-not-a-secret'
    })
    afterEach(() => {
        for (const name of names) {
            if (previous[name] === undefined) delete process.env[name]
            else process.env[name] = previous[name]
        }
    })
}

function response(delta: unknown, finishReason: string): Response {
    const chunk = { id: 'gen-fixture', object: 'chat.completion.chunk', created: 1, model: 'test-model',
        choices: [{ index: 0, delta, finish_reason: finishReason }] }
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { 'Content-Type': 'text/event-stream' }
    })
}

export const modelTextResponse = (content: string): Response => response({ content }, 'stop')

export function modelAfterMinute(t: TestContext, content: string): void {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    // AbortSignal.timeout uses an internal timer; connect it to the fake clock as well.
    t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
        const controller = new AbortController()
        setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), milliseconds)
        return controller.signal
    })
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        t.mock.timers.tick(60_000)
        options.signal?.throwIfAborted()
        return modelTextResponse(content)
    })
}

export const modelToolResponse = (name: string, args: unknown): Response => response({ tool_calls: [
    { index: 0, id: 'call_fixture', type: 'function', function: { name, arguments: JSON.stringify(args) } }
] }, 'tool_calls')
