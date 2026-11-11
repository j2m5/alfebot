import 'dotenv/config'
import { Client, Events, GatewayIntentBits, Partials, MessageFlags, Routes } from 'discord.js'
import { askModel } from './llm.js'
import { splitText } from './text.js'
import { startDevTracker } from './devtracker.js'
import { replySan, startSanich } from './sanich.js'
import { getServerEmojis } from './server-emojis.js'
import { getServerContext } from './server-context.js'
import { FloodChat, answerGate, answerError } from './flood-chat.js'
import { FLOOD_CHANNEL_ID } from './conversation-memory.js'
import { replyPlay } from './play.js'
import { createToolRest } from './tool-rest.js'
import { ReminderStore } from './reminder-store.js'
import { ReminderScheduler, stopReminders } from './reminder-scheduler.js'
import { createDiscordTools } from './discord-tools.js'
import { requireReminderAccess } from './reminder-tools.js'

const token = process.env.DISCORD_TOKEN

if (!token) {
    throw new Error('DISCORD_TOKEN must be set in the environment variables.')
}

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Message]
})

startSanich(client)
// Сетевой сбой или лимит Discord не должен приводить к повтору записи без новой проверки прав.
const toolRest = createToolRest(token)
const reminders = new ReminderStore()
const reminderScheduler = new ReminderScheduler(reminders, {
    async authorize(reminder, signal) {
        const context = { rest: toolRest, guildId: reminder.guildId, channelId: reminder.channelId,
            actorId: reminder.userId, botId: client.user!.id, requestId: reminder.requestId, requestText: '' }
        await requireReminderAccess(context, createDiscordTools(context), signal)
    },
    async send(reminder, body, signal) {
        return await toolRest.post(Routes.channelMessages(reminder.channelId), { body, signal }) as { id: string; channel_id: string }
    }
})
const floodChat = new FloodChat(client, undefined, toolRest, reminders)
floodChat.start()

let shuttingDown = false
async function shutdown(): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    try {
        await stopReminders(reminderScheduler, reminders)
        await client.destroy()
        process.exit(0)
    } catch {
        console.error('[reminders] не удалось завершить остановку')
        process.exit(1)
    }
}
process.once('SIGTERM', () => { void shutdown() })
process.once('SIGINT', () => { void shutdown() })

client.once(Events.ClientReady, () => {
    if (shuttingDown) return
    console.log('Starting...')
    reminderScheduler.start()
    console.log('[reminders] обработчик напоминаний запущен')

    startDevTracker(client).catch((error) => console.error('[devtracker] сбой запуска:', error))
})

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return

    if (interaction.commandName === 'san') {
        await replySan(interaction).catch((error) => console.error('[sanich] не удалось ответить на /san:', error))
        return
    }

    if (interaction.commandName === 'play') {
        await replyPlay(interaction).catch((error) => console.error('[play] не удалось ответить на /play:', error))
        return
    }

    if (interaction.commandName === 'reset') {
        await floodChat.resetMemory(interaction).catch((error) => console.error('[chat] ошибка /reset:', error))
        return
    }

    if (interaction.commandName !== 'ask') return

    const prompt = interaction.options.getString('prompt', true)
    if (interaction.channelId === FLOOD_CHANNEL_ID) {
        await floodChat.answerSlash(interaction, prompt).catch((error) => console.error('[chat] ошибка Discord:', error))
        return
    }
    const signal = new AbortController().signal
    const release = answerGate.acquire()
    if (!release) {
        await interaction.reply({ content: 'Сейчас отвечаю на другой вопрос. Повтори обращение через несколько секунд.', flags: MessageFlags.Ephemeral })
        return
    }

    try {
        await interaction.deferReply()

        const [emojis, serverContext] = await Promise.all([
            getServerEmojis(interaction.guild), getServerContext(interaction.guild, signal)
        ])
        const answer = await askModel(JSON.stringify({ author: interaction.user.globalName ?? interaction.user.username,
            userId: interaction.user.id, text: prompt }), emojis, signal, serverContext ? [serverContext] : [], 'chat',
            interaction.guild ? { rest: toolRest, guildId: interaction.guild.id, channelId: interaction.channelId,
                actorId: interaction.user.id, botId: client.user!.id, requestId: interaction.id, requestText: prompt, reminders } : undefined)

        await sendLongReply(interaction, answer)
    } catch (error) {
        console.error(error)

        const message = answerError(error)

        if (interaction.deferred || interaction.replied) await interaction.editReply(message)
        else await interaction.reply(message)
    } finally { release() }
})

async function sendLongReply(
    interaction: {
        editReply(options: { content: string; allowedMentions: { parse: never[] } }): Promise<unknown>
        followUp(options: { content: string; allowedMentions: { parse: never[] } }): Promise<unknown>
    },

    text: string
): Promise<void> {
    const chunks = splitText(text)

    if (chunks.length === 0) chunks.push('Модель не вернула текст.')

    await interaction.editReply({ content: chunks[0], allowedMentions: { parse: [] } })

    for (const chunk of chunks.slice(1)) {
        await interaction.followUp({ content: chunk, allowedMentions: { parse: [] } })
    }
}

client.login(token)
