import 'dotenv/config'
import { InteractionContextType, REST, Routes, SlashCommandBuilder } from 'discord.js'

const token = process.env.DISCORD_TOKEN
const clientId = process.env.DISCORD_CLIENT_ID

if (!token || !clientId) {
  throw new Error('DISCORD_TOKEN and DISCORD_CLIENT_ID must be set in the environment variables.')
}

const commands = [
    new SlashCommandBuilder()
        .setName('ask')
        .setDescription('ask from Alfe')
        .addStringOption((option) =>
            option.setName('prompt')
                .setDescription('Prompt to ask from Alfe')
                .setRequired(true)
        )
        .toJSON(),
    new SlashCommandBuilder()
        .setName('san')
        .setDescription('Send :sanich: to the chat')
        .setContexts(InteractionContextType.Guild)
        .toJSON()
]

const rest = new REST({ version: '10' }).setToken(token)

await rest.put(Routes.applicationCommands(clientId), { body: commands })

console.log('running...')