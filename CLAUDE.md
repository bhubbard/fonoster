# CLAUDE.md - Fonoster Cloudflare (`fonoster-cf`)

Fonoster on Cloudflare is an edge-native port of [Fonoster](https://github.com/fonoster/fonoster), the open-source alternative to Twilio and CPaaS.

Instead of running Asterisk, PostgreSQL, InfluxDB, and NATS in containers, `fonoster-cf` runs 100% natively on Cloudflare serverless edge primitives.

## Architecture & Primitives
- **Compute & Routing**: Cloudflare Workers (`cloudflare/src/worker.ts`)
- **Metadata & Relational Storage**: Cloudflare D1 SQLite (`cloudflare/migrations/`)
- **Live Call State & Coordination**: Cloudflare Durable Objects (`CallSessionDO`, `SipRegistrarDO`)
- **Media & Softphones**: Cloudflare Calls (WebRTC SFU) + Workers WebSockets
- **Audio Recordings & Prompts**: Cloudflare R2 (`RECORDINGS_BUCKET`, `MEDIA_BUCKET`)
- **CDRs & Asynchronous Tasks**: Cloudflare Queues (`CDRS_QUEUE`)
- **Speech Recognition (STT) & AI**: Cloudflare Workers AI (`@cf/openai/whisper`, `@cf/meta/llama-3.3-70b-instruct`)
- **Edge Cache & Sessions**: Cloudflare KV (`FONOSTER_KV`)

## Commands
```bash
# Start local emulation with Wrangler
wrangler dev

# Apply D1 database migrations locally
wrangler d1 migrations apply DB --local

# Apply D1 database migrations to remote production
wrangler d1 migrations apply DB --remote

# Deploy to Cloudflare
wrangler deploy
```
