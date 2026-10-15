// /ask ограничен по времени; переводчик использует отдельный запрос без усечения.
export async function streamAnswer(
    messages: readonly { role: string; content: string }[],
    signal: AbortSignal
): Promise<string> {
    let text = ''
    let shortened = false
    try {
        const response = await fetch(`${process.env.OLLAMA_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: process.env.OLLAMA_MODEL, messages,
                stream: true, think: false, options: { num_predict: 650 }
            }),
            signal
        })
        if (!response.ok) throw new Error(await response.text())
        if (!response.body) throw new Error('Ollama returned no response stream')

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let pending = ''
        let done = false
        function consume(line: string): void {
            if (!line.trim()) return
            const chunk = JSON.parse(line)
            if (chunk.error) throw new Error(chunk.error)
            if (typeof chunk.message?.content === 'string') text += chunk.message.content
            if (chunk.done) done = true
            if (chunk.done_reason === 'length') shortened = true
        }
        try {
            while (!done) {
                const chunk = await reader.read()
                pending += decoder.decode(chunk.value, { stream: !chunk.done })
                let newline: number
                while ((newline = pending.indexOf('\n')) >= 0) {
                    consume(pending.slice(0, newline))
                    pending = pending.slice(newline + 1)
                }
                if (chunk.done) {
                    consume(pending)
                    break
                }
            }
        } finally {
            await reader.cancel().catch(() => {})
            reader.releaseLock()
        }
    } catch (error) {
        if (!signal.aborted || !text.trim()) throw error
        shortened = true
    }
    const answer = text.trim()
    if (!answer) throw new Error('Ollama returned an empty answer')
    // Не показываем незаконченный код эмодзи, если дедлайн пришёл посреди него.
    return shortened ? answer.replace(/<[^>]*$/, '').trimEnd() + '\n\n…' : answer
}
