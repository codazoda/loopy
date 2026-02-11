import { readFile, writeFile } from 'node:fs/promises';

const MODEL = process.env.OLLAMA_MODEL || 'llama3.2:latest';
const FILE = process.env.CONVO_FILE || 'conversation.txt';
const LOG_FILE = process.env.CONVO_LOG || 'conversation.log';
const SYSTEM_FILE = process.env.SYSTEM_FILE || 'system.txt';
const SEED_FILE = process.env.SEED_FILE || 'seed.txt';
const URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/generate';
const SLEEP_MS = Number(process.env.SLEEP_MS || 15000);
const MAX_TURNS = Number(process.env.MAX_TURNS || 6);
const TURN_SEP = '\n\n---\n\n';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await writeFile(FILE, '', { flag: 'a' });
await writeFile(LOG_FILE, '', { flag: 'a' });

while (true) {
  const system = await readFile(SYSTEM_FILE, 'utf8');
  let prompt = await readFile(FILE, 'utf8');
  if (!prompt.trim().length) {
    const seed = await readFile(SEED_FILE, 'utf8');
    if (seed.trim().length) {
      prompt = seed.trim();
      await writeFile(FILE, `${prompt}\n`, 'utf8');
      await writeFile(LOG_FILE, `${prompt}\n`, { flag: 'a', encoding: 'utf8' });
      process.stdout.write(`${prompt}\n`);
    }
  }
  const fullPrompt = system.trim().length
    ? `${system.trim()}\n\n${prompt}`
    : prompt;

  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, prompt: fullPrompt, stream: true })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama error ${res.status}: ${text}`);
  }

  let appendedPrefix = false;
  const decoder = new TextDecoder();
  let buf = '';

  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const data = JSON.parse(line);
      if (!appendedPrefix) {
        const prefix = prompt.trim().length ? TURN_SEP : '';
        await writeFile(FILE, prefix, { flag: 'a', encoding: 'utf8' });
        await writeFile(LOG_FILE, prefix, { flag: 'a', encoding: 'utf8' });
        if (prefix) process.stdout.write(prefix);
        appendedPrefix = true;
      }
      if (data.response) {
        await writeFile(FILE, data.response, { flag: 'a', encoding: 'utf8' });
        await writeFile(LOG_FILE, data.response, { flag: 'a', encoding: 'utf8' });
        process.stdout.write(data.response);
      }
    }
  }

  await writeFile(FILE, '\n', { flag: 'a', encoding: 'utf8' });
  await writeFile(LOG_FILE, '\n', { flag: 'a', encoding: 'utf8' });
  process.stdout.write('\n');

  const full = await readFile(FILE, 'utf8');
  const parts = full.split(TURN_SEP).filter((p) => p.length > 0);
  if (parts.length > MAX_TURNS) {
    const tail = parts.slice(-MAX_TURNS).join(TURN_SEP);
    await writeFile(FILE, tail, 'utf8');
  }

  await sleep(SLEEP_MS);
}
