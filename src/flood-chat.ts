import { Events, MessageFlags, type Client, type Message, type ChatInputCommandInteraction } from 'discord.js'
import { ConversationMemory, FLOOD_CHANNEL_ID } from './conversation-memory.js'
import { askOllama } from './ollama.js'
import { getServerEmojis } from './server-emojis.js'
import { splitText } from './text.js'

const NO_MENTIONS = { parse: [] as never[], repliedUser: false }
const BUSY = 'Сейчас отвечаю на другой вопрос. Повтори обращение через несколько секунд.'

export class AnswerGate {
    private token: symbol | null = null
    acquire(): (() => void) | null {
        if (this.token) return null
        const token = this.token = Symbol()
        return () => { if (this.token === token) this.token = null }
    }
}
export const answerGate = new AnswerGate()

export function isFloodTrigger(
    message: { channelId: string; author: { bot: boolean }; webhookId: string | null; content: string; system: boolean },
    botId: string,
    replyToBot: boolean
): boolean {
    return message.channelId === FLOOD_CHANNEL_ID && !message.author.bot && !message.webhookId && !message.system &&
        (replyToBot || new RegExp(`<@!?${botId}>`).test(message.content))
}

export function answerError(error: unknown): string {
    return error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
        ? 'Алфе не дождался ответа модели за 30 секунд. Попробуйте ещё раз чуть позже!'
        : 'Алфе зодумолся... Попробуйте позже!'
}

async function within<T>(promise: Promise<T>, fallback: T, milliseconds = 1500): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([promise.catch(() => fallback), new Promise<T>((resolve) => {
            timer = setTimeout(() => resolve(fallback), milliseconds)
        })])
    } finally { clearTimeout(timer) }
}

export class FloodChat {
    constructor(private client: Client, readonly memory = new ConversationMemory()) {}

    start(): void {
        this.memory.prune()
        const cleanup = setInterval(() => {
            try { this.memory.prune() } catch (error) { console.error('[chat] ошибка очистки памяти:', error) }
        }, 60 * 60_000)
        cleanup.unref()
        this.client.once(Events.ClientReady, () => {
            this.bootstrap().catch((error) => console.error('[chat] не удалось загрузить фон канала:', error))
        })
        this.client.on(Events.MessageCreate, (message) => {
            this.onMessage(message).catch((error) => console.error('[chat] ошибка обработки сообщения:', error))
        })
        this.client.on(Events.MessageUpdate, (_old, message) => {
            if (message.channelId !== FLOOD_CHANNEL_ID) return
            void (async () => {
                const full = message.partial ? await message.fetch() : message
                this.record(full)
            })().catch((error) => console.error('[chat] не удалось обновить сообщение в памяти:', error))
        })
        this.client.on(Events.MessageDelete, (message) => {
            if (message.channelId === FLOOD_CHANNEL_ID) this.remove(message.id)
        })
        this.client.on(Events.MessageBulkDelete, (messages, channel) => {
            if (channel.id === FLOOD_CHANNEL_ID) for (const id of messages.keys()) this.remove(id)
        })
    }

    private remove(id: string): void {
        try { this.memory.remove(id) } catch (error) { console.error('[chat] ошибка удаления из памяти:', error) }
    }

    async bootstrap(): Promise<void> {
        const channel = await this.client.channels.fetch(FLOOD_CHANNEL_ID)
        if (!channel?.isTextBased() || !('messages' in channel)) throw new Error('Flood channel unavailable')
        const recent = await channel.messages.fetch({ limit: 40 })
        // Не перезаписываем связи slash-ответов и свежие события, пришедшие во время fetch.
        for (const message of recent.values()) if (!this.memory.get(message.id)) this.record(message)
        console.log(`[chat] память включена для канала ${FLOOD_CHANNEL_ID}; записей: ${this.memory.count()}`)
    }

    private record(message: Message): void {
        if (message.channelId !== FLOOD_CHANNEL_ID || message.system || message.webhookId ||
            (message.author.bot && message.author.id !== this.client.user?.id)) return
        this.memory.remember({
            id: message.id, channelId: message.channelId, authorId: message.author.id,
            authorName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
            role: message.author.bot ? 'assistant' : 'user', content: message.content,
            createdAt: message.createdTimestamp, parentId: message.reference?.messageId ?? null, ownerId: null
        })
    }

    private saveReply(message: Message, parentId: string, ownerId: string): void {
        this.memory.remember({
            id: message.id, channelId: message.channelId, authorId: message.author.id,
            authorName: message.author.username, role: 'assistant', content: message.content,
            createdAt: message.createdTimestamp, parentId, ownerId
        })
    }

    async onMessage(message: Message): Promise<void> {
        if (message.channelId !== FLOOD_CHANNEL_ID || message.author.bot || message.webhookId || message.system) return
        const deadline = AbortSignal.timeout(28_000)
        this.record(message)
        const botId = this.client.user!.id
        const referenceId = message.reference?.channelId === FLOOD_CHANNEL_ID ? message.reference.messageId : undefined
        let parent = referenceId ? this.memory.get(referenceId) : undefined
        if (referenceId && !parent) {
            const referenced = await within(message.channel.messages.fetch(referenceId), null)
            if (referenced) { this.record(referenced); parent = this.memory.get(referenceId) }
        }
        if (!isFloodTrigger(message, botId, parent?.authorId === botId)) return
        const release = answerGate.acquire()
        if (!release) { await message.reply({ content: BUSY, allowedMentions: NO_MENTIONS }); return }
        try {
            if ('sendTyping' in message.channel) void message.channel.sendTyping().catch(() => {})
            const parentId = parent?.id ?? this.memory.latestReply(message.author.id)?.id ?? null
            // Сохраняем неявное продолжение для последующих reply.
            const current = this.memory.get(message.id)
            if (current) this.memory.remember({ ...current, parentId })
            const history = this.memory.context(message.channelId, message.id, parentId)
            const prompt = JSON.stringify({ author: message.member?.displayName ?? message.author.username,
                userId: message.author.id, text: message.content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim() || 'Привет!' })
            const emojis = await getServerEmojis(message.guild)
            const answer = await askOllama(prompt, emojis, deadline, history)
            // Если исходное сообщение удалили за время генерации, не отвечаем на него.
            if (!this.memory.get(message.id)) return
            let link = message.id
            const chunks = splitText(answer)
            if (!chunks.length) chunks.push('Модель не вернула текст.')
            for (const content of chunks) {
                const sent = await message.reply({ content, allowedMentions: NO_MENTIONS })
                this.saveReply(sent, link, message.author.id)
                link = sent.id
            }
        } catch (error) {
            console.error('[chat] ошибка ответа:', error)
            if (this.memory.get(message.id)) await message.reply({ content: answerError(error), allowedMentions: NO_MENTIONS })
        } finally { release() }
    }

    async answerSlash(interaction: ChatInputCommandInteraction, prompt: string): Promise<void> {
        if (interaction.channelId !== FLOOD_CHANNEL_ID) return
        const deadline = AbortSignal.timeout(28_000)
        const release = answerGate.acquire()
        if (!release) { await interaction.reply({ content: BUSY, flags: MessageFlags.Ephemeral }); return }
        try {
            await interaction.deferReply()
            const id = `ask:${interaction.id}`
            const parentId = this.memory.latestReply(interaction.user.id)?.id ?? null
            this.memory.remember({ id, channelId: interaction.channelId, authorId: interaction.user.id,
                authorName: interaction.user.globalName ?? interaction.user.username, role: 'user', content: prompt,
                createdAt: interaction.createdTimestamp, parentId, ownerId: null })
            const history = this.memory.context(interaction.channelId, id, parentId)
            const emojis = await getServerEmojis(interaction.guild)
            const answer = await askOllama(JSON.stringify({ author: interaction.user.globalName ?? interaction.user.username,
                userId: interaction.user.id, text: prompt }), emojis, deadline, history)
            let link = id
            const chunks = splitText(answer)
            if (!chunks.length) chunks.push('Модель не вернула текст.')
            for (let i = 0; i < chunks.length; i++) {
                const options = { content: chunks[i], allowedMentions: NO_MENTIONS }
                const sent = i === 0 ? await interaction.editReply(options) : await interaction.followUp(options)
                this.saveReply(sent, link, interaction.user.id)
                link = sent.id
            }
        } catch (error) {
            console.error('[chat] ошибка /ask:', error)
            const options = { content: answerError(error), allowedMentions: NO_MENTIONS }
            if (interaction.deferred || interaction.replied) await interaction.editReply(options)
            else await interaction.reply({ ...options, flags: MessageFlags.Ephemeral })
        } finally { release() }
    }
}
