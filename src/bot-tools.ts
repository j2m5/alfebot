import { createDiscordTools } from './discord-tools.js'
import { createReminderTools } from './reminder-tools.js'
import type { DiscordToolContext, ToolBackend } from './tool-types.js'

export function createBotTools(context: DiscordToolContext, discord = createDiscordTools(context)): ToolBackend {
    if (!context.reminders) return discord
    const reminders = createReminderTools(context, context.reminders, discord)
    const definitions = [...discord.definitions, ...reminders.definitions]
    const reminderNames = new Set(reminders.definitions.map(tool => tool.name))
    let mutationAttempted = false
    return { definitions, async execute(name, args, signal) {
        signal.throwIfAborted()
        if (definitions.find(tool => tool.name === name)?.mutating) {
            if (mutationAttempted) return { ok: false, message: 'За один запрос можно выполнить только одно изменение.' }
            mutationAttempted = true
        }
        return (reminderNames.has(name) ? reminders : discord).execute(name, args, signal)
    } }
}
