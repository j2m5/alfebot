import { XMLParser } from 'fast-xml-parser'

export type DevTrackerItem = {
    id: string
    title: string
    link: string
    text: string
    publishedAt: Date
}

type RawItem = {
    title?: unknown
    link?: unknown
    description?: unknown
    pubDate?: unknown
}

type RawFeed = {
    rss?: {
        channel?: {
            item?: RawItem[]
        }
    }
}

const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    htmlEntities: true,
    trimValues: true,
    isArray: (_name, jpath) => jpath === 'rss.channel.item'
})

export function extractCommentId(link: string): string {
    const match = link.match(/[?&]comment=(\d+)/)

    return match ? match[1] : link
}

export function parseDevTrackerFeed(xml: string): DevTrackerItem[] {
    const feed = parser.parse(xml) as RawFeed
    const rawItems = feed.rss?.channel?.item ?? []

    const items: DevTrackerItem[] = []

    for (const raw of rawItems) {
        const link = String(raw.link ?? '').trim()

        if (!link || !URL.canParse(link)) continue

        const publishedAt = new Date(String(raw.pubDate ?? ''))

        items.push({
            id: extractCommentId(link),
            title: String(raw.title ?? '').trim() || 'SWTOR Dev Tracker',
            link,
            text: restoreParagraphs(String(raw.description ?? '')),
            publishedAt: Number.isNaN(publishedAt.getTime()) ? new Date() : publishedAt
        })
    }

    return items
}

export async function fetchDevTrackerFeed(url: string): Promise<DevTrackerItem[]> {
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'alfebot/1.0 (+https://github.com/)',
            'Accept': 'application/rss+xml, application/xml, text/xml'
        },
        signal: AbortSignal.timeout(30_000)
    })

    if (!response.ok) {
        throw new Error(`Лента вернула ${response.status} ${response.statusText}`)
    }

    return parseDevTrackerFeed(await response.text())
}

// В ленте переводы строк отсутствуют: форум схлопывает абзацы в подряд идущие пробелы.
function restoreParagraphs(text: string): string {
    return text.replace(/ {2,}/g, '\n\n').trim()
}
