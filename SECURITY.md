# Security Policy

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

Use [GitHub's private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability) instead (enabled on this repo), or email the maintainers directly.

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We aim to respond within **48 hours** and will work with you to validate and patch before any public disclosure.

---

## Security Architecture

### Sandbox Isolation

All code execution happens inside a Docker container — never on the host:

- Separate filesystem namespace (`/repo` mount only)
- Memory hard-capped at 2 GB (`Memory` limit)
- CPU capped at 2 cores (`CpuQuota`)
- Container auto-removed after each job

### Command Allowlist

The `run_command` tool uses an **allowlist** (not denylist) of permitted binaries. Anything not on the list is blocked before reaching the sandbox. The list covers standard build tools, test runners, and formatters — not network tools, package managers with arbitrary scripts, or system utilities.

Additional per-binary argument restrictions apply (e.g. `git remote -v` blocked, bare `env` dump blocked).

### Path Traversal Protection

Every file operation (`read_file`, `write_file`, `patch_file`, etc.) resolves the path against `/repo` and rejects anything that escapes it. `../../../etc/passwd` style traversal is blocked at the TypeScript layer before any shell command is constructed.

### Prompt Injection Hardening

Issue body content is sanitized before being embedded in any LLM prompt:
- XML/HTML tags stripped (prevents closing our delimiter tags)
- Common injection phrases (`ignore previous instructions`, `<<SYS>>`, `[INST]`, etc.) replaced with `[REDACTED]`
- User content wrapped in clearly labelled `=== BEGIN/END ===` blocks with an explicit security reminder to the LLM

### Token Isolation

The GitHub installation token is:
- Never stored in git config
- Stripped from `git remote -v` immediately after clone (remote URL replaced with tokenless HTTPS)
- Only injected inline at `git push` time, never written to disk

### Structured Audit Logging

Every webhook delivery, tool call, and agent step is logged with structured fields (`reqId`, `deliveryId`, `issueNumber`, `jobId`, `tool`, `iteration`) for post-incident investigation.

---

## Known Limitations

- Docker provides namespace isolation, not hypervisor-level isolation. A container escape vulnerability in Docker itself could affect the host. For multi-tenant hosted deployments, use a VM-isolated sandbox (e.g. Firecracker/gVisor) instead.
- The LLM has shell access inside the container. While commands are allowlisted, a sufficiently adversarial repository could attempt to subvert the agent through crafted file content.
- **Do not install KintsugiBot on repositories containing secrets, credentials, or sensitive data in plaintext.**
- Always review bot-opened PRs before merging.
