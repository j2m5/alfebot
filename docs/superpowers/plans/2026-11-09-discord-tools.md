# Discord MCP Tools Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for integration and superpowers:dispatching-parallel-agents for the independent Discord backend. Keep each worker's file scope separate.

**Goal:** Let the bot read Discord data and carry out the user's authorized moderation requests through MCP tools.

**Architecture:** A per-question in-memory MCP session binds trusted Discord context to a permission-checking backend. A bounded OpenRouter loop passes native tool calls/results and preserves confirmed action receipts on timeout.

**Tech Stack:** TypeScript, discord.js 14, Node 22, official MCP SDK 1.32.2, Zod 4, OpenRouter tool calling.

**Spec:** `docs/superpowers/specs/2026-11-09-discord-tools.md`

## Global constraints

- Employee allowlist: `1242979048917831763` only.
- 28-second shared deadline; at most three model rounds, four tool calls, one mutation attempt.
- Caller/guild/channel originate from Discord events and are never model arguments.
- Existing deployed behavior stays available; no live destructive tests and no automatic privilege grants.
- User normally requests commit/push after testing; leave implementation uncommitted until that request.

## Review focus

- A privileged caller's ordinary question must not authorize a write from poisoned history/tool output.
- Losing permission while waiting for Discord must prevent a later write.
- A reset during authorization must cancel the pending tool before its side effect.
- A mutation that completes before a model timeout must receive a truthful receipt.
- Ambiguous member names and links to other guilds/channels must not silently select another target.

## Task 1: Discord backend

Files: `src/discord-tools.ts`, `test/discord-tools.test.ts`; shared contract: `src/tool-types.ts`.

Interface: `createDiscordTools(context: DiscordToolContext): ToolBackend`. `definitions` contains the seven names and strict JSON schemas; `execute(name,args,signal)` validates, authorizes, performs REST work and returns `ToolOutcome`.

- [x] Start with a denial test: caller lacks ModerateMembers while bot has it; `set_timeout` returns `ok:false`, REST patch count stays zero.
- [x] Add positive fake-REST tests for nickname, timeout/clear, one-message deletion and Employee add/remove, asserting exact routes/payloads after fresh authorization.
- [x] Add spoofing, hierarchy, channel deny, wrong guild, allowlist, abort and one-attempt tests from the spec.
- [x] Implement bounded reads and the permission/intent checks with sanitized outcomes and action audit entries.
- [x] Run `node --import tsx --test test/discord-tools.test.ts` and review actual REST call sequences.

## Task 2: MCP and model loop

Files: `src/mcp-tools.ts`, `src/llm-agent.ts`, `src/openrouter.ts`, `test/mcp-tools.test.ts`, `test/llm-agent.test.ts`.

Interfaces: `createToolSession(backend: ToolBackend, signal: AbortSignal): Promise<ToolSession>`; `streamTurn(messages,signal,tools?)` collects content plus native tool calls; `runToolConversation(messages,session,signal)` owns the bounded loop.

- [x] Drive a real MCP linked transport with a fake backend; list tools and call one, checking arguments and result roundtrip. Verify caller fields cannot be supplied as authority.
- [x] Drive streamed OpenRouter fixtures: tool call first, tool result passed back, final text returned. Ensure speculative pre-tool text is discarded.
- [x] Exercise max calls/rounds, duplicate mutations, malformed calls, mid-stream abort and confirmed/uncertain action receipts after model failure.
- [x] Keep `streamAnswer` as a compatible wrapper for existing non-tool callers and tests.

## Task 3: Conversation integration

Files: `src/llm.ts`, `src/index.ts`, `src/flood-chat.ts`, `test/flood-chat.test.ts`, `package.json`, `docs/flood-chat.md`.

- [x] Add optional trusted tool context to `askModel`; lazily create/close MCP only for guild chat style.
- [x] Bind actual Discord author/guild/channel/request and reply IDs at all three conversational entry points. Use a REST client with automatic network retries disabled for mutation execution.
- [x] Replace the obsolete prompt statement that the bot cannot act with exact tool-use rules; retain role-topic restraint and humor.
- [x] Test reset cancellation during tool authorization and ensure play/translation/DM lack mutation tools.
- [x] Update user-facing docs with examples, permissions and limits.

## Task 4: Verification and deployment

- [x] Run `npm run build`, `npm test`, `git diff --check` after integration.
- [x] Get an independent review of trusted context, permissions, action binding, cancellation and model-loop limits; fix findings and run affected checks.
- [x] Back up production image/source, upload explicit changed files and rebuild/restart Docker using a detached job.
- [x] Check running version/logs, perform real model read-only tool calls and denied-action probes, and preserve existing memory volume.

## Execution evidence — 2026-11-09

- Full suite: 172 tests passed; TypeScript build and diff whitespace check passed.
- Independent security review found four issues (nickname target/payload swap, deletion during reference lookup, fractional duration parsing, incomplete model confirmation). All were reproduced with failing regression tests, fixed, and cleared by follow-up review.
- Production Node 22 MCP probes read a member, roles and effective permissions; Employee assignment was denied for missing bot ManageRoles and a different role was rejected. The probe blocked all REST mutations and recorded zero attempts.
- The real model invoked get_permissions and answered in 5.082 seconds.
- Active container started at 2026-11-09T17:29:06Z with zero restarts; existing docker_alfebot-data volume retained and memory loaded.
- Image: docker-alfebot:latest, sha256:7de48ab0d0b19cce36c086c6df8b82a4c4dca6ac028a454508e2a8277fcb5b10.
- Rollback image: docker-alfebot:before-mcp-20261109T172651Z.
- Source backup: /root/alfebot-mcp-20261109T172651Z-backup.tar.gz (environment and memory volume remain separate).
- Changes intentionally remain uncommitted for the user's live testing.