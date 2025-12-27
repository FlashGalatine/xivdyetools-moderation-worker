# XIV Dye Tools Moderation Worker

**v1.0.0** | Discord moderation bot for XIV Dye Tools Community Presets, running on Cloudflare Workers using HTTP Interactions.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.3%2B-blue)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020)](https://workers.cloudflare.com/)

## Overview

A dedicated moderation bot for the XIV Dye Tools Community Presets system. This worker handles moderation commands separately from the main Discord bot, allowing trusted moderators to review, approve, reject, and manage community-submitted preset palettes.

## Features

- **Preset Moderation** - Review pending presets, approve or reject with reasons
- **User Management** - Ban/unban users from the Preset Palettes system
- **Edit Reversion** - Revert flagged edits to previous versions
- **Multi-Language** - Full localization support (EN, JA, DE, FR, KO, ZH)
- **Audit Logging** - All moderation actions are logged for accountability
- **Secure** - Ed25519 signature verification for all Discord interactions
- **Serverless** - Runs on Cloudflare Workers edge network

## Commands

### Moderation Commands

| Command | Description |
|---------|-------------|
| `/preset moderate [preset_id]` | View pending presets and take moderation actions |
| `/preset ban_user <user>` | Ban a user from submitting/editing presets |
| `/preset unban_user <user>` | Remove a ban from a user |

### Moderation Actions

When moderating a preset, moderators can:
- **Approve** - Publish the preset to the community
- **Reject** - Reject with a reason (notifies the author)
- **Revert** - Restore a flagged edit to its previous version

## Tech Stack

- **Cloudflare Workers** - Serverless edge deployment
- **HTTP Interactions** - Discord's HTTP-based interaction model (no WebSocket)
- **Hono** - Lightweight web framework
- **Cloudflare D1** - Preset and moderation data storage
- **Cloudflare KV** - User preferences and rate limiting
- **TypeScript** - Type-safe development
- **@xivdyetools/logger** - Structured request logging
- **@xivdyetools/types** - Shared type definitions

## Development

### Prerequisites

- Node.js 18+
- Cloudflare account with Workers, D1, and KV access
- Discord application with bot

### Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy `.dev.vars.example` to `.dev.vars` and fill in your Discord credentials:
   ```bash
   cp .dev.vars.example .dev.vars
   ```

3. Start local development server:
   ```bash
   npm run dev
   ```

### Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start local development server |
| `npm run deploy` | Deploy to Cloudflare Workers |
| `npm run deploy:production` | Deploy to production environment |
| `npm run type-check` | Run TypeScript type checking |
| `npm run test` | Run tests |
| `npm run register-commands` | Register slash commands with Discord |

### Registering Commands

Set environment variables and run:

```powershell
# PowerShell
$env:DISCORD_TOKEN = "your-bot-token"
$env:DISCORD_CLIENT_ID = "your-client-id"
$env:DISCORD_GUILD_ID = "your-test-server-id"  # Optional, for faster testing
npm run register-commands
```

## Deployment

### First-time Setup

1. Create Cloudflare resources (or use existing ones from presets-api):
   ```bash
   # Create KV namespace
   wrangler kv namespace create "KV"
   ```

2. Update `wrangler.toml` with the created resource IDs

3. Set secrets:
   ```bash
   wrangler secret put DISCORD_TOKEN
   wrangler secret put DISCORD_PUBLIC_KEY
   wrangler secret put BOT_API_SECRET
   ```

4. Deploy:
   ```bash
   npm run deploy
   ```

5. Configure Discord:
   - Go to Discord Developer Portal
   - Set "Interactions Endpoint URL" to your Worker URL

## Architecture

```
Discord API
     │
     ▼ HTTP POST (Interactions)
┌─────────────────────────────────┐
│   Moderation Worker             │
│                                 │
│  ┌─────────────────────────┐   │
│  │  Ed25519 Verification    │   │
│  └─────────────────────────┘   │
│              │                  │
│              ▼                  │
│  ┌─────────────────────────┐   │
│  │  Hono Router             │   │
│  └─────────────────────────┘   │
│              │                  │
│    ┌─────────┼─────────┐       │
│    ▼         ▼         ▼       │
│  Commands  Buttons   Modals    │
│                                 │
└─────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│  Cloudflare Bindings            │
│  • D1 (presets, bans, logs)     │
│  • KV (user preferences)        │
└─────────────────────────────────┘
```

## Related Projects

- **[xivdyetools-discord-worker](https://github.com/FlashGalatine/xivdyetools-discord-worker)** - Main Discord bot with user-facing commands
- **[xivdyetools-presets-api](https://github.com/FlashGalatine/xivdyetools-presets-api)** - Community presets REST API
- **[xivdyetools-core](https://github.com/FlashGalatine/xivdyetools-core)** - Core color algorithms (npm package)
- **[XIV Dye Tools Web App](https://github.com/FlashGalatine/xivdyetools-web-app)** - Interactive web tools

## License

MIT © 2025 Flash Galatine

See [LICENSE](./LICENSE) for full details.

## Legal Notice

**This is a fan-made tool and is not affiliated with or endorsed by Square Enix Co., Ltd. FINAL FANTASY is a registered trademark of Square Enix Holdings Co., Ltd.**

## Connect With Me

**Flash Galatine** | Balmung (Crystal)

🎮 **FFXIV**: [Lodestone Character](https://na.finalfantasyxiv.com/lodestone/character/7677106/)
📝 **Blog**: [Project Galatine](https://blog.projectgalatine.com/)
💻 **GitHub**: [@FlashGalatine](https://github.com/FlashGalatine)
🐦 **X / Twitter**: [@AsheJunius](https://x.com/AsheJunius)
📺 **Twitch**: [flashgalatine](https://www.twitch.tv/flashgalatine)
🌐 **BlueSky**: [projectgalatine.com](https://bsky.app/profile/projectgalatine.com)
❤️ **Patreon**: [ProjectGalatine](https://patreon.com/ProjectGalatine)
☕ **Ko-Fi**: [flashgalatine](https://ko-fi.com/flashgalatine)
💬 **Discord**: [Join Server](https://discord.gg/5VUSKTZCe5)

## Support

- **Issues**: [GitHub Issues](https://github.com/FlashGalatine/xivdyetools-moderation-worker/issues)
- **Discord**: [Join Server](https://discord.gg/5VUSKTZCe5)

---

**Made with ❤️ for the FFXIV community**
