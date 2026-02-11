import { readdir, readFile, writeFile } from 'node:fs/promises';

const MODEL = process.env.OLLAMA_MODEL || 'llama3.2:latest';
const FILE = process.env.CONVO_FILE || 'conversation.txt';
const LOG_FILE = process.env.CONVO_LOG || 'conversation.log';
const SYSTEM_FILE = process.env.SYSTEM_FILE || 'system.txt';
const SEED_FILE = process.env.SEED_FILE || 'seed.txt';
const PERSONA_DIR = process.env.PERSONA_DIR || 'persona';
const URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/chat';
const SLEEP_MS = Number(process.env.SLEEP_MS || 5000);
const MAX_TURNS = Number(process.env.MAX_TURNS || 6);
const TURN_SEP = '\n\n---\n\n';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const parseScalar = (value) => {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (!Number.isNaN(Number(trimmed))) return Number(trimmed);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const parseFrontmatter = (text) => {
  if (!text.startsWith('---\n')) return { config: null, body: text };
  const lines = text.split('\n');
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return { config: null, body: text };

  const fmLines = lines.slice(1, end);
  const body = lines.slice(end + 1).join('\n').trimStart();

  const root = {};
  const stack = [{ indent: -1, container: root }];

  const nextNonEmpty = (start) => {
    for (let j = start; j < fmLines.length; j += 1) {
      const raw = fmLines[j];
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      return { indent: raw.match(/^ */)[0].length, trimmed };
    }
    return null;
  };

  for (let i = 0; i < fmLines.length; i += 1) {
    const raw = fmLines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = raw.match(/^ */)[0].length;
    while (indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].container;

    if (trimmed.startsWith('- ')) {
      const rest = trimmed.slice(2).trim();
      if (!Array.isArray(parent)) continue;
      if (!rest) {
        const obj = {};
        parent.push(obj);
        stack.push({ indent, container: obj });
        continue;
      }
      if (rest.includes(':')) {
        const [keyPart, ...valueParts] = rest.split(':');
        const key = keyPart.trim();
        const valueRaw = valueParts.join(':').trim();
        const obj = {};
        if (!valueRaw) {
          obj[key] = {};
        } else {
          obj[key] = parseScalar(valueRaw);
        }
        parent.push(obj);
        stack.push({ indent, container: obj });
      } else {
        parent.push(parseScalar(rest));
      }
      continue;
    }

    const [keyPart, ...valueParts] = trimmed.split(':');
    const key = keyPart.trim();
    const valueRaw = valueParts.join(':').trim();

    if (!valueRaw) {
      const next = nextNonEmpty(i + 1);
      const container =
        next && next.indent > indent && next.trimmed.startsWith('- ')
          ? []
          : {};
      parent[key] = container;
      stack.push({ indent, container });
    } else {
      parent[key] = parseScalar(valueRaw);
    }
  }

  return { config: root, body };
};

await writeFile(FILE, '', { flag: 'a' });
await writeFile(LOG_FILE, '', { flag: 'a' });

const personas = (await readdir(PERSONA_DIR))
  .filter((f) => f.endsWith('.txt'))
  .sort();

for (let i = personas.length - 1; i > 0; i -= 1) {
  const j = Math.floor(Math.random() * (i + 1));
  [personas[i], personas[j]] = [personas[j], personas[i]];
}

let personaIndex = 0;

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

  const personaFile = personas[personaIndex % personas.length];
  const personaRaw = await readFile(`${PERSONA_DIR}/${personaFile}`, 'utf8');
  const { config, body: persona } = parseFrontmatter(personaRaw);

  const baseName = personaFile.replace(/\.txt$/i, '');
  const speaker =
    baseName.length > 0
      ? `${baseName[0].toUpperCase()}${baseName.slice(1)}`
      : 'Speaker';
  personaIndex += 1;

  const systemPrompt = [persona.trim(), system.trim()]
    .filter((p) => p.length > 0)
    .join('\n\n');

  const payload = {
    model: MODEL,
    stream: true,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt }
    ]
  };

  if (config?.tools) payload.tools = config.tools;
  if (config?.tool_choice) payload.tool_choice = config.tool_choice;

  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama error ${res.status}: ${text}`);
  }

  let appendedPrefix = false;
  const decoder = new TextDecoder();
  let buf = '';
  const toolCalls = [];

  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const data = JSON.parse(line);
      const content = data?.message?.content;
      const calls = data?.message?.tool_calls;
      if (calls) toolCalls.push(...calls);

      if (content && !appendedPrefix) {
        const prefix = `**${speaker}**:\n\n`;
        await writeFile(FILE, prefix, { flag: 'a', encoding: 'utf8' });
        await writeFile(LOG_FILE, prefix, { flag: 'a', encoding: 'utf8' });
        process.stdout.write(prefix);
        appendedPrefix = true;
      }

      if (content) {
        await writeFile(FILE, content, { flag: 'a', encoding: 'utf8' });
        await writeFile(LOG_FILE, content, { flag: 'a', encoding: 'utf8' });
        process.stdout.write(content);
      }
    }
  }

  if (toolCalls.length > 0) {
    const toolBlock = `\n[TOOL_CALLS]\n${
      JSON.stringify(toolCalls, null, 2)
    }\n[/TOOL_CALLS]\n`;
    await writeFile(LOG_FILE, toolBlock, { flag: 'a', encoding: 'utf8' });
  }

  if (appendedPrefix) {
    await writeFile(FILE, TURN_SEP, { flag: 'a', encoding: 'utf8' });
    await writeFile(LOG_FILE, TURN_SEP, { flag: 'a', encoding: 'utf8' });
    process.stdout.write(TURN_SEP);
  }

  const full = await readFile(FILE, 'utf8');
  const parts = full.split(TURN_SEP).filter((p) => p.trim().length > 0);
  if (parts.length > MAX_TURNS) {
    const tail = parts.slice(-MAX_TURNS);
    const rebuilt = tail.join(TURN_SEP) + TURN_SEP;
    await writeFile(FILE, rebuilt, 'utf8');
  }

  await sleep(SLEEP_MS);
}
