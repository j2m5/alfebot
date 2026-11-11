import type { ModelMessage, ModelToolCall, ModelTurn } from './model-types.js'
import type { ToolDefinition } from './tool-types.js'

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'
const DEFAULT_MODEL = 'nvidia/nemotron-3.5-super-vl:free'
const INCOMPLETE_TOOL = 'Не удалось получить законченный запрос к инструменту. Действие не выполнялось.'

function apiMessages(messages: readonly ModelMessage[]) {
    return messages.map(message => {
        if (message.role === 'tool') {
            if (!message.tool_call_id) throw new Error('Missing OpenRouter tool_call_id')
            return { role: 'tool', content: message.content, tool_call_id: message.tool_call_id }
        }
        return { role: message.role, content: message.content, ...(message.tool_calls?.length ? {
            tool_calls: message.tool_calls.map(call => {
                if (!call.id) throw new Error('Missing OpenRouter tool call ID')
                return { id: call.id, type: 'function', function: {
                    name: call.function.name,
                    arguments: typeof call.function.arguments === 'string'
                        ? call.function.arguments : JSON.stringify(call.function.arguments)
                } }
            })
        } : {}) }
    })
}

function apiError(error: unknown, status?: number): Error {
    const detail = typeof error === 'string' ? error
        : error && typeof error === 'object' && 'message' in error ? String(error.message) : 'Request failed'
    return new Error(`OpenRouter${status ? ` HTTP ${status}` : ''}: ${detail.slice(0, 1000)}`)
}

async function request(
    messages: readonly ModelMessage[], signal: AbortSignal, stream: boolean, maxTokens: number,
    tools: readonly ToolDefinition[] = [], allowToolCalls = true
): Promise<Response> {
    signal.throwIfAborted()
    const key = process.env.OPENROUTER_API_KEY?.trim()
    if (!key) throw new Error('OPENROUTER_API_KEY must be set')
    const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'X-Title': 'Alfebot' },
        body: JSON.stringify({
            model: process.env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL,
            messages: apiMessages(messages), stream, max_tokens: maxTokens, temperature: 0.6,
            reasoning: { enabled: false, exclude: true },
            ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: {
                name: tool.name, description: tool.description, parameters: tool.inputSchema
            } })), tool_choice: allowToolCalls ? 'auto' : 'none', provider: { require_parameters: true } } : {})
        }), signal
    })
    if (!response.ok) {
        const text = await response.text()
        let error: unknown = text
        try { error = JSON.parse(text).error ?? text } catch { /* Non-JSON proxy error. */ }
        throw apiError(error, response.status)
    }
    return response
}

type ToolDelta = { index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }
type StreamChunk = {
    error?: unknown
    choices?: { index: number; delta?: { content?: string; tool_calls?: ToolDelta[] }; finish_reason?: string | null }[]
}

export async function streamTurn(
    messages: readonly ModelMessage[], signal: AbortSignal, tools: readonly ToolDefinition[] = [], allowToolCalls = true
): Promise<ModelTurn> {
    let text = '', finishReason: string | undefined
    let ended = false, shortened = false
    const calls = new Map<number, ModelToolCall>()
    try {
        const response = await request(messages, signal, true, 650, tools, allowToolCalls)
        if (!response.body) throw new Error('OpenRouter returned no response stream')
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let pending = '', dataLines: string[] = []
        function consumeEvent(): void {
            if (!dataLines.length) return
            const data = dataLines.join('\n'); dataLines = []
            if (data.trim() === '[DONE]') { ended = true; return }
            const chunk = JSON.parse(data) as StreamChunk
            if (chunk.error) throw apiError(chunk.error)
            const choice = chunk.choices?.find(item => item.index === 0)
            if (!choice) return // e.g. usage-only event
            if (choice.finish_reason === 'error') throw apiError('Provider stream failed')
            if (typeof choice.delta?.content === 'string') text += choice.delta.content
            for (const delta of choice.delta?.tool_calls ?? []) {
                if (!Number.isInteger(delta.index) || delta.index < 0 || (delta.type && delta.type !== 'function')) {
                    throw new Error('Invalid OpenRouter tool call')
                }
                let call = calls.get(delta.index)
                if (!call) {
                    call = { function: { name: '', arguments: '' } }
                    calls.set(delta.index, call)
                }
                if (delta.id) {
                    if (call.id && call.id !== delta.id) throw new Error('Ambiguous OpenRouter tool call ID')
                    call.id = delta.id
                }
                if (delta.function?.name) call.function.name += delta.function.name
                if (delta.function?.arguments !== undefined) {
                    if (typeof delta.function.arguments !== 'string') throw new Error('Invalid tool arguments delta')
                    call.function.arguments = String(call.function.arguments) + delta.function.arguments
                }
            }
            if (choice.finish_reason) {
                finishReason = choice.finish_reason
                if (finishReason !== 'stop' && finishReason !== 'tool_calls') shortened = true
            }
        }
        function consumeLine(line: string): void {
            line = line.replace(/\r$/, '')
            if (!line) { consumeEvent(); return }
            if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
            // SSE comments, event names and keepalives carry no answer text.
        }
        try {
            while (!ended) {
                const chunk = await reader.read()
                pending += decoder.decode(chunk.value, { stream: !chunk.done })
                let newline: number
                while (!ended && (newline = pending.indexOf('\n')) >= 0) {
                    consumeLine(pending.slice(0, newline))
                    pending = pending.slice(newline + 1)
                }
                if (chunk.done) {
                    if (!ended) { consumeLine(pending); consumeEvent() }
                    break
                }
            }
        } finally {
            await reader.cancel().catch(() => {})
            reader.releaseLock()
        }
    } catch (error) {
        if (!signal.aborted || (!text.trim() && !calls.size)) throw error
        shortened = true
    }
    const complete = ended && (finishReason === 'stop' || finishReason === 'tool_calls') && !shortened
    if (!complete && calls.size) return { content: INCOMPLETE_TOOL, toolCalls: [], complete: false }
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)
    const ids = new Set<string>()
    for (const call of toolCalls) {
        if (finishReason !== 'tool_calls' || !call.id || !call.function.name || ids.has(call.id)) {
            throw new Error('Invalid OpenRouter tool call ID or finish reason')
        }
        ids.add(call.id)
        try { call.function.arguments = JSON.parse(String(call.function.arguments)) }
        catch { throw new Error('Invalid tool arguments JSON') }
    }
    const answer = text.trim()
    if (!answer && !toolCalls.length) throw new Error('OpenRouter returned an empty answer')
    return { content: !complete ? answer.replace(/<[^>]*$/, '').trimEnd() + '\n\n…' : answer, toolCalls, complete }
}

export async function streamAnswer(messages: readonly ModelMessage[], signal: AbortSignal): Promise<string> {
    const turn = await streamTurn(messages, signal)
    if (!turn.content) throw new Error('OpenRouter returned an empty answer')
    return turn.content
}

export async function completeOpenRouter(messages: readonly ModelMessage[], signal: AbortSignal): Promise<string> {
    const response = await request(messages, signal, false, 4096)
    const data = await response.json() as {
        error?: unknown; choices?: { message?: { content?: string }; finish_reason?: string }[]
    }
    if (data.error) throw apiError(data.error)
    const choice = data.choices?.[0]
    if (choice?.finish_reason !== 'stop') throw new Error('OpenRouter returned an incomplete translation')
    const content = choice.message?.content?.trim()
    if (!content) throw new Error('OpenRouter returned an empty translation')
    return content
}
