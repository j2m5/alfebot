import type { ToolDefinition } from './tool-types.js'

export type ModelToolCall = { function: { name: string; arguments: unknown; index?: number } }
export type ModelMessage = { role: string; content: string; tool_calls?: ModelToolCall[]; tool_name?: string }
export type ModelTurn = { content: string; toolCalls: ModelToolCall[]; complete: boolean }

export async function streamTurn(
    messages: readonly ModelMessage[], signal: AbortSignal, tools: readonly ToolDefinition[] = []
): Promise<ModelTurn> {
    let text = ''
    let shortened = false
    let done = false
    const calls: ModelToolCall[] = []
    const indexedCalls = new Map<number, ModelToolCall>()
    try {
        const response = await fetch(`${process.env.OLLAMA_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: process.env.OLLAMA_MODEL, messages,
                stream: true, think: false, options: { num_predict: 650 },
                ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: {
                    name: tool.name, description: tool.description, parameters: tool.inputSchema
                } })) } : {})
            }),
            signal
        })
        if (!response.ok) throw new Error(await response.text())
        if (!response.body) throw new Error('Ollama returned no response stream')

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let pending = ''
        function consume(line: string): void {
            if (!line.trim()) return
            const chunk = JSON.parse(line)
            if (chunk.error) throw new Error(chunk.error)
            if (typeof chunk.message?.content === 'string') text += chunk.message.content
            if (Array.isArray(chunk.message?.tool_calls)) {
                for (const raw of chunk.message.tool_calls) {
                    const fn = raw?.function
                    if (!fn || typeof fn.name !== 'string') throw new Error('Invalid model tool call')
                    const previous = typeof fn.index === 'number' ? indexedCalls.get(fn.index) : undefined
                    if (previous) {
                        if (previous.function.name !== fn.name) throw new Error('Ambiguous model tool call')
                        if (typeof previous.function.arguments === 'string' && typeof fn.arguments === 'string') {
                            previous.function.arguments += fn.arguments
                        } else if (fn.arguments !== undefined) previous.function.arguments = fn.arguments
                    } else {
                        const call = { function: { name: fn.name, arguments: fn.arguments ?? {}, index: fn.index } }
                        calls.push(call)
                        if (typeof fn.index === 'number') indexedCalls.set(fn.index, call)
                    }
                }
            }
            if (chunk.done) done = true
            if (chunk.done_reason === 'length') shortened = true
        }
        try {
            while (!done) {
                const chunk = await reader.read()
                pending += decoder.decode(chunk.value, { stream: !chunk.done })
                let newline: number
                while ((newline = pending.indexOf('\n')) >= 0) {
                    consume(pending.slice(0, newline))
                    pending = pending.slice(newline + 1)
                }
                if (chunk.done) {
                    consume(pending)
                    break
                }
            }
        } finally {
            await reader.cancel().catch(() => {})
            reader.releaseLock()
        }
    } catch (error) {
        if (!signal.aborted || !text.trim()) throw error
        shortened = true
    }
    const answer = text.trim()
    if (!answer && !calls.length) throw new Error('Ollama returned an empty answer')
    const complete = done && !shortened
    if (!complete && calls.length) return {
        content: 'Не удалось получить законченный запрос к инструменту. Действие не выполнялось.',
        toolCalls: [], complete: false
    }
    for (const call of calls) {
        if (complete && typeof call.function.arguments === 'string') {
            try { call.function.arguments = JSON.parse(call.function.arguments) }
            catch { throw new Error('Invalid tool arguments JSON') }
        }
    }
    // Не показываем незаконченный код эмодзи, если дедлайн пришёл посреди него.
    return { content: shortened ? answer.replace(/<[^>]*$/, '').trimEnd() + '\n\n…' : answer,
        toolCalls: complete ? calls : [], complete }
}

// Обычные ответы и /play сохраняют прежний потоковый интерфейс.
export async function streamAnswer(messages: readonly ModelMessage[], signal: AbortSignal): Promise<string> {
    const turn = await streamTurn(messages, signal)
    if (!turn.content) throw new Error('Ollama returned an empty answer')
    return turn.content
}
