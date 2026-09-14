import { EmbedBuilder } from 'discord.js';
import { translateToRussian } from './ollama.js';
import { fetchDevTrackerFeed } from './rss.js';
import { loadPostedIds, savePostedIds, stateFileExists } from './state.js';
import { splitText } from './text.js';
export const MAX_POSTS_PER_TICK = 10;
const DEFAULT_FEED_URL = 'https://forums.swtor.com/discover/6.xml';
const DEFAULT_STATE_FILE = './data/devtracker.json';
const DEFAULT_INTERVAL_MINUTES = 20;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 1440;
const EMBED_COLOR = 0xE6B800;
const EMBED_TITLE_LIMIT = 256;
const EMBED_CHUNK_SIZE = 4000;
const TRANSLATION_HEADER = '🇷🇺 **Перевод**\n\n';
const SEND_DELAY_MS = 1000;
export function readConfig(env) {
    const channelId = env.DEV_TRACKER_CHANNEL_ID?.trim();
    if (!channelId)
        return null;
    const intervalMinutes = positiveNumber(env.DEV_TRACKER_INTERVAL_MINUTES, DEFAULT_INTERVAL_MINUTES);
    const clampedIntervalMinutes = Math.min(Math.max(intervalMinutes, MIN_INTERVAL_MINUTES), MAX_INTERVAL_MINUTES);
    return {
        channelId,
        feedUrl: env.DEV_TRACKER_FEED_URL?.trim() || DEFAULT_FEED_URL,
        stateFile: env.DEV_TRACKER_STATE_FILE?.trim() || DEFAULT_STATE_FILE,
        intervalMs: clampedIntervalMinutes * 60_000,
        seedPostCount: positiveNumber(env.DEV_TRACKER_SEED_POST_COUNT, 0)
    };
}
export function selectNewItems(items, postedIds, limit, prefer) {
    // slice(-0) вернул бы весь массив, поэтому выходим до любых slice.
    if (limit <= 0)
        return [];
    const fresh = items
        .filter((entry) => !postedIds.has(entry.id))
        .sort((left, right) => left.publishedAt.getTime() - right.publishedAt.getTime());
    return prefer === 'newest' ? fresh.slice(-limit) : fresh.slice(0, limit);
}
export function buildEmbeds(item, translation) {
    const blocks = splitText(item.text, EMBED_CHUNK_SIZE);
    if (blocks.length === 0)
        blocks.push('_пустое сообщение_');
    const translatedBlocks = translation ? splitText(translation, EMBED_CHUNK_SIZE) : [];
    if (translatedBlocks.length > 0) {
        translatedBlocks[0] = TRANSLATION_HEADER + translatedBlocks[0];
        blocks.push(...translatedBlocks);
    }
    else {
        blocks.push('_перевод недоступен_');
    }
    return blocks.map((block, index) => {
        const embed = new EmbedBuilder()
            .setColor(EMBED_COLOR)
            .setDescription(block);
        if (index === 0) {
            embed.setTitle(item.title.slice(0, EMBED_TITLE_LIMIT)).setURL(item.link);
        }
        if (index === blocks.length - 1) {
            embed.setFooter({ text: 'SWTOR Dev Tracker' }).setTimestamp(item.publishedAt);
        }
        return embed;
    });
}
export async function startDevTracker(client) {
    const config = readConfig(process.env);
    if (!config) {
        console.warn('[devtracker] DEV_TRACKER_CHANNEL_ID не задан, лента отключена');
        return;
    }
    const channel = await client.channels.fetch(config.channelId).catch(() => null);
    if (!channel?.isSendable()) {
        console.error(`[devtracker] канал ${config.channelId} не найден или в него нельзя писать, лента отключена`);
        return;
    }
    const postedIds = new Set(await loadPostedIds(config.stateFile));
    try {
        await savePostedIds(config.stateFile, [...postedIds]);
    }
    catch (error) {
        console.error(`[devtracker] файл состояния ${config.stateFile} недоступен для записи, лента отключена:`, error);
        return;
    }
    let isRunning = false;
    const tick = async () => {
        if (isRunning) {
            console.warn('[devtracker] предыдущая проверка ещё идёт, пропускаю');
            return;
        }
        isRunning = true;
        try {
            await runTick(channel, config, postedIds);
        }
        catch (error) {
            console.error('[devtracker] проверка не удалась:', error);
        }
        finally {
            isRunning = false;
        }
    };
    console.log(`[devtracker] запущен, канал ${config.channelId}, интервал ${config.intervalMs / 60_000} мин`);
    await tick();
    setInterval(() => void tick(), config.intervalMs);
}
async function runTick(channel, config, postedIds) {
    // Файл может существовать, но быть непригодным (повреждён, недоступен для чтения, каталог вместо файла) —
    // loadPostedIds в таком случае молча возвращает []. Пустой набор ID приравниваем к первому запуску,
    // ведь у реально записанного состояния ID не бывает нулю.
    const isFirstRun = !(await stateFileExists(config.stateFile)) || postedIds.size === 0;
    const items = await fetchDevTrackerFeed(config.feedUrl);
    if (items.length === 0) {
        console.warn('[devtracker] лента пуста');
        return;
    }
    const toPost = isFirstRun
        ? selectNewItems(items, postedIds, config.seedPostCount, 'newest')
        : selectNewItems(items, postedIds, MAX_POSTS_PER_TICK, 'oldest');
    if (isFirstRun) {
        const selectedIds = new Set(toPost.map((entry) => entry.id));
        for (const entry of items) {
            if (!selectedIds.has(entry.id))
                postedIds.add(entry.id);
        }
        await savePostedIds(config.stateFile, [...postedIds]);
        console.log(`[devtracker] первый запуск: помечено виденными ${items.length - toPost.length}, публикую ${toPost.length}`);
    }
    for (const item of toPost) {
        let translation = null;
        try {
            translation = await translateToRussian(item.text);
        }
        catch (error) {
            console.error(`[devtracker] перевод не удался для ${item.id}:`, error);
        }
        // Любая ошибка ниже (включая падение buildEmbeds) не должна прерывать цикл: непойманный
        // throw заблокировал бы очередь навсегда, т.к. selectNewItems снова выбрал бы этот же
        // элемент первым на следующем тике.
        let anySent = false;
        try {
            const embeds = buildEmbeds(item, translation);
            for (const [index, embed] of embeds.entries()) {
                await channel.send({ embeds: [embed] });
                anySent = true;
                if (index < embeds.length - 1)
                    await delay(SEND_DELAY_MS);
            }
        }
        catch (error) {
            console.error(`[devtracker] ошибка при публикации ${item.id}:`, error);
        }
        // Ничего не ушло в канал — не помечаем как опубликованное, повторим на следующем тике.
        // Хоть что-то ушло — помечаем: повторная публикация урезанной серии раз в 20 минут хуже,
        // чем один раз опубликовать её не полностью.
        if (anySent) {
            postedIds.add(item.id);
            try {
                await savePostedIds(config.stateFile, [...postedIds]);
                console.log(`[devtracker] опубликовано ${item.id}: ${item.title}`);
            }
            catch (error) {
                console.error(`[devtracker] не удалось сохранить состояние после публикации ${item.id}:`, error);
            }
        }
        await delay(SEND_DELAY_MS);
    }
}
function positiveNumber(raw, fallback) {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
