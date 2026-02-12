# Ollama Self-Loop

Minimal Node loop that streams a model’s output back into a rolling prompt file.

## Requirements
- Node.js 18+ (for built-in `fetch`)
- Ollama running locally on `http://127.0.0.1:11434`

## Run
1. Start the loop:

```bash
node loopy.js
```

2. Watch the live output:

```bash
tail -f conversation.log
```

## Optional: Speak It Aloud (macOS)
Pipe the live stream to the macOS TTS engine:

```bash
node loopy.js | say
```

You can choose a voice and rate:

```bash
node loopy.js | say -v Samantha -r 180
```

## Config
All optional via environment variables:

- `OLLAMA_HOST` (default `http://127.0.0.1:11434`)
- `OLLAMA_MODEL` (default: auto-detected, prefers `llama3.2:1b`)
- `CONVO_FILE` (default `conversation.txt`)
- `CONVO_LOG` (default `conversation.log`)
- `SLEEP_MS` (default `5000`)
- `KEEP_CYCLES` (default `6`, keeps `KEEP_CYCLES x number_of_personas` persona turns)

See [CLAUDE.md](CLAUDE.md) for full configuration options.

Example:

```bash
OLLAMA_MODEL=llama3.2:1b KEEP_CYCLES=8 SLEEP_MS=5000 node loopy.js
```
