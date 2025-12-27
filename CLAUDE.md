# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Discord moderation bot for XIV Dye Tools Community Presets, running on Cloudflare Workers using HTTP Interactions (not WebSocket). This is a separate bot from the main xivdyetools-discord-worker and handles moderation commands only.

## Common Commands

```bash
npm run dev                    # Start local development server (wrangler dev)
npm run deploy                 # Deploy to Cloudflare Workers
npm run deploy:production      # Deploy to production environment
npm run test                   # Run tests (vitest)
npm run type-check             # TypeScript type checking
npm run register-commands      # Register slash commands with Discord API
```

### Registering Commands (PowerShell)
```powershell
$env:DISCORD_TOKEN = "your-bot-token"
$env:DISCORD_CLIENT_ID = "your-client-id"
$env:DISCORD_GUILD_ID = "guild-id"  # Optional - for faster testing
npm run register-commands
```

### Setting Secrets
```bash
wrangler secret put DISCORD_TOKEN
wrangler secret put DISCORD_PUBLIC_KEY
wrangler secret put BOT_API_SECRET
wrangler secret put MODERATOR_IDS         # Comma-separated Discord user IDs
wrangler secret put MODERATION_CHANNEL_ID
```

## Architecture

### Entry Point
[src/index.ts](src/index.ts) - Hono app that handles Discord HTTP Interactions:
1. Ed25519 signature verification
2. Routes by interaction type: commands, autocomplete, buttons, modals
3. All responses are ephemeral by default

### Handler Organization
- `handlers/commands/` - Slash command handlers (currently only `/preset`)
- `handlers/buttons/` - Button interaction handlers (preset moderation actions, ban confirmations)
- `handlers/modals/` - Modal submission handlers (rejection reasons, ban reasons, revert reasons)

### Services
- `services/ban-service.ts` - User ban/unban operations via D1 database
- `services/preset-api.ts` - Communication with xivdyetools-presets-api worker
- `services/i18n.ts` - Locale resolution (user preference → Discord locale → 'en')
- `services/bot-i18n.ts` - Translation functions for bot responses

### Cloudflare Bindings
Defined in [src/types/env.ts](src/types/env.ts):
- `DB` (D1Database) - Preset and moderation data storage
- `KV` (KVNamespace) - User preferences (shared with main discord-worker)
- `PRESETS_API` (Fetcher) - Service binding for Worker-to-Worker communication

### Interaction Flow
```
Discord → POST / → verifyDiscordRequest → route by type → handler → Response.json()
```

For long operations, handlers use `ctx.waitUntil()` with deferred responses.

## Key Patterns

### Response Helpers
Use functions from `utils/response.ts`:
- `ephemeralResponse(content)` - Ephemeral text response
- `deferredResponse()` - Deferred response for long operations
- `pongResponse()` - Discord PING acknowledgment

### Moderation Authorization
Moderator IDs are stored in `MODERATOR_IDS` secret (comma-separated). Check authorization before any moderation action.

### Localization
Supports: en, ja, de, fr, ko, zh. Locale resolution order:
1. User preference (stored in KV)
2. Discord client locale
3. Default to 'en'

## Related Projects
- xivdyetools-discord-worker - Main Discord bot (user-facing commands)
- xivdyetools-presets-api - Community presets REST API
- @xivdyetools/types - Shared type definitions
- @xivdyetools/logger - Structured request logging
