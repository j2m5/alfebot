type OllamaChatResponse = {
    message: {
        role: 'assistant',
        content: string
    }
}

export async function askOllama(prompt: string): Promise<string> {
    const baseUrl = process.env.OLLAMA_URL
    const model = process.env.OLLAMA_MODEL

    const response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            messages: [
                {
                    role: 'system',
                    content: 'Ты полезный ассистент в Discord. Отвечай по русски. Отвечай понятно и без лишней воды. ' + process.env.OLLAMA_SYSTEM_PROMPT_SECRET_PART,
                },
                {
                    role: 'user',
                    content: prompt
                }
            ],
            stream: false
        }),
        signal: AbortSignal.timeout(120_000)
    })

    if (!response.ok) {
        const errorText = await response.text()

        throw new Error(errorText)
    }

    const data = await response.json() as OllamaChatResponse

    return data.message.content.trim()
}