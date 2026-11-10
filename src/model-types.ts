export type ModelToolCall = { id?: string; function: { name: string; arguments: unknown } }
export type ModelMessage = { role: string; content: string; tool_calls?: ModelToolCall[]; tool_call_id?: string }
export type ModelTurn = { content: string; toolCalls: ModelToolCall[]; complete: boolean }
