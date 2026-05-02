<div align="center">
  <img src="kintsugi.png" alt="KintsugiBot" width="160" />
  <h1>KintsugiBot</h1>
  <p><strong>Autonomous bug-fixing bot for GitHub repositories.</strong></p>
  <p>KintsugiBot investigates issues, traces root causes, writes fixes, runs tests, and opens pull requests — automatically.</p>
  <br/>
  <a href="https://github.com/marketplace/kintsugibot"><img src="https://img.shields.io/badge/GitHub%20Marketplace-KintsugiBot-black?logo=github" alt="GitHub Marketplace"/></a>
</div>

---

## What it does

When an issue is opened on your repository, KintsugiBot:

1. **Classifies** the issue — skips feature requests and support questions automatically
2. **Investigates** — reads relevant files, traces imports, searches the codebase, checks git history
3. **Fixes** — edits code at the root cause, writes a regression test
4. **Verifies** — runs your existing test suite to confirm nothing is broken
5. **Opens a PR** — high-confidence fixes get a ready-to-merge PR; lower-confidence fixes get a draft for your review

If the issue is already resolved in the codebase, it posts a comment saying so and suggests closing it.

---

## Plans

| Plan | Price | Issues / month | Repos | Private repos |
|------|-------|----------------|-------|---------------|
| Free | $0 | 10 | Unlimited | Public only |
| Paid | $5 / month | 100 | Up to 10 | Yes |

---

## Installation

1. Install KintsugiBot from the [GitHub Marketplace](https://github.com/marketplace/kintsugibot)
2. Grant access to the repositories you want it to watch
3. Open (or re-open) an issue — KintsugiBot responds automatically

No configuration files or code changes needed. It auto-detects your language, runtime, and test framework.

---

## How it works

```
GitHub Issue opened
        │
        ▼
  Webhook Server
        │
        ▼
  BullMQ Queue ──► Redis
        │
        ▼
  Issue Worker
        │
        ├── LLM agent loop (up to 40 iterations)
        │         │
        │         ├── read_file, search_codebase, find_symbol ...
        │         ├── run_command, run_tests, get_diff ...
        │         └── patch_file, write_file, submit_fix ...
        │
        ├── E2B Cloud Sandbox (isolated, ephemeral)
        │
        └── GitHub API (PR creation, comments, CI checks)
```

All code execution happens in a secure, isolated cloud sandbox via [E2B](https://e2b.dev). The sandbox is destroyed immediately after each job — your code never persists outside the run.

---

## Confidence scoring

KintsugiBot won't open a PR unless it's confident the fix is correct:

| Score | Action |
|-------|--------|
| **≥ 85** | Opens a ready-to-merge PR, labeled `bot-fix` + `high-confidence` |
| **50–84** | Opens a draft PR for human review, labeled `bot-fix` |
| **< 50** | Posts a detailed analysis comment — no PR |

---

## Triggering the bot

KintsugiBot triggers on two events:

1. **Issue opened** — runs automatically on every new issue
2. **`bot-fix` label added** — re-triggers on an existing issue (useful after a failed run)

---

## Supported languages

| Language | Test runner |
|----------|-------------|
| Node.js / TypeScript | Jest, Vitest, Mocha |
| Python | pytest |
| Go | go test |
| Rust | cargo test |
| Ruby | RSpec |
| PHP | PHPUnit |
| Java | JUnit (Maven / Gradle) |
| .NET | dotnet test |
| Swift | swift test |
| Dart | dart test |
| Elixir | mix test |
| C / C++ | ctest / make test |

---

## Self-hosting

You can run KintsugiBot on your own infrastructure (Fly.io, Railway, etc.).

**Required environment variables:**

```env
LLM_API_KEY=                        # Any OpenAI-compatible key (DeepSeek, OpenAI, Groq, etc.)
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat

GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY_PATH=your-app.private-key.pem
WEBHOOK_SECRET=

REDIS_URL=redis://127.0.0.1:6379    # Upstash (rediss://) works too

E2B_API_KEY=                        # Free tier at e2b.dev
```

**Run:**

```bash
npm install
npm run build
npm start
```

---

## Security

- **Sandboxed execution** — all code runs in an isolated, ephemeral E2B cloud sandbox, never on the host
- **Command allowlist** — `run_command` only permits a specific set of binaries; anything else is blocked
- **Path traversal protection** — all file operations are validated to stay inside the repo root
- **Token isolation** — GitHub tokens are never written to disk or git config; only injected at push time
- **Prompt injection hardening** — issue bodies are sanitized before reaching the LLM

See [SECURITY.md](SECURITY.md) for our vulnerability disclosure policy or email [info@nvdyvette.com](mailto:info@nvdyvette.com).

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

[MIT](LICENSE)

---

<div align="center">
  <sub>A product of <strong>NVD Yvette</strong> · <a href="mailto:info@nvdyvette.com">info@nvdyvette.com</a> · <a href="SECURITY.md">Security Policy</a></sub>
</div>
