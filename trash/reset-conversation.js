#!/usr/bin/env node
import { writeFile, readFile } from 'node:fs/promises';

const FILE = process.env.CONVO_FILE || 'conversation.txt';
const LOG_FILE = process.env.CONVO_LOG || 'conversation.log';
const SEED_FILE = process.env.SEED_FILE || 'seed.txt';

async function resetConversation() {
  console.log('🔄 Resetting conversation...\n');

  // Archive current conversation
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    const current = await readFile(LOG_FILE, 'utf8');
    await writeFile(`${LOG_FILE}.${timestamp}.bak`, current, 'utf8');
    console.log(`✓ Archived conversation.log to ${LOG_FILE}.${timestamp}.bak`);
  } catch (e) {
    console.log('  (No existing conversation.log to archive)');
  }

  // Clear conversation.txt
  await writeFile(FILE, '', 'utf8');
  console.log('✓ Cleared conversation.txt');

  // Start fresh log with seed
  try {
    const seed = await readFile(SEED_FILE, 'utf8');
    await writeFile(LOG_FILE, seed.trim() + '\n\n---\n\n', 'utf8');
    console.log('✓ Reset conversation.log with seed content');
  } catch (e) {
    await writeFile(LOG_FILE, '', 'utf8');
    console.log('✓ Created empty conversation.log');
  }

  console.log('\n✅ Conversation reset! Run `node loopy.js` to start fresh.');
}

resetConversation().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
