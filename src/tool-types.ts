import type { REST } from 'discord.js'
import type { ReminderStore } from './reminder-store.js'

export type ToolDefinition = {
    name: string
    description: string
    inputSchema: { type: 'object'; [key: string]: unknown }
    mutating: boolean
}

export type ToolOutcome = {
    ok: boolean
    message: string
    data?: unknown
    changed?: boolean
    uncertain?: boolean
}

// Эти поля берутся из события Discord, никогда из текста или аргументов модели.
export type DiscordToolContext = {
    rest: Pick<REST, 'get' | 'patch' | 'put' | 'delete' | 'post'>
    guildId: string
    channelId: string
    actorId: string
    botId: string
    requestId: string
    requestText: string
    replyMessageId?: string
    replyUserId?: string
    reminders?: ReminderStore
}

export type ToolBackend = {
    definitions: readonly ToolDefinition[]
    execute(name: string, args: unknown, signal: AbortSignal): Promise<ToolOutcome>
}

export type ToolSession = {
    definitions: readonly ToolDefinition[]
    call(name: string, args: unknown, signal: AbortSignal): Promise<ToolOutcome>
    close(): Promise<void>
}
