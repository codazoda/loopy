#!/usr/bin/env node
// Test model detection logic

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

async function testModelDetection() {
  console.log('Testing Ollama model detection...\n');

  try {
    console.log(`Fetching models from: ${OLLAMA_HOST}/api/tags`);

    const response = await fetch(`${OLLAMA_HOST}/api/tags`);

    if (!response.ok) {
      console.error(`✗ API error: ${response.status} ${response.statusText}`);
      return;
    }

    const data = await response.json();
    const availableModels = data.models?.map(m => m.name) || [];

    console.log(`\n✓ Found ${availableModels.length} models:\n`);
    availableModels.forEach(m => console.log(`  - ${m}`));

    // Test preference order
    const preferred = [
      'llama3.2:1b',
      'llama3.2:3b',
      'llama3.2:latest',
      ...availableModels.filter(m => m.startsWith('llama3.2:')),
      ...availableModels.filter(m => m.startsWith('llama3.1:')),
      ...availableModels.filter(m => m.startsWith('llama3:')),
      ...availableModels.filter(m => m.startsWith('llama2:')),
      ...availableModels
    ];

    const selected = preferred.find(m => availableModels.includes(m)) || availableModels[0];

    console.log(`\n✓ Would select: ${selected}`);

    // Show why
    if (availableModels.includes('llama3.2:1b')) {
      console.log('  (preferred model is available)');
    } else if (selected.startsWith('llama3.2:')) {
      console.log('  (llama3.2:1b not found, using another llama3.2 variant)');
    } else if (selected.startsWith('llama3')) {
      console.log('  (llama3.2 not found, using another llama3 variant)');
    } else {
      console.log('  (no llama3 variants found, using first available)');
    }

  } catch (err) {
    console.error(`✗ Error: ${err.message}`);
    console.log('\nIs Ollama running? Try: ollama serve');
  }
}

testModelDetection();
