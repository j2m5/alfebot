import 'dotenv/config'
import { Client, Events, GatewayIntentBits } from 'discord.js'
import { askOllama } from './ollama.js'
import { splitText } from './text.js'
import { startDevTracker } from './devtracker.js'
import { replySan, startSanich } from './sanich.js'

const token = process.env.DISCORD_TOKEN

if (!token) {
    throw new Error('DISCORD_TOKEN must be set in the environment variables.')
}

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
})

startSanich(client)

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

    if (interaction.commandName !== 'ask') return

    const prompt = interaction.options.getString('prompt', true)

    try {
        await interaction.deferReply()

        const answer = await askOllama(prompt)

        await sendLongReply(interaction, answer)
    } catch (error) {
        console.error(error)

        const message = 'Алфе зодумолся... Попробуйте позже!'

        if (interaction.deferred || interaction.replied) await interaction.editReply(message)
        else await interaction.reply(message)
    }
})

async function sendLongReply(
    interaction: {
        editReply(content: string): Promise<unknown>
        followUp(content: string): Promise<unknown>
    },

    text: string
): Promise<void> {
    const chunks = splitText(text)

    if (chunks.length === 0) chunks.push('Модель не вернула текст.')

    await interaction.editReply(chunks[0])

    for (const chunk of chunks.slice(1)) {
        await interaction.followUp(chunk)
    }
}

client.login(token)
