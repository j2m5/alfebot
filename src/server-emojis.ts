import type { Guild } from 'discord.js'

export type ServerEmoji = { id: string; name: string; animated: boolean }

export async function getServerEmojis(guild: Guild | null): Promise<ServerEmoji[]> {
    if (!guild) return []

    const refresh = guild.emojis.fetch().catch((error) => {
        console.error('[ask] не удалось обновить эмодзи сервера, использую кэш:', error)
        return guild.emojis.cache
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const emojis = await Promise.race([
        refresh,
        new Promise<typeof guild.emojis.cache>((resolve) => {
            timer = setTimeout(() => resolve(guild.emojis.cache), 1500)
        })
    ]).finally(() => clearTimeout(timer))

    return [...emojis.values()]
        .filter((emoji) => emoji.name && emoji.available !== false && (
            emoji.roles.cache.size === 0 ||
            emoji.roles.cache.some((role) => guild.members.me?.roles.cache.has(role.id) ?? false)
        ))
        .map((emoji) => ({ id: emoji.id, name: emoji.name!, animated: emoji.animated }))
}

function emojiCode(emoji: ServerEmoji): string {
    return `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`
}

export function emojiInstructions(emojis: readonly ServerEmoji[]): string {
    if (emojis.length === 0) return 'Эмодзи этого сервера недоступны. Не придумывай серверные эмодзи и их коды.'

    return [
        'Оживляй ответы эмодзи текущего сервера, предпочитай их стандартным Unicode-эмодзи.',
        'В обычном ответе уместны 1–3 эмодзи, в шуточном — 3–5, распределённых по тексту. Учитывай настроение: не вставляй весёлые эмодзи в печальные или деликатные ответы.',
        'Выбирай по названию и контексту; изображений ты не видишь. Если смысл названия неясен, не выдумывай значение изображения.',
        'Используй только коды из списка ниже. Копируй полный код без изменений, вставляй его прямо в текст, без обратных кавычек, экранирования или блоков кода. Не придумывай имена и ID. Не перечисляй весь каталог в ответе.',
        'Доступные эмодзи текущего сервера:',
        ...emojis.map(emojiCode)
    ].join('\n')
}

export function normalizeServerEmojis(text: string, emojis: readonly ServerEmoji[]): string {
    const byId = new Map(emojis.map((emoji) => [emoji.id, emoji]))
    const byName = new Map(emojis.map((emoji) => [emoji.name, emoji]))

    // Сохраняем примеры кода; исправляем разметку только в обычном тексте ответа.
    return text.split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part, index) => {
        if (index % 2 === 1) return part
        return part.replace(/<a?:([A-Za-z0-9_]+):([0-9]+)>|:([A-Za-z0-9_]+):/g,
            (match, name: string | undefined, id: string | undefined, shortName: string | undefined) => {
                const emoji = id ? byId.get(id) ?? byName.get(name!) : byName.get(shortName!)
                return emoji ? emojiCode(emoji) : id ? '' : match
            })
    }).join('')
}
