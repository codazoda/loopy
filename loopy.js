import { readdir, readFile, writeFile } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
const execFile = promisify(execFileCb);

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
} catch {
  // .env file doesn't exist or can't be read - that's fine
}

// Ollama configuration
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
let MODEL = process.env.OLLAMA_MODEL;

// Detect available Ollama model and verify server is reachable
try {
  const response = await fetch(`${OLLAMA_HOST}/api/tags`);

  if (!response.ok) {
    console.error(`\nError: Ollama server returned ${response.status} ${response.statusText}`);
    console.error(`Host: ${OLLAMA_HOST}`);
    console.error('\nPlease ensure Ollama is running:');
    console.error('  ollama serve');
    process.exit(1);
  }

  const data = await response.json();
  const availableModels = data.models?.map(m => m.name) || [];

  if (availableModels.length === 0) {
    console.error('\nError: No Ollama models found.');
    console.error('\nPlease install a model:');
    console.error('  ollama pull llama3.2:1b');
    process.exit(1);
  }

  if (!MODEL) {
    // Auto-detect model using preference order
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

    MODEL = preferred.find(m => availableModels.includes(m)) || availableModels[0];
    console.log(`Using model: ${MODEL} (detected from ${availableModels.length} available models)\n`);
  } else {
    // Verify specified model exists
    if (!availableModels.includes(MODEL)) {
      console.error(`\nError: Model '${MODEL}' not found in Ollama.`);
      console.error(`\nAvailable models:`);
      availableModels.forEach(m => console.error(`  - ${m}`));
      console.error(`\nTo install: ollama pull ${MODEL}`);
      process.exit(1);
    }
    console.log(`Using model: ${MODEL} (from environment)\n`);
  }
} catch (err) {
  console.error('\nError: Could not connect to Ollama server');
  console.error(`Host: ${OLLAMA_HOST}`);
  console.error(`Error: ${err.message}`);
  console.error('\nPlease ensure Ollama is running:');
  console.error('  ollama serve');
  console.error('\nOr set OLLAMA_HOST if running on a different host/port:');
  console.error('  export OLLAMA_HOST=http://localhost:11434');
  process.exit(1);
}

const URL = `${OLLAMA_HOST}/api/chat`;
const FILE = process.env.CONVO_FILE || 'conversation.txt';
const LOG_FILE = process.env.CONVO_LOG || 'conversation.log';
const SYSTEM_FILE = process.env.SYSTEM_FILE || 'system.txt';
const SEED_FILE = process.env.SEED_FILE || 'seed.txt';
const PERSONA_DIR = process.env.PERSONA_DIR || 'persona';
const SLEEP_MS = Number(process.env.SLEEP_MS || 5000);
const KEEP_CYCLES = Number(process.env.KEEP_CYCLES || 6);
const ADVISOR_FILE = process.env.ADVISOR_FILE || 'advisor.txt';
const ADVISOR_INTERVAL_MS = Number(process.env.ADVISOR_INTERVAL_MS || 14400000); // 4 hours
const ADVISOR_LOG = process.env.ADVISOR_LOG || 'advisor.log';
const CONTEXT_DIR = process.env.CONTEXT_DIR || 'context';
const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN || '';
const PUSHOVER_USER = process.env.PUSHOVER_USER || '';
const TURN_SEP = '\n\n---\n\n';
const MAX_INVALID_TURN_RETRIES = Number(process.env.MAX_INVALID_TURN_RETRIES || 3);
const MULTI_VOICE_MARKER = /(\*\*[A-Z][a-z]+\*\*:|^---$|^\[.*\]:$|^[A-Z][A-Za-z0-9_ ]{1,20}:\s)/m;
const THINKING_FRAMES = '.oOo.';
const THINKING_INTERVAL_MS = 120;

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
  },
  'pushover.notify': {
    schema: {
      type: 'function',
      function: {
        name: 'pushover.notify',
        description: 'Send a push notification to advisor Joel via Pushover. Only use when the team has a specific, actionable request or question.',
        parameters: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'The message to send to Joel. Be specific about what you need help with.'
            },
            title: {
              type: 'string',
              description: 'Optional short title for the notification (default: "Loopy Team")'
            }
          },
          required: ['message']
        }
      }
    },
    async execute(args) {
      let message = typeof args === 'string' ? args : args?.message;
      let title = args?.title || 'Loopy Team';

      if (!message) return;

      // Unwrap hallucinated JSON schema wrappers
      if (typeof message === 'string') {
        try {
          const parsed = JSON.parse(message);
          if (typeof parsed?.description === 'string') message = parsed.description;
        } catch {}
      }

      // Check if Pushover is configured
      if (!PUSHOVER_TOKEN || !PUSHOVER_USER) {
        console.error('[pushover.notify] Skipped: PUSHOVER_TOKEN and PUSHOVER_USER must be set');
        return;
      }

      // Send to Pushover API
      try {
        const formData = new URLSearchParams({
          token: PUSHOVER_TOKEN,
          user: PUSHOVER_USER,
          message: message,
          title: title
        });

        const response = await fetch('https://api.pushover.net/1/messages.json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formData.toString()
        });

        const result = await response.json();

        if (result.status === 1) {
          console.log(`[pushover.notify] Sent: "${title}" - ${message.substring(0, 50)}...`);
        } else {
          console.error('[pushover.notify] Failed:', result.errors);
        }
      } catch (err) {
        console.error('[pushover.notify] Error:', err.message);
      }
    }
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const startThinkingIndicator = () => {
  if (!process.stdout.isTTY) return null;
  let idx = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r${THINKING_FRAMES[idx]}`);
    idx = (idx + 1) % THINKING_FRAMES.length;
  }, THINKING_INTERVAL_MS);
  return { timer };
};

const stopThinkingIndicator = (handle) => {
  if (!handle || !handle.timer) return;
  clearInterval(handle.timer);
  if (process.stdout.isTTY) {
    process.stdout.write('\r \r');
  }
};

const findInvalidMarker = (text, personaSpeakerLabelMarker = null) => {
  const indexes = [];
  const match = text.match(MULTI_VOICE_MARKER);
  if (match && typeof match.index === 'number') {
    indexes.push(match.index);
  }
  if (personaSpeakerLabelMarker) {
    const personaMatch = text.match(personaSpeakerLabelMarker);
    if (personaMatch && typeof personaMatch.index === 'number') {
      indexes.push(personaMatch.index);
    }
  }
  if (indexes.length === 0) return -1;
  return Math.min(...indexes);
};

const personaFileToSpeaker = (fileName) => {
  const baseName = fileName.replace(/\.txt$/i, '');
  if (!baseName) return '';
  return `${baseName[0].toUpperCase()}${baseName.slice(1)}`;
};

const trimTurnsByPersonaWindow = (turns, maxPersonaTurns, personaSpeakers) => {
  if (!Array.isArray(turns) || turns.length === 0) return [];
  if (maxPersonaTurns <= 0 || personaSpeakers.size === 0) return turns;

  let seenPersonaTurns = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (personaSpeakers.has(turns[i]?.speaker)) {
      seenPersonaTurns += 1;
      if (seenPersonaTurns >= maxPersonaTurns) {
        return turns.slice(i);
      }
    }
  }
  return turns;
};

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const generateAttempt = async (payload, personaSpeakerLabelMarker) => {
  const indicator = startThinkingIndicator();
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama error ${res.status}: ${text}`);
    }

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
        if (content) fullResponse += content;
      }
    }

    const trimmed = fullResponse.trim();
    if (!trimmed) {
      return { ok: false, reason: 'empty-response', toolCalls: [] };
    }

    const invalidAt = findInvalidMarker(fullResponse, personaSpeakerLabelMarker);
    if (invalidAt !== -1) {
      return { ok: false, reason: 'multi-speaker-marker', toolCalls: [] };
    }

    return { ok: true, fullResponse: trimmed, toolCalls };
  } finally {
    stopThinkingIndicator(indicator);
  }
};

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

// Special personas that always go last, in this order
const SPECIAL_PERSONA_ORDER = ['moderator.txt', 'secretary.txt'];

// Shuffle personas, keeping special ones at the end
function shufflePersonas(allPersonas, specialOrder = SPECIAL_PERSONA_ORDER) {
  const special = [];
  const regular = [];
  const specialSet = new Set(specialOrder);

  allPersonas.forEach(p => {
    if (specialSet.has(p)) {
      special.push(p);
    } else {
      regular.push(p);
    }
  });

  // Shuffle regular personas
  for (let i = regular.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [regular[i], regular[j]] = [regular[j], regular[i]];
  }

  // Sort special personas to match SPECIAL_PERSONAS order
  special.sort((a, b) => {
    return specialOrder.indexOf(a) - specialOrder.indexOf(b);
  });

  return [...regular, ...special];
}

let allPersonaFiles = (await readdir(PERSONA_DIR))
  .filter((f) => f.endsWith('.txt'))
  .sort();
const availableSpecialPersonas = SPECIAL_PERSONA_ORDER.filter((p) => allPersonaFiles.includes(p));
const missingSpecialPersonas = SPECIAL_PERSONA_ORDER.filter((p) => !allPersonaFiles.includes(p));
if (missingSpecialPersonas.length > 0) {
  console.log(
    `[startup] Optional special personas missing: ${missingSpecialPersonas.join(', ')}. Continuing without them.\n`
  );
}
const personaSpeakers = new Set(allPersonaFiles.map(personaFileToSpeaker).filter(Boolean));
const personaNames = allPersonaFiles
  .map((f) => f.replace(/\.txt$/i, ''))
  .filter(Boolean)
  .map(escapeRegExp);
const personaSpeakerLabelMarker = personaNames.length
  ? new RegExp(
      `^\\s*(?:[-*#>]|\\d+[.)])?\\s*(?:\\*\\*)?(?:${personaNames.join('|')})(?:\\*\\*)?\\s*:`,
      'im'
    )
  : null;
const maxPersonaTurns = KEEP_CYCLES * personaSpeakers.size;

let personas = shufflePersonas(allPersonaFiles, availableSpecialPersonas);
let personaIndex = 0;

while (true) {
  const system = await readFile(SYSTEM_FILE, 'utf8');
  let turns = [];
  try {
    const raw = await readFile(FILE, 'utf8');
    if (raw.trim()) {
      turns = JSON.parse(raw);
      if (!Array.isArray(turns)) turns = [];
    }
  } catch {
    turns = [];
  }

  if (turns.length === 0) {
    const seed = await readFile(SEED_FILE, 'utf8');
    if (seed.trim().length) {
      turns = [{ speaker: 'seed', content: seed.trim() }];
      await writeFile(FILE, JSON.stringify(turns, null, 2), 'utf8');
      await writeFile(LOG_FILE, `${seed.trim()}\n`, { flag: 'a', encoding: 'utf8' });
      process.stdout.write(`${seed.trim()}\n`);
    }
  }

  if (Date.now() - lastAdvisorTime >= ADVISOR_INTERVAL_MS) {
    try {
      const advisorPrompt = await readFile(ADVISOR_FILE, 'utf8');
      if (advisorPrompt.trim()) {
        const isFirstNarratorMessage = lastAdvisorTime === 0;
        const hasSeedTurn = turns.some((turn) => turn.speaker === 'seed');
        turns.push({ speaker: 'Narrator', content: advisorPrompt.trim() });
        await writeFile(FILE, JSON.stringify(turns, null, 2), 'utf8');
        const leadingGap = isFirstNarratorMessage && hasSeedTurn ? '\n' : '';
        const message = leadingGap + advisorPrompt.trim() + TURN_SEP;
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

  const speaker = personaFileToSpeaker(personaFile) || 'Speaker';
  personaIndex += 1;
  if (personaIndex >= personas.length) {
    personas = shufflePersonas(allPersonaFiles, availableSpecialPersonas);
    personaIndex = 0;
  }

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

  // Build messages array from turns, mapping speakers to roles
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const turn of turns) {
    if (turn.speaker === speaker) {
      messages.push({ role: 'assistant', content: turn.content });
    } else {
      const prefix = turn.speaker === 'seed' ? '' : `${turn.speaker}: `;
      messages.push({ role: 'user', content: prefix + turn.content });
    }
  }

  const payload = {
    model: MODEL,
    stream: true,
    messages
  };

  // DISABLED: Tool calling disabled (small model hallucinates and spams)
  // if (config?.tools) {
  //   const schemas = config.tools
  //     .map((name) => TOOLS[name]?.schema)
  //     .filter(Boolean);
  //   if (schemas.length) payload.tools = schemas;
  // }
  // if (config?.tool_choice) payload.tool_choice = config.tool_choice;

  let accepted = null;
  for (let attempt = 1; attempt <= MAX_INVALID_TURN_RETRIES; attempt += 1) {
    const result = await generateAttempt(payload, personaSpeakerLabelMarker);
    if (result.ok) {
      accepted = result;
      break;
    }

    const audit = `[discarded invalid multi-speaker turn] speaker=${speaker} attempt=${attempt} reason=${result.reason}${TURN_SEP}`;
    await writeFile(LOG_FILE, audit, { flag: 'a', encoding: 'utf8' });
    process.stdout.write(audit);
  }

  if (!accepted) {
    const skip = `[skipped turn after invalid retries] speaker=${speaker} retries=${MAX_INVALID_TURN_RETRIES}\n\n`;
    await writeFile(LOG_FILE, skip, { flag: 'a', encoding: 'utf8' });
    process.stdout.write(skip);
    await sleep(SLEEP_MS);
    continue;
  }

  const fullResponse = accepted.fullResponse;
  const toolCalls = accepted.toolCalls;
  const prefix = `**${speaker}**:\n\n`;
  await writeFile(LOG_FILE, prefix, { flag: 'a', encoding: 'utf8' });
  await writeFile(LOG_FILE, fullResponse, { flag: 'a', encoding: 'utf8' });
  process.stdout.write(prefix);
  process.stdout.write(fullResponse);

  if (toolCalls.length > 0) {
    const toolBlock = `\n[TOOL_CALLS]\n${
      JSON.stringify(toolCalls, null, 2)
    }\n[/TOOL_CALLS]\n`;
    await writeFile(LOG_FILE, toolBlock, { flag: 'a', encoding: 'utf8' });
    process.stdout.write(toolBlock);

    // DISABLED: Log tool calls but don't execute (belt-and-suspenders safety)
    for (const call of toolCalls) {
      const name = call?.function?.name;
      console.log(`[tool] skipped execution: ${name}`);
      // const tool = TOOLS[name];
      // if (tool) await tool.execute(call.function.arguments);
    }
  }

  await writeFile(LOG_FILE, TURN_SEP, { flag: 'a', encoding: 'utf8' });
  process.stdout.write(TURN_SEP);

  // Append response to turns array and save as JSON
  turns.push({ speaker, content: fullResponse });

  // Keep a fixed number of persona cycles in the rolling conversation.
  turns = trimTurnsByPersonaWindow(turns, maxPersonaTurns, personaSpeakers);

  // Save as JSON
  await writeFile(FILE, JSON.stringify(turns, null, 2), 'utf8');

  if (/\bAdvisor\b/i.test(fullResponse)) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${speaker}:\n${fullResponse}\n${TURN_SEP}`;
    await writeFile(ADVISOR_LOG, logEntry, { flag: 'a' });
  }

  await sleep(SLEEP_MS);
}
