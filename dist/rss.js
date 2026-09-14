import { XMLParser } from 'fast-xml-parser';
const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    htmlEntities: true,
    trimValues: true,
    isArray: (_name, jpath) => jpath === 'rss.channel.item'
});
export function extractCommentId(link) {
    const match = link.match(/[?&]comment=(\d+)/);
    return match ? match[1] : link;
}
export function parseDevTrackerFeed(xml) {
    const feed = parser.parse(xml);
    const rawItems = feed.rss?.channel?.item ?? [];
    const items = [];
    for (const raw of rawItems) {
        const link = String(raw.link ?? '').trim();
        if (!link || !URL.canParse(link))
            continue;
        const publishedAt = new Date(String(raw.pubDate ?? ''));
        items.push({
            id: extractCommentId(link),
            title: String(raw.title ?? '').trim() || 'SWTOR Dev Tracker',
            link,
            text: restoreParagraphs(String(raw.description ?? '')),
            publishedAt: Number.isNaN(publishedAt.getTime()) ? new Date() : publishedAt
        });
    }
    return items;
}
export async function fetchDevTrackerFeed(url) {
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'alfebot/1.0 (+https://github.com/)',
            'Accept': 'application/rss+xml, application/xml, text/xml'
        },
        signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) {
        throw new Error(`Лента вернула ${response.status} ${response.statusText}`);
    }
    return parseDevTrackerFeed(await response.text());
}
// В ленте переводы строк отсутствуют: форум схлопывает абзацы в подряд идущие пробелы.
function restoreParagraphs(text) {
    return text.replace(/ {2,}/g, '\n\n').trim();
}
