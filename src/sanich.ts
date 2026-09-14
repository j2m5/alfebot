import { Client, Events, MessageFlags, type ChatInputCommandInteraction, type Collection, type Message } from 'discord.js'

export const SANICH_ROLE_ID = '1278077913899597936'
export const SANICH_EMOJI_NAME = 'sanich'

// Гифки из поиска Discord (Tenor, Giphy) приходят превью с типом gifv.
const IGNORED_EMBED_TYPES = new Set(['gifv'])

export type SanichEmbed = { data: { type?: string } }

export type SanichMessage = {
    author: { bot: boolean }
    embeds: readonly SanichEmbed[]
    member: { roles: { cache: { has(id: string): boolean } } } | null
}

// Discord собирает превью ссылки асинхронно: оно приходит либо сразу в messageCreate,
// либо позже в messageUpdate. Отвечаем только в момент, когда превью появилось впервые.
export function shouldReplySanich(message: SanichMessage, previousEmbeds: readonly SanichEmbed[]): boolean {
    if (message.author.bot) return false

    if (countPreviews(previousEmbeds) > 0 || countPreviews(message.embeds) === 0) return false

    return message.member?.roles.cache.has(SANICH_ROLE_ID) ?? false
}

function countPreviews(embeds: readonly SanichEmbed[]): number {
    return embeds.filter((embed) => !IGNORED_EMBED_TYPES.has(embed.data.type ?? '')).length
}

export type SanichGuild = {
    emojis: { cache: Collection<string, { name: string | null; toString(): string }> }
}

// Бот не превращает текст ":sanich:" в эмодзи сам, нужно отправлять разметку вида <:sanich:ID>.
export function sanichEmojiText(guild: SanichGuild | null): string | null {
    return guild?.emojis.cache.find((emoji) => emoji.name === SANICH_EMOJI_NAME)?.toString() ?? null
}

export async function replySan(interaction: ChatInputCommandInteraction): Promise<void> {
    const emoji = sanichEmojiText(interaction.guild)

    if (!emoji) {
        await interaction.reply({ content: `На сервере нет эмодзи :${SANICH_EMOJI_NAME}:`, flags: MessageFlags.Ephemeral })
        return
    }

    await interaction.reply(emoji)
}

export function startSanich(client: Client): void {
    client.on(Events.MessageCreate, (message) => replySanich(message, []))

    client.on(Events.MessageUpdate, (oldMessage, newMessage) => replySanich(newMessage, oldMessage.embeds))
}

async function replySanich(message: Message, previousEmbeds: readonly SanichEmbed[]): Promise<void> {
    if (!shouldReplySanich(message, previousEmbeds)) return

    const emoji = sanichEmojiText(message.guild)

    if (!emoji) {
        console.error(`[sanich] эмодзи :${SANICH_EMOJI_NAME}: не найдено на сервере`)
        return
    }

    try {
        await message.reply({ content: emoji, allowedMentions: { repliedUser: false } })
    } catch (error) {
        console.error('[sanich] не удалось ответить:', error)
    }
}
