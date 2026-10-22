import 'dotenv/config'
import { Client, Events, GatewayIntentBits, Partials, MessageFlags } from 'discord.js'
import { askOllama } from './ollama.js'
import { splitText } from './text.js'
import { startDevTracker } from './devtracker.js'
import { replySan, startSanich } from './sanich.js'
import { getServerEmojis } from './server-emojis.js'
import { FloodChat, answerGate, answerError } from './flood-chat.js'
import { FLOOD_CHANNEL_ID } from './conversation-memory.js'
import { replyPlay } from './play.js'

const token = process.env.DISCORD_TOKEN

if (!token) {
    throw new Error('DISCORD_TOKEN must be set in the environment variables.')
}

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Message]
})

startSanich(client)
const floodChat = new FloodChat(client)
floodChat.start()

client.once(Events.ClientReady, () => {
    console.log('Starting...')

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

    if (interaction.commandName !== 'ask') return

    const prompt = interaction.options.getString('prompt', true)
    if (interaction.channelId === FLOOD_CHANNEL_ID) {
        await floodChat.answerSlash(interaction, prompt).catch((error) => console.error('[chat] ошибка Discord:', error))
        return
    }
    const deadline = AbortSignal.timeout(28_000)
    const release = answerGate.acquire()
    if (!release) {
        await interaction.reply({ content: 'Сейчас отвечаю на другой вопрос. Повтори обращение через несколько секунд.', flags: MessageFlags.Ephemeral })
        return
    }

    try {
        await interaction.deferReply()

        const emojis = await getServerEmojis(interaction.guild)
        const answer = await askOllama(prompt, emojis, deadline)

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
