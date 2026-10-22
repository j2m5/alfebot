import { randomInt } from 'node:crypto'
import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js'
import { askOllama } from './ollama.js'
import { emojiCode, getServerEmojis, type ServerEmoji } from './server-emojis.js'

export type SlotResult = {
    outcome: 'jackpot' | 'pair' | 'miss'
    emojis: [ServerEmoji, ServerEmoji, ServerEmoji]
}

export function rollSlots(
    emojis: readonly ServerEmoji[],
    random: (max: number) => number = randomInt
): SlotResult | null {
    const pool = [...new Map(emojis.map((emoji) => [emoji.id, emoji])).values()]
    if (pool.length < 3) return null

    const ticket = random(100)
    const take = () => pool.splice(random(pool.length), 1)[0]
    const first = take()

    if (ticket < 10) return { outcome: 'jackpot', emojis: [first, first, first] }
    if (ticket < 40) {
        const slots: SlotResult['emojis'] = [first, first, first]
        slots[random(3)] = take()
        return { outcome: 'pair', emojis: slots }
    }
    return { outcome: 'miss', emojis: [first, take(), take()] }
}

export async function replyPlay(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
        await interaction.reply({ content: '/play работает только на сервере с его собственными эмодзи.', flags: MessageFlags.Ephemeral })
        return
    }

    await interaction.deferReply()
    const emojis = await getServerEmojis(interaction.guild)
    const result = rollSlots(emojis)
    if (!result) {
        await interaction.editReply({ content: 'Для /play нужны хотя бы 3 доступных боту серверных эмодзи.', allowedMentions: { parse: [] } })
        return
    }

    await interaction.editReply({ content: result.emojis.map(emojiCode).join(' '), allowedMentions: { parse: [] } })
    let comment: string
    try {
        comment = await askOllama(JSON.stringify({
            outcome: result.outcome,
            outcomeMeaning: {
                jackpot: 'все три эмодзи совпали, это победа',
                pair: 'совпали ровно две эмодзи',
                miss: 'все три эмодзи разные, совпадений нет'
            }[result.outcome],
            emojis: result.emojis.map(emojiCode)
        }), emojis, AbortSignal.timeout(28_000), [], 'slot-comment')
    } catch (error) {
        console.error('[play] не удалось получить комментарий модели:', error)
        comment = 'Алфе задумался над комментарием. Результат уже показан выше.'
    }
    await interaction.followUp({ content: comment || 'Алфе задумался над комментарием. Результат уже показан выше.', allowedMentions: { parse: [] } })
}
