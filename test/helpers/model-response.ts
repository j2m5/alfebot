import { afterEach, beforeEach } from 'node:test'

export function useTestModelKey(): void {
    let previous: string | undefined
    beforeEach(() => { previous = process.env.OPENROUTER_API_KEY; process.env.OPENROUTER_API_KEY = 'test-key-not-a-secret' })
    afterEach(() => {
        if (previous === undefined) delete process.env.OPENROUTER_API_KEY
        else process.env.OPENROUTER_API_KEY = previous
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
export const modelToolResponse = (name: string, args: unknown): Response => response({ tool_calls: [
    { index: 0, id: 'call_fixture', type: 'function', function: { name, arguments: JSON.stringify(args) } }
] }, 'tool_calls')
