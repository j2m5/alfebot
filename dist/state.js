import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
export const MAX_STORED_IDS = 500;
export async function stateFileExists(filePath) {
    try {
        await access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
export async function loadPostedIds(filePath) {
    let raw;
    try {
        raw = await readFile(filePath, 'utf8');
    }
    catch {
        return [];
    }
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            console.warn('[devtracker] файл состояния не является массивом, начинаю с пустого списка');
            return [];
        }
        return parsed.filter((id) => typeof id === 'string');
    }
    catch {
        console.warn('[devtracker] файл состояния повреждён, начинаю с пустого списка');
        return [];
    }
}
export async function savePostedIds(filePath, ids) {
    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(ids.slice(-MAX_STORED_IDS)), 'utf8');
    await rename(tempPath, filePath);
}
