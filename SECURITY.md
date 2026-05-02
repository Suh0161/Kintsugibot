# Security Policy

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

Email us directly at **[info@nvdyvette.com](mailto:info@nvdyvette.com)** or use [GitHub's private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability) (enabled on this repo).

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We aim to respond within **48 hours** and will coordinate a fix with you before any public disclosure.

---

## Security Architecture

### Sandbox Isolation

All code execution happens inside an isolated, ephemeral [E2B](https://e2b.dev) cloud sandbox — never on the bot's host server:

- Fresh sandbox per job — no state carries over between issues
- Sandbox is destroyed immediately after the job completes
- Your repository code never persists outside the run

### Command Allowlist

The `run_command` tool uses an **allowlist** (not a denylist) of permitted binaries. Anything not on the list is blocked before reaching the sandbox. The list covers standard build tools, test runners, and formatters only.

Additional per-binary argument restrictions apply — for example, `git remote -v` is blocked to prevent credential leakage, and bare `env` dumps are blocked to prevent secret exposure.

### Path Traversal Protection

Every file operation (`read_file`, `write_file`, `patch_file`, etc.) resolves the path against the repo root and rejects anything that escapes it. Directory traversal attempts (e.g. `../../../etc/passwd`) are blocked at the code layer before any shell command is constructed.

### Prompt Injection Hardening

Issue body content is sanitized before being embedded in any LLM prompt:

- XML/HTML tags stripped (prevents escaping our delimiter wrappers)
- Common injection phrases (`ignore previous instructions`, `<<SYS>>`, `[INST]`, etc.) replaced with `[REDACTED]`
- User content wrapped in clearly labelled `=== BEGIN/END ===` blocks with an explicit security reminder to the LLM

### Token Isolation

The GitHub installation token is:

- Never stored in git config or on disk
- Stripped from the git remote immediately after cloning (remote URL replaced with tokenless HTTPS)
- Only injected inline at `git push` time via a transient push URL

### Structured Audit Logging

Every webhook delivery, tool call, and agent step is logged with structured fields (`reqId`, `deliveryId`, `issueNumber`, `jobId`, `tool`, `iteration`) for post-incident investigation.

---

## Known Limitations

- The LLM has shell access inside the sandbox. While commands are allowlisted, a sufficiently adversarial repository could attempt to influence the agent through crafted file content.
- **Do not install KintsugiBot on repositories containing plaintext secrets or sensitive credentials.**
- Always review bot-opened PRs before merging.

---

## Contact

Security issues: [info@nvdyvette.com](mailto:info@nvdyvette.com)

KintsugiBot is a product of **NVD Yvette**.
