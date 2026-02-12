# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Loopy is a Node.js application that creates a continuous AI conversation loop using Ollama. Multiple personas take turns responding to a rolling conversation, with each persona having distinct characteristics and optional tool-calling capabilities.

## Running the Application

**Start the loop:**
```bash
node loopy.js
```

**Watch live conversation output:**
```bash
tail -f conversation.log
```

**Optional text-to-speech (macOS):**
```bash
node loopy.js | say -v Samantha -r 180
```

## Configuration

All configuration is via environment variables. You can either:
1. Set them in your shell: `export OLLAMA_MODEL=llama3.2:latest`
2. Create a `.env` file in the project root (automatically loaded on startup)

**Environment variables:**
- `OLLAMA_HOST` - Ollama server URL (default: `http://127.0.0.1:11434`)
- `OLLAMA_MODEL` - Model to use (default: auto-detected, prefers `llama3.2:1b`)
- `CONVO_FILE` - Rolling conversation file (default: `conversation.json`)
- `CONVO_LOG` - Full conversation history (default: `conversation.log`)
- `SYSTEM_FILE` - System instructions (default: `system.txt`)
- `SEED_FILE` - Initial conversation prompt (default: `seed.txt`)
- `PERSONA_DIR` - Directory containing persona files (default: `persona/`)
- `SLEEP_MS` - Delay between turns in milliseconds (default: `5000`)
- `KEEP_CYCLES` - Persona cycles kept in `conversation.json` (default: `6`; total persona turns kept = `KEEP_CYCLES x persona_count`)
- `WORKFLOW_ENABLED` - Enable staged workflow directives and state transitions (default: `true`)
- `WORKFLOW_CYCLE_WINDOW` - Number of full persona cycles between workflow evaluations (default: `3`)
- `WORKFLOW_FILE` - Flat workflow steps file path (default: `workflow`)
- `WORKFLOW_STATE_FILE` - Workflow state JSON path (default: `context/workflow_state.json`)
- `MODERATOR_STRICT_MODE` - Enforce moderator as process-only; invalid moderator outputs become `NO_INTERVENTION` (default: `true`)
- `DISCARD_MODE` - Response validation policy (default: `transcript_only`, rejects transcript-style multi-speaker output)
- `ADVISOR_FILE` - Human advisor narrator message file (default: `advisor.txt`)
- `ADVISOR_INTERVAL_MS` - Milliseconds between advisor availability notices (default: `14400000` = 4 hours)
- `ADVISOR_LOG` - Log file for turns mentioning "Advisor" (default: `advisor.log`)
- `CONTEXT_DIR` - Directory containing context files injected into system prompts (default: `context/`)
- `PUSHOVER_TOKEN` - Pushover app API token for notifications (required for pushover.notify tool)
- `PUSHOVER_USER` - Pushover user/group key for notifications (required for pushover.notify tool)

**Using .env file (recommended):**
```bash
# Copy example and edit
cp .env.example .env
# Edit .env with your values
# Then just run:
node loopy.js
```

**Using shell environment variables:**
```bash
OLLAMA_MODEL=llama3.2:latest KEEP_CYCLES=8 SLEEP_MS=5000 node loopy.js
```

Note: Shell environment variables take precedence over .env file values.

## Architecture

### Core Loop Flow

1. **Initialization**: Shuffles persona files from `persona/` directory
2. **Main Loop**: Infinite loop where each iteration:
   - Loads `system.txt` for conversation style instructions
   - Loads `conversation.json` (or seeds from `seed.txt` if empty)
   - Checks if advisor interval has elapsed and injects narrator message if needed
   - Selects next persona in rotation
   - Parses persona file (frontmatter config + persona description)
   - Loads all `.txt` files from `context/` directory and injects into system prompt as labeled blocks (e.g., `[plan]`)
   - Sends chat request to Ollama with system prompt (persona + system + context blocks) and user prompt (conversation history)
   - Streams response with speaker prefix (e.g., `**Kane**:`)
   - Appends response to both `conversation.json` and `conversation.log`
   - Logs tool calls if present and executes built-in tools via the TOOLS registry
   - Logs turns mentioning "Advisor" to `advisor.log` with timestamp
   - Trims `conversation.json` to the last `KEEP_CYCLES x persona_count` persona turns
   - Sleeps for SLEEP_MS before next turn

### Key Components

**Persona Files** (`persona/*.txt`):
- Support YAML-like frontmatter for configuration (delimited by `---`)
- Frontmatter can enable built-in tools by name in a `tools` array (e.g., `tools: [plan.update]`)
- Optionally set `tool_choice` for Ollama tool calling (use sparingly)
- Body contains persona description/instructions
- Example: `blackwell.txt` (team secretary/planner) enables `plan.update` to maintain `context/plan.txt`

**Frontmatter Parser** (`parseFrontmatter`):
- Custom parser supporting nested objects, arrays, and scalar values
- Uses indentation to determine structure
- Handles lists with `- ` prefix
- Returns `{ config, body }` object

**Conversation Files**:
- `conversation.json` - Rolling window of recent turns (limited by `KEEP_CYCLES x persona_count` persona turns)
- `conversation.log` - Complete history including tool calls
- Turns separated by `\n\n---\n\n`
- Speaker names formatted as `**Name**:\n\n`

**Seed Files**:
- Various `seed.*.txt` files provide different conversation starters
- `seed.txt` is the default, but can be changed via SEED_FILE env var

### Built-in Tools Registry

loopy.js defines a `TOOLS` object mapping tool names to their schema and execution logic:
- Each tool has a `schema` (Ollama/OpenAI function calling format) and an `execute` function
- Personas enable tools by listing names in frontmatter: `tools: [plan.update]`
- loopy.js maps these names to schemas for the Ollama payload
- After streaming, loopy.js executes recognized tool calls via the registry
- Unrecognized tool calls (hallucinated or not in registry) are silently ignored

**Current built-in tools:**
- `plan.update`: Updates `context/plan.txt` by delegating to `copilot -p` CLI for formatting. Takes a short natural language instruction (e.g., "Add that we're targeting students") and rewrites the entire plan as clean markdown incorporating the change. If `copilot` command is unavailable, the update is skipped and the existing plan remains unchanged.
- `pushover.notify`: Sends push notifications to the human advisor via Pushover API. Takes a message and optional title. Only enabled for secretary.txt persona. Requires `PUSHOVER_TOKEN` and `PUSHOVER_USER` environment variables to be set.

### Tool Calling

The system supports Ollama tool calling:
- Personas enable tools by name in frontmatter (e.g., `tools: [plan.update]`)
- Tool schemas and execution logic live in loopy.js's `TOOLS` registry
- Optionally set `tool_choice` in persona frontmatter to require specific tool usage (use sparingly to avoid hallucination)
- All tool calls are logged to `conversation.log` as `[TOOL_CALLS]` blocks
- Recognized tool calls are executed via the registry's `execute` function
- To add a new built-in tool: add an entry to the `TOOLS` object in loopy.js, then enable it in any persona's `tools` list

### Context Directory

All `.txt` and `.md` files in the `context/` directory are automatically injected into every persona's system prompt:
- Files are loaded in alphabetical order
- Each file becomes a labeled block: `[filename]\n<contents>`
- Built-in tools (like `plan.update`) can write to this directory
- You can manually place files here for shared context (e.g., API specs, project goals)
- Example: `context/plan.txt` contains the current team plan maintained by Blackwell

### Model Auto-Detection

On startup, loopy automatically detects the best available Ollama model:
- Queries Ollama API (`/api/tags`) for available models
- Uses preference order: `llama3.2:1b` → other `llama3.2` → other `llama3` → `llama2` → first available
- Falls back gracefully if API is unreachable
- Can be overridden with `OLLAMA_MODEL` environment variable
- Logs selected model at startup for transparency

**Preference rationale:**
- `llama3.2:1b` is small, fast, and good for multi-turn conversations
- Prefers smaller models for faster response times in the loop
- Falls back to larger models if smaller ones aren't available

### Human Advisor Feature

Periodically injects a narrator message informing the AI team that their human advisor is available:
- On startup and every `ADVISOR_INTERVAL_MS` milliseconds (default: 4 hours)
- Message content loaded from `advisor.txt` (hot-reloadable)
- Next persona in rotation sees the message and can respond with a request
- Any turn mentioning "Advisor" is automatically logged to `advisor.log` with timestamp
- Messages naturally scroll out as persona turns exceed `KEEP_CYCLES x persona_count`
- Feature is opt-in: no `advisor.txt` file means no injection
- For testing, set `ADVISOR_INTERVAL_MS=10000` (10 seconds) to see rapid advisor notices

**Contacting the Advisor:**
- Secretary persona has access to `pushover.notify` tool for sending push notifications
- Team can address "Dear Advisor" to signal they need human help
- Secretary will only send notifications for specific, actionable requests
- Requires `PUSHOVER_TOKEN` and `PUSHOVER_USER` environment variables

## Development Notes

- Uses ES modules (`import` syntax)
- Requires Node.js 18+ for built-in `fetch` and `fs/promises`
- No external dependencies
- Ollama must be running locally before starting the loop
