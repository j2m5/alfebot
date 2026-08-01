import 'dotenv/config'
import { Client, Events, GatewayIntentBits } from 'discord.js'
import { askOllama } from './ollama.js'

const token = process.env.DISCORD_TOKEN

if (!token) {
    throw new Error('DISCORD_TOKEN must be set in the environment variables.')
}

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
})

client.once(Events.ClientReady, () => {
    console.log('Starting...')
})

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return

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

    await interaction.editReply(chunks[0])

    for (const chunk of chunks.slice(1)) {
        await interaction.followUp(chunk)
    }
}

function splitText(text: string, maxLength = 1900): string[] {
    const chunks: string[] = []

    let remaining = text

    while (remaining.length > maxLength) {
        let index = remaining.lastIndexOf("\n", maxLength)

        if (index < 1) index = remaining.lastIndexOf(" ", maxLength)

        if (index < 1) index = maxLength

        chunks.push(remaining.slice(0, index).trim())

        remaining = remaining.slice(index).trim()
    }

    if (remaining) chunks.push(remaining)

    return chunks.length > 0
        ? chunks
        : ["Модель не вернула текст."]
}

client.login(token)
