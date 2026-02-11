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

- `OLLAMA_MODEL` (default `llama3.2:latest`)
- `CONVO_FILE` (default `conversation.txt`)
- `CONVO_LOG` (default `conversation.log`)
- `OLLAMA_URL` (default `http://127.0.0.1:11434/api/generate`)
- `SLEEP_MS` (default `10000`)
- `MAX_TURNS` (default `6`)

Example:

```bash
OLLAMA_MODEL=llama3.2:latest MAX_TURNS=8 SLEEP_MS=5000 node loopy.js
```
