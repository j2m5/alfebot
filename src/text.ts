export function splitText(text: string, maxLength = 1900): string[] {
    const chunks: string[] = []

    let remaining = text.trim()

    while (remaining.length > maxLength) {
        let index = remaining.lastIndexOf('\n', maxLength)

        if (index < 1) index = remaining.lastIndexOf(' ', maxLength)

        if (index < 1) index = maxLength

        chunks.push(remaining.slice(0, index).trim())

        remaining = remaining.slice(index).trim()
    }

    if (remaining) chunks.push(remaining)

    return chunks
}
