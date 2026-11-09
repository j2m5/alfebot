import { streamTurn, type ModelMessage } from './ollama-stream.js'
import type { ToolOutcome, ToolSession } from './tool-types.js'

const LIMIT = 'Достигнут лимит обращений к инструментам. Уточни вопрос или отправь следующий запрос.'

export async function runToolConversation(
    initialMessages: readonly ModelMessage[], session: ToolSession, signal: AbortSignal,
    answerWithoutTools?: () => Promise<string>
): Promise<string> {
    const messages = [...initialMessages]
    const definitions = new Map(session.definitions.map(tool => [tool.name, tool]))
    let callCount = 0
    let lastResult: ToolOutcome | undefined
    for (let round = 0; round < 3; round++) {
        let turn
        try {
            signal.throwIfAborted()
            turn = await streamTurn(messages, signal, round < 2 ? session.definitions : [])
        } catch (error) {
            if (lastResult && !lastResult.ok) return lastResult.message
            throw error
        }
        if (!turn.complete) return 'Не удалось получить законченный ответ модели. Действие не выполнялось.'
        if (!turn.toolCalls.length) {
            if (round === 0 && answerWithoutTools) {
                signal.throwIfAborted()
                return answerWithoutTools()
            }
            return turn.content || 'Модель не вернула текст.'
        }
        if (round === 2 || callCount + turn.toolCalls.length > 4) return LIMIT
        const mutations = turn.toolCalls.filter(call => definitions.get(call.function.name)?.mutating)
        if (mutations.length > 1) return 'За один запрос можно выполнить только одно действие. Уточни, какое нужно сделать.'
        messages.push({ role: 'assistant', content: '', tool_calls: turn.toolCalls })
        for (const call of turn.toolCalls) {
            signal.throwIfAborted()
            callCount++
            const definition = definitions.get(call.function.name)
            const result = definition
                ? await session.call(call.function.name, call.function.arguments, signal)
                : { ok: false, message: 'Такого инструмента нет.' }
            lastResult = result
            // Итог изменения формирует исполнитель, без новой генерации и риска повторить запись.
            if (definition?.mutating) return result.message
            messages.push({ role: 'tool', tool_name: call.function.name, content: JSON.stringify(result) })
        }
    }
    return LIMIT
}
