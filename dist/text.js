export function splitText(text, maxLength = 1900) {
    const limit = Math.max(1, maxLength);
    const chunks = [];
    let remaining = text.trim();
    while (remaining.length > limit) {
        let index = remaining.lastIndexOf('\n', limit);
        if (index < 1)
            index = remaining.lastIndexOf(' ', limit);
        if (index < 1)
            index = limit;
        chunks.push(remaining.slice(0, index).trim());
        remaining = remaining.slice(index).trim();
    }
    if (remaining)
        chunks.push(remaining);
    return chunks;
}
