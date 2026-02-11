import { readdir, readFile, writeFile } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
const execFile = promisify(execFileCb);

const MODEL = process.env.OLLAMA_MODEL || 'llama3.2:latest';
const FILE = process.env.CONVO_FILE || 'conversation.txt';
const LOG_FILE = process.env.CONVO_LOG || 'conversation.log';
const SYSTEM_FILE = process.env.SYSTEM_FILE || 'system.txt';
const SEED_FILE = process.env.SEED_FILE || 'seed.txt';
const PERSONA_DIR = process.env.PERSONA_DIR || 'persona';
const URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/chat';
const SLEEP_MS = Number(process.env.SLEEP_MS || 5000);
const MAX_TURNS = Number(process.env.MAX_TURNS || 6);
const ADVISOR_FILE = process.env.ADVISOR_FILE || 'advisor.txt';
const ADVISOR_INTERVAL_MS = Number(process.env.ADVISOR_INTERVAL_MS || 86400000);
const ADVISOR_LOG = process.env.ADVISOR_LOG || 'advisor.log';
const CONTEXT_DIR = process.env.CONTEXT_DIR || 'context';
const TURN_SEP = '\n\n---\n\n';

const TOOLS = {
  'plan.update': {
    schema: {
      type: 'function',
      function: {
        name: 'plan.update',
        description: 'Update the team plan. Pass a short instruction describing what to add or change.',
        parameters: {
          type: 'object',
          properties: {
            instruction: { type: 'string', description: 'What to add or change in the plan.' }
          },
          required: ['instruction']
        }
      }
    },
    async execute(args) {
      let instruction = typeof args === 'string' ? args : args?.instruction;
      if (!instruction) return;
      // Unwrap hallucinated JSON schema wrappers
      if (typeof instruction === 'string') {
        try {
          const parsed = JSON.parse(instruction);
          if (typeof parsed?.description === 'string') instruction = parsed.description;
        } catch {}
      }
      // Read existing plan
      const planPath = `${CONTEXT_DIR}/plan.txt`;
      let existing = '';
      try { existing = (await readFile(planPath, 'utf8')).trim(); } catch {}
      // Build prompt for copilot CLI
      const prompt = existing
        ? `Here is the current plan:\n\n${existing}\n\n${instruction}\n\nREWRITE the complete plan incorporating this change. Output the ENTIRE updated plan (not just the changes) as a one-page markdown business overview with next steps. Replace the old plan completely. No code fences, no explanations, just the complete updated plan.`
        : `Create a one-page markdown business plan based on: ${instruction}\n\nInclude an overview and next steps. No code fences.`;
      try {
        const { stdout } = await execFile('copilot', ['-p', prompt], { timeout: 30000 });
        if (stdout.trim()) {
          await writeFile(planPath, stdout.trim(), 'utf8');
          return;
        }
      } catch {}
      // Fallback: if copilot unavailable, skip update (don't corrupt plan with raw notes)
      // The existing plan remains unchanged
    }
  }
};

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
await writeFile(ADVISOR_LOG, '', { flag: 'a' });
let lastAdvisorTime = 0;

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

  if (Date.now() - lastAdvisorTime >= ADVISOR_INTERVAL_MS) {
    try {
      const advisorPrompt = await readFile(ADVISOR_FILE, 'utf8');
      if (advisorPrompt.trim()) {
        const needsPrefix = prompt.trim().length > 0 && !prompt.endsWith('\n\n');
        const prefix = needsPrefix ? '\n' : '';
        const message = prefix + advisorPrompt.trim() + TURN_SEP;
        await writeFile(FILE, message, { flag: 'a' });
        await writeFile(LOG_FILE, message, { flag: 'a' });
        process.stdout.write(message);
        lastAdvisorTime = Date.now();
      }
    } catch {
      // advisor.txt missing or unreadable — skip silently
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

  const contextBlocks = [];
  try {
    const contextFiles = (await readdir(CONTEXT_DIR))
      .filter(f => f.endsWith('.txt') || f.endsWith('.md')).sort();
    for (const cf of contextFiles) {
      try {
        const text = (await readFile(`${CONTEXT_DIR}/${cf}`, 'utf8')).trim();
        if (text) {
          const label = cf.replace(/\.(txt|md)$/i, '');
          contextBlocks.push(`[${label}]\n${text}`);
        }
      } catch {}
    }
  } catch {}

  const systemPrompt = [persona.trim(), system.trim(), ...contextBlocks]
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

  if (config?.tools) {
    const schemas = config.tools
      .map((name) => TOOLS[name]?.schema)
      .filter(Boolean);
    if (schemas.length) payload.tools = schemas;
  }
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
  let fullResponse = '';
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
        fullResponse += content;
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

    // If tool calls but no content, still write speaker name so turn is visible
    if (!appendedPrefix) {
      const prefix = `**${speaker}**: [called ${toolCalls.map(c => c.function?.name).filter(Boolean).join(', ')}]\n`;
      await writeFile(FILE, prefix, { flag: 'a', encoding: 'utf8' });
      await writeFile(LOG_FILE, prefix, { flag: 'a', encoding: 'utf8' });
      process.stdout.write(prefix);
      appendedPrefix = true;
    }

    for (const call of toolCalls) {
      const tool = TOOLS[call?.function?.name];
      if (tool) await tool.execute(call.function.arguments);
    }
  }

  if (appendedPrefix) {
    await writeFile(FILE, TURN_SEP, { flag: 'a', encoding: 'utf8' });
    await writeFile(LOG_FILE, TURN_SEP, { flag: 'a', encoding: 'utf8' });
    process.stdout.write(TURN_SEP);

    if (/\bAdvisor\b/i.test(fullResponse)) {
      const timestamp = new Date().toISOString();
      const logEntry = `[${timestamp}] ${speaker}:\n${fullResponse.trim()}\n${TURN_SEP}`;
      await writeFile(ADVISOR_LOG, logEntry, { flag: 'a' });
    }
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
