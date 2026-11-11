import { setTimeout as retryDelay } from 'node:timers/promises'
import type { ModelMessage, ModelToolCall, ModelTurn } from './model-types.js'
import type { ToolDefinition } from './tool-types.js'

type ProviderName = 'nvidia' | 'openrouter'
type Provider = { name: ProviderName; label: string; endpoint: string; key: string; keyEnv: string; model: string }

function provider(name: string): Provider {
    if (name === 'nvidia') return {
        name, label: 'NVIDIA', endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
        key: process.env.NVIDIA_API_KEY?.trim() || '', keyEnv: 'NVIDIA_API_KEY',
        model: process.env.NVIDIA_MODEL?.trim() || 'nvidia/nemotron-3.5-super-vl-120b-a12b'
    }
    if (name === 'openrouter') return {
        name, label: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        key: process.env.OPENROUTER_API_KEY?.trim() || '', keyEnv: 'OPENROUTER_API_KEY',
        model: process.env.OPENROUTER_MODEL?.trim() || 'nvidia/nemotron-3.5-super-vl:free'
    }
    throw new Error('LLM_PROVIDER and LLM_FALLBACK_PROVIDER must be nvidia or openrouter')
}

export class ProviderError extends Error {
    constructor(message: string, readonly retryable: boolean, readonly status?: number) { super(message) }
}
const INCOMPLETE_TOOL = 'Не удалось получить законченный запрос к инструменту. Действие не выполнялось.'

function apiMessages(messages: readonly ModelMessage[]) {
    return messages.map(message => {
        if (message.role === 'tool') {
            if (!message.tool_call_id) throw new Error('Missing model tool_call_id')
            return { role: 'tool', content: message.content, tool_call_id: message.tool_call_id }
        }
        return { role: message.role, content: message.content, ...(message.tool_calls?.length ? {
            tool_calls: message.tool_calls.map(call => {
                if (!call.id) throw new Error('Missing model tool call ID')
                return { id: call.id, type: 'function', function: {
                    name: call.function.name,
                    arguments: typeof call.function.arguments === 'string'
                        ? call.function.arguments : JSON.stringify(call.function.arguments)
                } }
            })
        } : {}) }
    })
}

function apiError(label: string, error: unknown, status?: number): ProviderError {
    const detail = typeof error === 'string' ? error
        : error && typeof error === 'object' && 'message' in error ? String(error.message) : 'Request failed'
    return new ProviderError(`${label}${status ? ` HTTP ${status}` : ''}: ${detail.slice(0, 1000)}`,
        status === 429 || (status !== undefined && status >= 500 && status < 600), status)
}

async function errorText(response: Response): Promise<string> {
    if (!response.body) return response.statusText
    const reader = response.body.getReader()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        // Error details are diagnostic: a broken or hanging body must not prevent failover.
        return await Promise.race([
            (async () => {
                const decoder = new TextDecoder()
                let text = '', remaining = 4096
                while (remaining > 0) {
                    const { done, value } = await reader.read()
                    if (done) break
                    const part = value.subarray(0, remaining)
                    text += decoder.decode(part, { stream: true })
                    remaining -= part.length
                }
                return text + decoder.decode()
            })(),
            new Promise<string>(resolve => { timer = setTimeout(() => resolve(response.statusText), 500) })
        ])
    } catch { return response.statusText }
    finally {
        clearTimeout(timer)
        void reader.cancel().catch(() => {})
        reader.releaseLock()
    }
}

async function requestOnce(
    api: Provider,
    messages: readonly ModelMessage[], signal: AbortSignal, stream: boolean, maxTokens: number,
    tools: readonly ToolDefinition[] = [], allowToolCalls = true
): Promise<Response> {
    signal.throwIfAborted()
    if (!api.key) throw new Error(`${api.keyEnv} must be set`)
    const body = JSON.stringify({
        model: api.model,
        messages: apiMessages(messages), stream, max_tokens: maxTokens, temperature: 0.6,
        ...(api.name === 'nvidia' ? { chat_template_kwargs: { enable_thinking: false } }
            : { reasoning: { enabled: false, exclude: true } }),
        ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: {
            name: tool.name, description: tool.description, parameters: tool.inputSchema
        } })), tool_choice: allowToolCalls ? 'auto' : 'none',
        ...(api.name === 'openrouter' ? { provider: { require_parameters: true } } : {}) } : {})
    })
    const response = await fetch(api.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.key}`, 'X-Title': 'Alfebot' },
        body, signal
    }).catch(error => {
        if (signal.aborted || !(error instanceof TypeError)) throw error
        throw new ProviderError(`${api.label}: connection failed`, true)
    })
    if (!response.ok) {
        const text = await errorText(response)
        signal.throwIfAborted()
        let error: unknown = text
        try { error = JSON.parse(text).error ?? text } catch { /* Non-JSON proxy error. */ }
        throw apiError(api.label, error, response.status)
    }
    return response
}

async function request(
    messages: readonly ModelMessage[], signal: AbortSignal, stream: boolean, maxTokens: number,
    tools: readonly ToolDefinition[] = [], allowToolCalls = true
): Promise<{ response: Response; label: string }> {
    // Keep existing OpenRouter-only installations compatible; deployments select NVIDIA explicitly.
    const primary = provider(process.env.LLM_PROVIDER?.trim() || 'openrouter')
    const fallbackName = process.env.LLM_FALLBACK_PROVIDER?.trim()
    const fallback = fallbackName ? provider(fallbackName) : undefined
    try {
        let response: Response
        try {
            response = await requestOnce(primary, messages, signal, stream, maxTokens, tools, allowToolCalls)
        } catch (error) {
            if (signal.aborted || primary.name !== 'nvidia' || !(error instanceof ProviderError) || error.status !== 503) throw error
            // NVIDIA's screening service can briefly return 503 before inference starts.
            // Retry this generation once; no streamed answer or tool execution is replayed.
            console.warn(`[llm] ${error.message}; retrying NVIDIA once in 1s`)
            await retryDelay(1000, undefined, { signal })
            response = await requestOnce(primary, messages, signal, stream, maxTokens, tools, allowToolCalls)
        }
        return { response, label: primary.label }
    } catch (error) {
        if (signal.aborted || !(error instanceof ProviderError) || !error.retryable
            || !fallback?.key || fallback.name === primary.name
            || (fallback.name === 'openrouter' && !fallback.model.endsWith(':free') && fallback.model !== 'openrouter/free')) throw error
        // Only retry before a successful response starts. Never replay streamed text or partial tool calls.
        console.warn(`[llm] ${error.message}; trying ${fallback.label} reserve`)
        try {
            return { response: await requestOnce(fallback, messages, signal, stream, maxTokens, tools, allowToolCalls), label: fallback.label }
        } catch (fallbackError) {
            if (signal.aborted) throw fallbackError
            throw new AggregateError([error, fallbackError], `${primary.label} and ${fallback.label} failed`)
        }
    }
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
        const { response, label } = await request(messages, signal, true, 650, tools, allowToolCalls)
        if (!response.body) throw new Error(`${label} returned no response stream`)
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let pending = '', dataLines: string[] = []
        function consumeEvent(): void {
            if (!dataLines.length) return
            const data = dataLines.join('\n'); dataLines = []
            if (data.trim() === '[DONE]') { ended = true; return }
            const chunk = JSON.parse(data) as StreamChunk
            if (chunk.error) throw apiError(label, chunk.error)
            const choice = chunk.choices?.find(item => item.index === 0)
            if (!choice) return // e.g. usage-only event
            if (choice.finish_reason === 'error') throw apiError(label, 'Provider stream failed')
            if (typeof choice.delta?.content === 'string') text += choice.delta.content
            for (const delta of choice.delta?.tool_calls ?? []) {
                if (!Number.isInteger(delta.index) || delta.index < 0 || (delta.type && delta.type !== 'function')) {
                    throw new Error('Invalid model tool call')
                }
                let call = calls.get(delta.index)
                if (!call) {
                    call = { function: { name: '', arguments: '' } }
                    calls.set(delta.index, call)
                }
                if (delta.id) {
                    if (call.id && call.id !== delta.id) throw new Error('Ambiguous model tool call ID')
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
            throw new Error('Invalid model tool call ID or finish reason')
        }
        ids.add(call.id)
        try { call.function.arguments = JSON.parse(String(call.function.arguments)) }
        catch { throw new Error('Invalid tool arguments JSON') }
    }
    const answer = text.trim()
    if (!answer && !toolCalls.length) throw new Error('Model returned an empty answer')
    return { content: !complete ? answer.replace(/<[^>]*$/, '').trimEnd() + '\n\n…' : answer, toolCalls, complete }
}

export async function streamAnswer(messages: readonly ModelMessage[], signal: AbortSignal): Promise<string> {
    const turn = await streamTurn(messages, signal)
    if (!turn.content) throw new Error('Model returned an empty answer')
    return turn.content
}

export async function completeModel(messages: readonly ModelMessage[], signal: AbortSignal): Promise<string> {
    const { response, label } = await request(messages, signal, false, 4096)
    const data = await response.json() as {
        error?: unknown; choices?: { message?: { content?: string }; finish_reason?: string }[]
    }
    if (data.error) throw apiError(label, data.error)
    const choice = data.choices?.[0]
    if (choice?.finish_reason !== 'stop') throw new Error(`${label} returned an incomplete translation`)
    const content = choice.message?.content?.trim()
    if (!content) throw new Error(`${label} returned an empty translation`)
    return content
}
