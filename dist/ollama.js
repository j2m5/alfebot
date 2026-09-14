import { splitText } from './text.js';
const TRANSLATION_CHUNK_SIZE = 3000;
const TRANSLATION_SYSTEM_PROMPT = [
    'Ты профессиональный переводчик. Переводи текст с английского на русский.',
    'Сохраняй разбиение на абзацы.',
    'Не переводи имена собственные и игровые термины Star Wars: The Old Republic:',
    'названия классов, дисциплин, планет, способностей и предметов оставляй как в оригинале.',
    'Ничего не добавляй от себя, не комментируй и не сокращай.',
    'В ответе верни только перевод.'
].join(' ');
async function chatOllama(messages, timeoutMs, numCtx) {
    const baseUrl = process.env.OLLAMA_URL;
    const model = process.env.OLLAMA_MODEL;
    const response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            messages,
            stream: false,
            ...(numCtx ? { options: { num_ctx: numCtx } } : {})
        }),
        signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText);
    }
    const data = await response.json();
    return data.message.content.trim();
}
export async function askOllama(prompt) {
    return chatOllama([
        {
            role: 'system',
            content: 'Ты полезный ассистент в Discord. Отвечай по русски. Отвечай понятно и без лишней воды. ' + process.env.OLLAMA_SYSTEM_PROMPT_SECRET_PART,
        },
        {
            role: 'user',
            content: prompt
        }
    ], 120_000);
}
export async function translateToRussian(text) {
    const parts = splitText(text, TRANSLATION_CHUNK_SIZE);
    const translated = [];
    for (const part of parts) {
        translated.push(await chatOllama([
            {
                role: 'system',
                content: TRANSLATION_SYSTEM_PROMPT
            },
            {
                role: 'user',
                content: part
            }
        ], 240_000, 8192));
    }
    return translated.join('\n\n');
}
