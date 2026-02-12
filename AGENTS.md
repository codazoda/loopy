# Repository Guidelines

## Project Structure & Module Organization
- `loopy.js` is the main Node.js loop that drives the conversation and tool execution.
- `persona/` holds persona prompt files (`*.txt`) with optional frontmatter for tool access.
- `context/` holds shared context injected into prompts (e.g., `context/plan.txt` when created).
- `seed*.txt` files provide alternate starting prompts; `seed.txt` is the default.
- `conversation.json` is the rolling window; `conversation.log` is the full history.
- `test-*.js` scripts are lightweight health checks and diagnostics.
- Docs: `README.md`, `CLAUDE.md`, `TESTING.md`, and setup guides like `PUSHOVER-SETUP.md`.

## Build, Test, and Development Commands
- `node loopy.js` runs the loop (requires Ollama on `http://127.0.0.1:11434`).
- `tail -f conversation.log` streams live output.
- `node -c loopy.js` validates syntax.
- `node test-conversation-health.js` analyzes loop health (speaker variety, repetition).
- `node test-model-detection.js` checks Ollama model discovery.
- `node test-env.js` verifies environment configuration.
- `./reset.sh` clears conversation state and `context/plan.txt`.

## Coding Style & Naming Conventions
- Use ES modules (`import`/`export`) and Node 18+ APIs.
- Follow the existing 2-space indentation and single-quote string style in `loopy.js`.
- Keep functions small and readable; prefer `const` with explicit names.
- Persona files live in `persona/` and should be lowercase (e.g., `moderator.txt`).

## Testing Guidelines
- There is no test runner; use the `test-*.js` scripts for checks.
- Test scripts are run directly with Node (example: `node test-env.js`).
- For behavioral checks, follow `TESTING.md` and inspect `conversation.log` outputs.

## Commit & Pull Request Guidelines
- Recent commits use short, imperative, lowercase subjects (e.g., "adjust conversation flow").
- Keep commits focused and descriptive; avoid multi-topic changes.
- PRs should include a brief summary, the commands used to validate, and any log excerpts that demonstrate behavior changes.

## Configuration & Agent Notes
- Configuration is via env vars or `.env`. See `CLAUDE.md` for the full list and defaults.
- Tool calling and plan updates are implemented in `loopy.js`; ensure new tools are added to the `TOOLS` registry and enabled in persona frontmatter.
