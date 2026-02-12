# Changelog - Recent Updates

## OLLAMA_HOST Migration & Error Handling

### Changed: OLLAMA_URL → OLLAMA_HOST

**Before:**
```bash
OLLAMA_URL=http://127.0.0.1:11434/api/chat
```

**After:**
```bash
OLLAMA_HOST=http://127.0.0.1:11434
```

**Why:**
- Matches standard Ollama CLI convention
- Cleaner - just the base URL, not the full API path
- API paths are constructed internally (`/api/chat`, `/api/tags`)

### New: Fail-Fast Error Handling

The application now exits immediately with helpful error messages if:

#### 1. Ollama server is not reachable
```
Error: Could not connect to Ollama server
Host: http://127.0.0.1:11434
Error: fetch failed

Please ensure Ollama is running:
  ollama serve

Or set OLLAMA_HOST if running on a different host/port:
  export OLLAMA_HOST=http://localhost:11434
```

#### 2. No models are installed
```
Error: No Ollama models found.

Please install a model:
  ollama pull llama3.2:1b
```

#### 3. Specified model doesn't exist
```
Error: Model 'nonexistent:model' not found in Ollama.

Available models:
  - llama3.2:1b
  - llama3.2:latest
  - llama3.1:8b
  ...

To install: ollama pull nonexistent:model
```

### Benefits

**Before:** Silent failures or confusing runtime errors
**After:** Clear, actionable error messages at startup

**Before:** Would try to use fallback model even if Ollama wasn't running
**After:** Exits immediately with instructions on how to fix the problem

## Migration Guide

### If you have OLLAMA_URL in .env:

**Option 1: Rename it**
```bash
# Change this:
OLLAMA_URL=http://127.0.0.1:11434/api/chat

# To this:
OLLAMA_HOST=http://127.0.0.1:11434
```

**Option 2: Do nothing**
The old variable won't work, but the default will kick in and everything will work fine if Ollama is running on the default port.

### If you were using a custom Ollama URL:

```bash
# Before:
OLLAMA_URL=http://192.168.1.100:11434/api/chat

# After:
OLLAMA_HOST=http://192.168.1.100:11434
```

## Testing

### Test error handling:
```bash
# Test with unreachable server
OLLAMA_HOST=http://localhost:9999 node loopy.js

# Test with invalid model
OLLAMA_MODEL=fake:model node loopy.js
```

### Test successful startup:
```bash
node loopy.js
# Should show: "Using model: llama3.2:1b (detected from X available models)"
```

## Files Updated

- ✅ `loopy.js` - OLLAMA_HOST migration, fail-fast error handling
- ✅ `CLAUDE.md` - Updated configuration docs
- ✅ `README.md` - Updated configuration examples
- ✅ `.env.example` - Changed to OLLAMA_HOST
- ✅ `MODEL-DETECTION.md` - Updated references
- ✅ `test-model-detection.js` - Updated to use OLLAMA_HOST
- ✅ `CHANGELOG.md` - This file
