import { z } from 'zod'
import type { DiscordToolContext } from './tool-types.js'

const snowflake = /^[1-9]\d{16,19}$/
const messageLink = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)\/?$/
const anyUrl = /(?:[a-z][a-z\d+.-]*:(?:\/\/)?|\/\/|www\.)[^\s<>]+/giu
export const creationSchemas = {
    create_poll: z.strictObject({
        question: z.string().trim().min(1).max(300),
        answers: z.array(z.string().trim().min(1).max(55)).min(2).max(10)
            .refine(answers => new Set(answers.map(a => a.toLocaleLowerCase())).size === answers.length),
        durationHours: z.number().int().min(1).max(768).default(24),
        allowMultiselect: z.boolean().default(false)
    }),
    create_thread: z.strictObject({
        name: z.string().trim().min(1).max(100),
        messageId: z.union([z.string().regex(snowflake), z.string().max(200).regex(messageLink)]).optional(),
        fromReply: z.boolean().default(false)
    }).refine(args => !(args.fromReply && args.messageId), 'Use messageId or fromReply, not both')
}
export type CreationName = keyof typeof creationSchemas
export class CreationDenied extends Error {}
function requireThat(condition: unknown, message: string): asserts condition {
    if (!condition) throw new CreationDenied(message)
}
function messageId(value: string, context: DiscordToolContext): string {
    if (snowflake.test(value)) return value
    const link = messageLink.exec(value)
    requireThat(link && link[1] === context.guildId && link[2] === context.channelId && snowflake.test(link[3]),
        'Ветка создаётся только у сообщения текущего сервера и канала.')
    return link[3]
}

// Natural-language intent and wording belong to the model, not a command grammar.
// Code enforces API limits, real permissions, fixed destination and source provenance.
export function resolveCreationSource(name: CreationName, args: Record<string, any>, context: DiscordToolContext): string | undefined {
    // Guard a clear deferred first clause, not the format/content of the request.
    // This also leaves polite "если несложно" and poll questions as ordinary language.
    const request = context.requestText.trim().replace(new RegExp(`^<@!?${context.botId}>[,:]?\\s*`), '')
    const firstClause = request.split(/[,;\n]/u)[0]
    const conditional = /^(?:если|когда|как только|после того как|if|when|once|unless)(?!\p{L})/iu.test(firstClause)
    const polite = /^(?:если\s+(?:не\s?сложно|не\s?трудно|можешь|можно|умеешь)|if\s+(?:possible|you can|you don't mind))(?!\p{L})/iu.test(firstClause)
    requireThat(!conditional || polite || firstClause === request || /[?？]/u.test(firstClause),
        'Это просьба с условием, поэтому сейчас ничего не создаю. Когда условие выполнится, напиши, что можно запускать.')
    if (name === 'create_poll') return undefined
    if (args.fromReply) {
        requireThat(context.replyMessageId, 'Не вижу сообщения для ветки. Ответь на него или пришли ссылку.')
        return messageId(context.replyMessageId, context)
    }
    if (!args.messageId) return undefined
    const target = messageId(args.messageId, context)
    if (target === context.replyMessageId) return target
    const urls = context.requestText.match(anyUrl) ?? []
    const matchingLinks = urls.map(url => url.replace(/[),.!?]+$/, '')).filter(url => messageLink.exec(url)?.[3] === target)
    if (matchingLinks.length) {
        for (const url of matchingLinks) requireThat(messageId(url, context) === target, 'Не удалось определить сообщение для ветки.')
        return target
    }
    // A number hidden in an unrelated URL is not an explicit message ID.
    const withoutUrls = context.requestText.replace(anyUrl, '')
    requireThat(new RegExp(`(?<!\\d)${target}(?!\\d)`).test(withoutUrls),
        'Не вижу указанного сообщения в обращении. Пришли ссылку или ответь на нужное сообщение.')
    return target
}
