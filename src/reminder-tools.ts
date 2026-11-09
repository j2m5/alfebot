import { PermissionFlagsBits as P } from 'discord.js'
import { z } from 'zod'
import { MAX_REMINDER_DELAY_MS, type ReminderStore } from './reminder-store.js'
import type { DiscordToolContext, ToolBackend, ToolDefinition, ToolOutcome } from './tool-types.js'

const schemas = {
    create_reminder: z.strictObject({
        text: z.string().trim().min(1).max(500),
        delaySeconds: z.number().int().min(1).max(MAX_REMINDER_DELAY_MS / 1000).optional(),
        at: z.iso.datetime({ offset: true }).optional()
    }).refine(args => (args.delaySeconds !== undefined) !== (args.at !== undefined)),
    list_reminders: z.strictObject({}),
    cancel_reminder: z.strictObject({ reminderId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
}
type Name = keyof typeof schemas
const descriptions: Record<Name, string> = {
    create_reminder: 'Save a one-time reminder for caller in this channel. text <=500 chars; EITHER delaySeconds (relative to creation) OR at (ISO date/time with offset). Default timezone Moscow. Up to 1 year. No recurring reminders or other recipients.',
    list_reminders: 'List caller reminders in this guild, including pending and delivery problems; use IDs to cancel.',
    cancel_reminder: 'Cancel one of caller reminders by reminderId from list_reminders or current request.'
}
const definitions: readonly ToolDefinition[] = (Object.keys(schemas) as Name[]).map(name => ({
    name, description: descriptions[name], inputSchema: z.toJSONSchema(schemas[name]) as ToolDefinition['inputSchema'],
    mutating: name !== 'list_reminders'
}))

export async function requireReminderAccess(
    context: DiscordToolContext, backend: ToolBackend, signal: AbortSignal
): Promise<void> {
    signal.throwIfAborted()
    const outcome = await backend.execute('get_permissions', {}, signal)
    signal.throwIfAborted()
    if (!outcome.ok) throw new Error(outcome.message)
    const data = outcome.data as { channelId?: string; member?: { id?: string; bitfield?: string }; bot?: { id?: string; bitfield?: string } } | undefined
    if (!data || data.channelId !== context.channelId || data.member?.id !== context.actorId || data.bot?.id !== context.botId ||
        !/^\d+$/.test(data.member?.bitfield ?? '') || !/^\d+$/.test(data.bot?.bitfield ?? '')) {
        throw new Error('Не удалось проверить права для напоминания.')
    }
    for (const [who, bits] of [['тебя', data.member.bitfield!], ['бота', data.bot.bitfield!]]) {
        if (!(BigInt(bits) & P.SendMessages)) throw new Error(`У ${who} нет права отправлять сообщения в этом канале.`)
    }
}

export function createReminderTools(
    context: DiscordToolContext, store: ReminderStore, permissionBackend: ToolBackend, clock = Date.now
): ToolBackend {
    const ctx = Object.freeze({ ...context })
    const listedIds = new Set<number>()
    return { definitions, async execute(rawName, rawArgs, signal): Promise<ToolOutcome> {
        try {
            signal.throwIfAborted()
            if (!Object.hasOwn(schemas, rawName)) return { ok: false, message: 'Такого инструмента напоминаний нет.' }
            const name = rawName as Name
            const parsed = schemas[name].safeParse(rawArgs)
            if (!parsed.success) return { ok: false, message: name === 'create_reminder'
                ? 'Для напоминания нужны текст и понятное время. Например: «через 40 минут напомни про загрузку». Поддерживаются разовые напоминания до года вперёд.'
                : 'Не удалось разобрать запрос. Для отмены укажи номер из списка своих напоминаний.' }
            if (name === 'list_reminders') {
                const items = store.list(ctx.guildId, ctx.actorId)
                for (const item of items) listedIds.add(item.id)
                return { ok: true, message: 'До 50 напоминаний текущего пользователя на этом сервере, сначала активные. pending — ожидает, sending — отправляется, failed — не доставлено, uncertain — результат отправки неизвестен; автоматического повтора не будет.',
                    data: { complete: items.length < 50, reminders: items.map(item => ({
                        id: item.id, text: item.text, at: new Date(item.dueAt).toISOString(),
                        channelId: item.channelId, status: item.status
                    })) } }
            }
            if (name === 'cancel_reminder') {
                const { reminderId } = parsed.data as z.infer<typeof schemas.cancel_reminder>
                const explicitIds = [...ctx.requestText.matchAll(/(?:напоминани[\p{L}]*|reminder|отмени|удали|убери|cancel|delete)\s*(?:№|#)?\s*(\d+)(?!\d)/giu)]
                    .map(match => Number(match[1]))
                if (!listedIds.has(reminderId) && !explicitIds.includes(reminderId)) {
                    return { ok: false, message: 'Не удалось однозначно выбрать напоминание. Посмотри свои напоминания и укажи его номер.' }
                }
                signal.throwIfAborted()
                const result = store.cancel(reminderId, ctx.guildId, ctx.actorId, clock())
                return result === 'cancelled'
                    ? { ok: true, changed: true, message: `Напоминание #${reminderId} отменено.` }
                    : { ok: false, message: result === 'sending' ? 'Напоминание уже отправляется; отменить его сейчас нельзя.'
                        : 'Такого активного напоминания у тебя на этом сервере нет.' }
            }
            const args = parsed.data as z.infer<typeof schemas.create_reminder>
            await requireReminderAccess(ctx, permissionBackend, signal)
            const now = clock()
            const dueAt = args.delaySeconds === undefined ? Date.parse(args.at!) : now + args.delaySeconds * 1000
            if (!Number.isSafeInteger(dueAt) || dueAt <= now || dueAt > now + MAX_REMINDER_DELAY_MS) {
                return { ok: false, message: 'Время напоминания должно быть в будущем, не дальше чем через год. Уточни время.' }
            }
            signal.throwIfAborted()
            const reminder = store.schedule({ guildId: ctx.guildId, channelId: ctx.channelId, userId: ctx.actorId,
                requestId: ctx.requestId, text: args.text, dueAt }, now)
            if (reminder.status !== 'pending') return { ok: false, message: `Этот запрос уже обрабатывался: напоминание #${reminder.id}, статус ${reminder.status}. Новое не создавалось.` }
            const seconds = Math.floor(reminder.dueAt / 1000)
            return { ok: true, changed: true,
                message: `Напоминание #${reminder.id} сохранено: <t:${seconds}:F> (<t:${seconds}:R>).\n${reminder.text}\nНапомню тебе в <#${reminder.channelId}>. Для отмены: «отмени напоминание ${reminder.id}».`,
                data: { id: reminder.id, dueAt: reminder.dueAt } }
        } catch (error) {
            if (signal.aborted) return { ok: false, message: 'Запрос напоминания отменён.' }
            const message = error instanceof Error ? error.message : ''
            // Only our Russian operational errors are useful to the caller; do not expose SQL or stacks.
            return { ok: false, message: /^[А-Яа-яЁё]/u.test(message) ? message.slice(0, 500) : 'Не удалось обработать напоминание. Попробуй позже.' }
        }
    } }
}
