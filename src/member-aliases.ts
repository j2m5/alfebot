export type MemberAlias = { userId: string; names: readonly string[] }

// Server shorthand agreed with the owner: prefer Broromir's primary account.
export const SERVER_MEMBER_ALIASES: readonly MemberAlias[] = [
    { userId: '804297985147404328', names: ['начальник', 'начальника', 'начальнику', 'начальником', 'начальнике'] }
]
