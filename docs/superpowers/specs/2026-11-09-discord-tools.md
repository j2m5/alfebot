# Discord MCP tools

The user authorized all proposed tools and selected only Employee (`1242979048917831763`) for assignment/removal. Missing Discord permissions must yield an explanation; permissions are never granted automatically.

## Scope and architecture

Use the official MCP TypeScript SDK with a linked in-memory transport. Every conversational invocation gets its own MCP client/server session. The server binds immutable caller, guild, channel and request context from the Discord event. The model supplies only tool arguments, never authority. No listening HTTP port or new service is needed.

Keep existing flood memory, server directory, emoji behavior, `/play`, translation and the 28-second conversation deadline. Add tool calling to `/ask` and flood mentions/replies only. At most three model rounds, four tool calls and one mutation attempt per question; no automatic mutation replay. Preserve successful action receipts if the model times out afterwards. A failed or uncertain Discord request must never be reported as a confirmed success.

Implementation decision: after a mutating call, return the executor's receipt directly, including an explanation on denial. This avoids another model request after a side effect and prevents the model from contradicting the result. Read-tool results still return to the model normally.

## Tools

- `get_member`: optional user ID or a search query; no arguments means the current caller. Search results are bounded and ambiguity is shown.
- `list_roles`: current guild role IDs, names, positions and explicit permissions, bounded output with a completeness flag.
- `get_permissions`: current or specified guild channel and current or specified member; fresh effective channel permissions and bot permissions. Reject unsupported channel types instead of inventing access.
- `set_nickname`: explicit member and a nickname (1–32 characters), or null to clear.
- `set_timeout`: explicit member and integer minutes, 0 to clear, at most 40,320 (28 days).
- `delete_message`: one explicit message ID in the invocation channel, including a referenced message. No bulk deletion and no deleting the invocation itself.
- `set_member_role`: explicit member, Employee role ID only, boolean enabled.

## Authorization and effects

Validate every argument with strict schemas. Fetch roles, owner, caller, bot and relevant targets freshly for each execution. Verify channel belongs to bound guild and that caller and bot can view the invocation/target channel. Apply channel overwrites to message permissions. Check caller AND bot permission grants; owner bypasses caller hierarchy but never the bot's restrictions. Protect owner, equal/higher targets, managed roles and administrator targets for timeouts. Handle self-nickname permission explicitly. Do not equate Administrator with bypassing hierarchy.

Only a current explicit action request may authorize a mutation. Bind targets to mentions/IDs, the actual replied-to member/message, self-reference or an unambiguous literal target name in the current request. Historical chatter and tool results cannot request new actions. Permission checks stay in code regardless of prompt instructions. Restrict roles by the selected ID even after future Discord permission grants.

Abort before every Discord operation and before the final write; pass cancellation to REST. One mutation attempt consumes the allowance even on an uncertain network result. Audit tool name, actor, target/request IDs and outcome, excluding tokens and message content. No destructive live probes during deployment.

## Verification

Meaningful tests must exercise denied and allowed operations, spoofed caller/guild/extra arguments, channel overwrites, hierarchy, missing permissions, Employee allowlist, explicit request/target binding, cancellation during authorization, unknown write outcome and repeated calls. Exercise MCP transport, tool-call/result assembly, limits, partial output and reset cancellation. Run build/full suite once integrated and review authorization before deployment. Production checks use reads and denial paths only.
