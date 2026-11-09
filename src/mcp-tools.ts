import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ToolBackend, ToolOutcome, ToolSession } from './tool-types.js'

// У каждого вопроса собственная сессия: контекст исполнителя не передаётся модели.
export async function createToolSession(backend: ToolBackend, signal: AbortSignal): Promise<ToolSession> {
    signal.throwIfAborted()
    const lifetime = new AbortController()
    const sessionSignal = AbortSignal.any([signal, lifetime.signal])
    const server = new Server({ name: 'alfebot-discord', version: '1.0.0' }, { capabilities: { tools: {} } })
    const client = new Client({ name: 'alfebot', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const definitions = new Map(backend.definitions.map(tool => [tool.name, tool]))
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: backend.definitions.map(tool => ({
        name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: !tool.mutating, destructiveHint: tool.mutating, openWorldHint: true }
    })) }))
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const executionSignal = AbortSignal.any([sessionSignal, extra.signal])
        executionSignal.throwIfAborted()
        const outcome: ToolOutcome = definitions.has(request.params.name)
            ? await backend.execute(request.params.name, request.params.arguments ?? {}, executionSignal)
            : { ok: false, message: 'Такого инструмента нет.' }
        return { content: [{ type: 'text' as const, text: JSON.stringify(outcome) }],
            structuredContent: { ...outcome }, isError: !outcome.ok }
    })
    const close = async () => {
        lifetime.abort()
        await Promise.allSettled([client.close(), server.close()])
    }
    try {
        await server.connect(serverTransport)
        await client.connect(clientTransport, { signal: sessionSignal, timeout: 2000 })
        const catalog = await client.listTools({}, { signal: sessionSignal, timeout: 2000 })
        return {
            definitions: catalog.tools.map(tool => ({ name: tool.name, description: tool.description ?? '',
                inputSchema: tool.inputSchema, mutating: definitions.get(tool.name)!.mutating })),
            close,
            async call(name, args, callSignal) {
                const combined = AbortSignal.any([sessionSignal, callSignal])
                combined.throwIfAborted()
                const definition = definitions.get(name)
                if (!definition) return { ok: false, message: 'Такого инструмента нет.' }
                if (!args || typeof args !== 'object' || Array.isArray(args)) {
                    return { ok: false, message: 'Аргументы инструмента должны быть объектом.' }
                }
                try {
                    const result = await client.callTool({ name, arguments: args as Record<string, unknown> }, undefined,
                        { signal: combined, timeout: 8000 })
                    const outcome = result.structuredContent as ToolOutcome | undefined
                    if (!outcome || typeof outcome.ok !== 'boolean' || typeof outcome.message !== 'string') {
                        throw new Error('Invalid MCP result')
                    }
                    return outcome
                } catch (error) {
                    if (definition.mutating) return { ok: false, uncertain: true,
                        message: 'Не удалось подтвердить результат действия. Проверь состояние в Discord перед повтором.' }
                    combined.throwIfAborted()
                    return { ok: false, message: 'Не удалось получить данные Discord. Попробуй позже.' }
                }
            }
        }
    } catch (error) { await close(); throw error }
}
