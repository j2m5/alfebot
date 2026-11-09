import { REST, type RESTOptions } from 'discord.js'

export function createToolRest(token: string, makeRequest?: RESTOptions['makeRequest']): REST {
    return new REST({ version: '10', retries: 0, timeout: 5000,
        // retries: 0 covers network/5xx failures but not 429 or queued limits.
        // A write must never wait and replay after its authorization snapshot.
        rejectOnRateLimit: data => data.method !== 'GET',
        ...(makeRequest ? { makeRequest } : {}) }).setToken(token)
}
