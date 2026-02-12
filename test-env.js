#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

// Load .env file if it exists
try {
  const envFile = await readFile('.env', 'utf8');
  envFile.split('\n').forEach(line => {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) return;
    // Parse KEY=value or export KEY=value (with optional quotes)
    const match = trimmed.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (match) {
      const key = match[1];
      let value = match[2].trim();
      // Remove quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // Only set if not already in environment (env vars take precedence)
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  });
  console.log('✓ .env file loaded successfully');
} catch (err) {
  console.log('ℹ No .env file found (this is OK)');
}

// Show loaded config
console.log('\nLoaded configuration:');
console.log('  PUSHOVER_TOKEN:', process.env.PUSHOVER_TOKEN ? '✓ Set' : '✗ Not set');
console.log('  PUSHOVER_USER:', process.env.PUSHOVER_USER ? '✓ Set' : '✗ Not set');
console.log('  OLLAMA_MODEL:', process.env.OLLAMA_MODEL || '(using default)');
console.log('  MAX_TURNS:', process.env.MAX_TURNS || '(using default)');
console.log('  ADVISOR_INTERVAL_MS:', process.env.ADVISOR_INTERVAL_MS || '(using default)');

console.log('\n✓ Test complete');
