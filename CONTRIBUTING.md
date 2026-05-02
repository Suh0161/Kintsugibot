# Contributing to KintsugiBot

Thanks for your interest in contributing! All kinds of contributions are welcome — bug fixes, new features, new language support, better prompts, documentation, and tests.

---

## Before You Start

- **Bug fix or small improvement?** Just open a PR — no need to ask first.
- **New feature or larger change?** Open an issue first to discuss the approach. This avoids you spending time on something that might not fit the project direction.
- **Security vulnerability?** See [SECURITY.md](SECURITY.md) — do NOT open a public issue.

---

## Getting Started

1. **Fork** the repository and clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/kintsugibot
   cd kintsugibot
   ```

2. **Install** dependencies:
   ```bash
   npm install
   ```

3. **Build** the sandbox image:
   ```bash
   docker build -f docker/Dockerfile.sandbox -t issuebot-sandbox:latest .
   ```

4. **Start** Redis:
   ```bash
   docker compose up -d redis
   ```

5. **Copy** `.env.example` to `.env` and fill in your values:
   ```bash
   cp .env.example .env
   ```

---

## Development

```bash
npm run dev          # start with hot reload
npm run typecheck    # type-check without building
npm run build        # compile TypeScript to dist/
npm test             # run test suite (vitest)
npm run test:watch   # tests in watch mode
npm run smee         # forward GitHub webhooks to localhost (needs SMEE_URL in .env)
```

---

## Branch Naming

| Type | Pattern | Example |
|------|---------|---------|
| Bug fix | `fix/short-description` | `fix/sandbox-timeout` |
| New feature | `feat/short-description` | `feat/java-support` |
| Docs | `docs/short-description` | `docs/setup-guide` |
| Tests | `test/short-description` | `test/codeIntel-ranking` |
| Refactor | `refactor/short-description` | `refactor/executor-cleanup` |

---

## Pull Request Process

1. Create a branch from `main` using the naming convention above
2. Make your changes
3. Ensure `npm run typecheck` passes — no type errors
4. Ensure `npm test` passes — no broken tests
5. Add or update tests if your change affects logic
6. Write a clear PR description:
   - **What** does this change do?
   - **Why** is it needed?
   - **How** was it implemented? (for larger changes)
7. Link any related issues with `Closes #123` or `Relates to #123`

PRs that break tests or typecheck will not be merged.

---

## Code Style

- **TypeScript** strict mode — no `any` unless absolutely necessary
- **ESM modules** (`"type": "module"`) — use `.js` extensions in imports
- **No comments** unless the *why* is non-obvious (not the what — the code shows that)
- **Minimal changes** — don't refactor unrelated code in the same PR
- **No new dependencies** without discussion — keep the dependency footprint small

---

## Good Areas to Contribute

### New language support
Add formatters and test runners for languages not yet covered. Everything lives in [`src/sandbox/executor.ts`](src/sandbox/executor.ts):
- `detectRuntime()` — add detection logic for the new language
- `installDeps()` — add the install command
- `buildTestCommand()` — add the test runner command
- `formatCode()` — add the formatter command
- `analyzeCode()` — add the static analysis command

### Better LLM prompts
The system prompt is in [`src/agent/issueAgent.ts`](src/agent/issueAgent.ts). Improvements that make the agent more accurate, more concise, or better at specific bug types are very welcome.

### Code intelligence
[`src/agent/codeIntel.ts`](src/agent/codeIntel.ts) uses regex-based symbol detection. It currently misses:
- Arrow functions assigned to `const`
- Decorated classes/methods
- Monorepo/alias imports (non-relative paths)
- TypeScript generic type parameters

### Sandbox hardening
[`src/sandbox/executor.ts`](src/sandbox/executor.ts) and [`src/agent/tools.ts`](src/agent/tools.ts) — security improvements, better resource limits, capability dropping.

### Test coverage
More tests are always welcome, especially for:
- `executor.ts` — path validation edge cases
- `codeIntel.ts` — ranking algorithm correctness
- `actionDispatcher.ts` — PR creation logic
- `webhooks/github.ts` — webhook deduplication

### GitHub comment templates
[`src/github/messages.ts`](src/github/messages.ts) — better wording, more varied templates, improved formatting.

### Documentation
Clearer setup guides, architecture diagrams, deployment guides for specific platforms (Railway, Fly.io, Render, etc.).

---

## Questions?

Open a [GitHub Discussion](../../discussions) — happy to help!
