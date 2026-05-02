# KintsugiBot

> An autonomous AI engineer that investigates GitHub issues and opens pull requests.

When an issue is opened in your repository, KintsugiBot:

1. **Classifies** the issue — bug, feature request, question, or docs
2. **Spins up** an isolated Docker sandbox with a full clone of your repo
3. **Investigates** using a persistent shell, codebase search, git history, and static analysis
4. **Fixes** the root cause with targeted code changes
5. **Verifies** by running your existing test suite
6. **Opens a PR** with a clear What / Why / How description — or posts a detailed analysis comment if it can't fully fix it

If the issue is a feature request or question, it posts a polite skip comment instead.

---

## How it works

```
GitHub Issue
     │
     ▼
Express Webhook Server
     │
     ▼
BullMQ Queue  ──► Redis
     │
     ▼
Issue Worker
     │
     ├── DeepSeek LLM (tool loop, up to 40 iterations)
     │        │
     │        ├── read_file, search_codebase, find_symbol ...
     │        ├── run_command, run_tests, get_diff ...
     │        └── patch_file, write_file, submit_fix ...
     │
     ├── Docker Sandbox  (isolated /repo clone)
     │
     └── GitHub API  (PR creation, issue comments, CI checks)
```

---

## Quick Start

### Prerequisites

- Node.js 20+
- Docker
- Redis (or `docker compose up -d redis`)
- A [DeepSeek](https://platform.deepseek.com) API key (or any OpenAI-compatible endpoint)
- A GitHub App (see setup below)

### 1. Clone and install

```bash
git clone https://github.com/your-org/kintsugibot
cd kintsugibot
npm install
```

### 2. Build the sandbox image

```bash
docker build -f docker/Dockerfile.sandbox -t issuebot-sandbox:latest .
```

### 3. Start Redis

```bash
docker compose up -d redis
```

### 4. Configure environment

```bash
cp .env.example .env
# Edit .env with your API keys and GitHub App credentials
```

### 5. Run

```bash
npm run dev        # development (hot reload)
npm start          # production
```

---

## GitHub App Setup

KintsugiBot runs as a GitHub App — this gives it scoped access to only the repositories you install it on.

### Create the App

1. Go to **github.com/settings/apps** → **New GitHub App**
2. Set the webhook URL to your server's `/webhook` endpoint (use [smee.io](https://smee.io) or [ngrok](https://ngrok.com) for local dev)
3. Set a **Webhook secret** — copy this to `WEBHOOK_SECRET` in your `.env`

### Required Permissions

| Permission | Access |
|------------|--------|
| Issues | Read & Write |
| Pull requests | Read & Write |
| Contents | Read & Write |
| Metadata | Read-only |
| Checks | Read-only |

### Webhook Events

Subscribe to: **Issues** (`opened`, `labeled`)

### Get credentials

After creating the App:
- Copy the **App ID** → `GITHUB_APP_ID`
- Generate a **Private key** → save the `.pem` file, set `GITHUB_APP_PRIVATE_KEY_PATH`

### Install on a repository

Go to your App's settings → **Install App** → choose which repositories to enable it on.

---

## Configuration

All configuration is via environment variables. Copy `.env.example` to `.env` and fill in:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LLM_API_KEY` | ✅ | — | API key for DeepSeek (or other OpenAI-compatible provider) |
| `LLM_BASE_URL` | — | `https://api.deepseek.com` | LLM endpoint base URL |
| `LLM_MODEL` | — | `deepseek-chat` | Model name |
| `GITHUB_APP_ID` | ✅ | — | GitHub App ID (numeric) |
| `GITHUB_APP_PRIVATE_KEY_PATH` | ✅* | — | Path to the `.pem` private key file |
| `GITHUB_APP_PRIVATE_KEY` | ✅* | — | Inline PEM key (alternative to `_PATH`) |
| `WEBHOOK_SECRET` | ✅ | — | GitHub webhook signing secret |
| `REDIS_URL` | ✅ | `redis://127.0.0.1:6379` | Redis connection string |
| `PORT` | — | `3000` | HTTP server port |
| `RUN_MODE` | — | `both` | `both`, `api`, or `worker` |
| `WORKER_CONCURRENCY` | — | `2` | Number of issues processed in parallel |
| `BOT_NAME` | — | `KintsugiBot` | Display name used in comments and PR signatures |
| `BOT_GIT_EMAIL` | — | `kintsugibot@users.noreply.github.com` | Git author email for commits |
| `BOT_BRANCH_PREFIX` | — | `kintsugi` | Branch name prefix (e.g. `kintsugi/fix-issue-123`) |
| `LOG_LEVEL` | — | `info` | Pino log level (`debug`, `info`, `warn`, `error`) |

*One of `GITHUB_APP_PRIVATE_KEY_PATH` or `GITHUB_APP_PRIVATE_KEY` is required.

### Using a different LLM

KintsugiBot uses the OpenAI SDK internally. Any OpenAI-compatible endpoint works:

```env
# OpenAI
LLM_API_KEY=sk-...
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o

# Groq
LLM_API_KEY=gsk_...
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_MODEL=llama-3.3-70b-versatile

# Local (Ollama)
LLM_API_KEY=ollama
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=qwen2.5-coder:32b
```

---

## Confidence Scoring

KintsugiBot won't open a PR unless it's confident the fix is correct:

| Score | Action |
|-------|--------|
| **≥ 85** | Opens a real PR, labeled `bot-fix` + `high-confidence` |
| **50–84** | Opens a draft PR for human review, labeled `bot-fix` |
| **< 50** | Posts an analysis comment with findings, no PR |

Score is computed from:

| Factor | Points |
|--------|--------|
| All tests pass | +40 |
| Issue reproduced before fix AND resolved after | +30 |
| No regressions | +20 |
| Related open PR found | +10 |

---

## Triggering the bot

KintsugiBot triggers on two events:

1. **Issue opened** — automatically runs on every new issue
2. **`bot-fix` label added** — lets you manually re-trigger on an existing issue (useful after a failed run)

To skip a specific issue, close it or remove the label before the job processes.

---

## Running in production

### Split mode (recommended)

Run the API server and worker on separate processes/machines:

```bash
# API server only (receives webhooks)
RUN_MODE=api npm start

# Worker only (processes jobs)
RUN_MODE=worker npm start
```

### Docker Compose (full stack)

```yaml
services:
  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data

  api:
    build: .
    environment:
      RUN_MODE: api
      REDIS_URL: redis://redis:6379
    env_file: .env
    ports:
      - "3000:3000"
    depends_on: [redis]

  worker:
    build: .
    environment:
      RUN_MODE: worker
      REDIS_URL: redis://redis:6379
    env_file: .env
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    depends_on: [redis]

volumes:
  redis-data:
```

> The worker needs access to the Docker socket to spin up sandbox containers.

### Health check

```
GET /health
→ { "ok": true, "webhook": "enabled" }
```

---

## Development

```bash
# Start with hot reload
npm run dev

# Type-check only (no emit)
npm run typecheck

# Run tests
npm test

# Watch mode tests
npm run test:watch

# Forward GitHub webhooks to localhost (smee)
SMEE_URL=https://smee.io/your-channel npm run smee
```

---

## Security

- **Sandbox isolation** — all code execution runs inside a Docker container, never on the host
- **Allowlist command filtering** — `run_command` only allows a specific set of binaries; anything else is blocked
- **Path traversal protection** — all file operations are validated to stay inside `/repo`
- **Token isolation** — GitHub tokens are scrubbed from git remotes and only injected at push time
- **Prompt injection hardening** — issue body is sanitized (XML tags stripped, injection phrases redacted) before reaching the LLM
- **Resource limits** — sandbox memory capped at 2 GB; file writes capped at 1 MB

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

[MIT](LICENSE)
