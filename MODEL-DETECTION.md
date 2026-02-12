# Model Auto-Detection

Loopy automatically detects and selects the best available Ollama model on startup.

## How It Works

### 1. Startup Detection

When loopy.js starts, it:
1. Checks if `OLLAMA_MODEL` environment variable is set
2. If not set, queries Ollama API: `GET /api/tags`
3. Gets list of all installed models
4. Selects best model based on preference order
5. Logs selected model to console

### 2. Preference Order

Models are selected in this priority:

```
1. llama3.2:1b          (preferred - small & fast)
2. llama3.2:3b          (good balance)
3. llama3.2:latest      (stable release)
4. Other llama3.2:*     (any other llama3.2 variant)
5. Other llama3.1:*     (fallback to 3.1)
6. Other llama3:*       (fallback to llama3)
7. Other llama2:*       (fallback to llama2)
8. First available      (any model works)
```

### 3. Why llama3.2:1b?

The 1b (1 billion parameter) model is preferred because:
- **Speed**: Much faster responses in conversation loops
- **Memory**: Lower RAM usage (important for continuous operation)
- **Quality**: Still very capable for multi-turn conversations
- **Availability**: Commonly installed, small download

For comparison:
- llama3.2:1b = ~1.3GB download, ~2GB RAM
- llama3.2:3b = ~2GB download, ~4GB RAM
- llama3.1:8b = ~4.7GB download, ~8GB RAM

## Testing Model Detection

Run the test script to see what model would be selected:

```bash
./test-model-detection.js
# or
node test-model-detection.js
```

**Example output:**
```
Testing Ollama model detection...

Fetching models from: http://127.0.0.1:11434/api/tags

✓ Found 13 models:

  - socialnetwooky/llama3.2-abliterated:3b_q4
  - llama3.1:8b
  - gemma3:latest
  - llama3.2:1b
  - qwen2.5-coder:7b
  - deepseek-r1:8b
  - qwen2.5-coder:14b
  - llama3.2:latest
  - qwen3:latest
  - qwen3:4b
  - phi4-mini:latest
  - mistral:latest
  - llama3.1:latest

✓ Would select: llama3.2:1b
  (preferred model is available)
```

## Overriding Model Selection

### Method 1: Environment Variable

```bash
export OLLAMA_MODEL=llama3.1:8b
node loopy.js
```

### Method 2: .env File

```bash
# In .env
OLLAMA_MODEL=llama3.1:8b
```

### Method 3: Inline

```bash
OLLAMA_MODEL=llama3.1:8b node loopy.js
```

When `OLLAMA_MODEL` is set, auto-detection is skipped entirely.

## Startup Logs

### Successful Auto-Detection

```
Using model: llama3.2:1b (detected from 13 available models)
```

### Manual Override

```
Using model: llama3.1:8b (from environment)
```

### Fallback (API unreachable)

```
Warning: Could not detect Ollama models: fetch failed
Using fallback model: llama3.2:1b
```

The fallback model will be used even if it's not installed, which will cause an error when the first message is sent. This prompts you to either install the model or fix the connection.

## Installing Models

If the preferred model isn't installed:

```bash
# Install llama3.2:1b (recommended)
ollama pull llama3.2:1b

# Or other variants
ollama pull llama3.2:3b
ollama pull llama3.2:latest
```

List installed models:
```bash
ollama list
```

## Troubleshooting

### "Warning: No Ollama models found"

**Cause:** Ollama API returned empty model list

**Solution:**
```bash
# Check if Ollama is running
ollama list

# If not running, start it
ollama serve

# Pull a model
ollama pull llama3.2:1b
```

### "Warning: Could not detect Ollama models"

**Cause:** Can't reach Ollama API

**Solution:**
```bash
# Check if Ollama is running
curl http://127.0.0.1:11434/api/tags

# If not running
ollama serve

# If using different port/host, set in .env
OLLAMA_URL=http://localhost:11434
```

### "model 'llama3.2:1b' not found"

**Cause:** Fallback model was used but isn't installed

**Solution:**
```bash
# Install the model
ollama pull llama3.2:1b

# Or set a different model
export OLLAMA_MODEL=llama3.1:latest
```

## Advanced Configuration

### Custom Ollama Host

If Ollama is running on a different host/port:

```bash
# In .env
OLLAMA_HOST=http://192.168.1.100:11434
```

The model detection will automatically query `http://192.168.1.100:11434/api/tags`

### Testing Without Ollama

For testing error handling without Ollama:

```bash
# This will show the error behavior
OLLAMA_HOST=http://localhost:9999 node test-model-detection.js
```

## Best Practices

1. **Let auto-detection work** - Don't set OLLAMA_MODEL unless you need a specific model
2. **Install llama3.2:1b** - It's the preferred model for good reason
3. **Check startup logs** - Verify the expected model is being used
4. **Test new models** - Use OLLAMA_MODEL override to try different models without changing code

## Performance Comparison

Approximate response times for a typical turn in the loop:

| Model | Response Time | RAM Usage | Quality |
|-------|--------------|-----------|---------|
| llama3.2:1b | ~1-2s | ~2GB | Good |
| llama3.2:3b | ~3-5s | ~4GB | Better |
| llama3.1:8b | ~8-12s | ~8GB | Best |
| llama3.2:latest (3b) | ~3-5s | ~4GB | Better |

For a fast-moving conversation loop, llama3.2:1b is ideal. For higher quality responses at the cost of speed, override with a larger model.
