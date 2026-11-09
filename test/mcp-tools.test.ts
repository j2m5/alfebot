import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createToolSession } from '../src/mcp-tools.js'
import type { ToolBackend } from '../src/tool-types.js'

test('настоящий MCP передаёт список инструментов, аргументы и структурированный результат', async () => {
    const calls: unknown[] = []
    const backend: ToolBackend = {
        definitions: [{ name: 'get_member', description: 'Read a member', inputSchema: { type: 'object' }, mutating: false }],
        execute: async (name, args, signal) => {
            signal.throwIfAborted()
            calls.push({ name, args })
            return { ok: true, message: 'Участник найден', data: { id: '200', name: 'Алиса' } }
        }
    }
    const session = await createToolSession(backend, new AbortController().signal)
    try {
        assert.equal(session.definitions[0].name, 'get_member')
        const result = await session.call('get_member', { userId: '200' }, new AbortController().signal)
        assert.deepEqual(result, { ok: true, message: 'Участник найден', data: { id: '200', name: 'Алиса' } })
        assert.deepEqual(calls, [{ name: 'get_member', args: { userId: '200' } }])
        assert.equal((await session.call('unregistered', {}, new AbortController().signal)).ok, false)
        assert.equal(calls.length, 1)
    } finally { await session.close() }
})

test('отмена MCP до выполнения не вызывает backend; отмена во время передаётся исполнителю', async () => {
    let called = 0
    let executionSignal: AbortSignal | undefined
    const controller = new AbortController()
    const backend: ToolBackend = {
        definitions: [{ name: 'read', description: 'Read', inputSchema: { type: 'object' }, mutating: false }],
        execute: async (_name, _args, signal) => {
            called++
            executionSignal = signal
            queueMicrotask(() => controller.abort())
            await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
            return { ok: false, message: 'Отменено' }
        }
    }
    const session = await createToolSession(backend, controller.signal)
    try {
        const already = AbortSignal.abort()
        await assert.rejects(session.call('read', {}, already), { name: 'AbortError' })
        assert.equal(called, 0)
        await assert.rejects(session.call('read', {}, controller.signal), { name: 'AbortError' })
        assert.equal(executionSignal?.aborted, true)
    } finally { await session.close() }
})
