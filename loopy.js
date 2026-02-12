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
const FILE = process.env.CONVO_FILE || 'conversation.json';
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
const TRANSCRIPT_MARKER = /^---$|^\[.*\]:$/m;
const THINKING_FRAMES = '.oOo.';
const THINKING_INTERVAL_MS = 120;
const WORKFLOW_ENABLED = process.env.WORKFLOW_ENABLED !== 'false';
const WORKFLOW_CYCLE_WINDOW = Math.max(1, Number(process.env.WORKFLOW_CYCLE_WINDOW || 3));
const WORKFLOW_FILE = process.env.WORKFLOW_FILE || 'workflow';
const WORKFLOW_STATE_FILE = process.env.WORKFLOW_STATE_FILE || `${CONTEXT_DIR}/workflow_state.json`;
const MODERATOR_STRICT_MODE = process.env.MODERATOR_STRICT_MODE !== 'false';
const DISCARD_MODE = process.env.DISCARD_MODE || 'transcript_only';

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

const clearTerminalLine = () => {
  if (process.stdout.isTTY) {
    process.stdout.write('\r\x1b[2K');
  }
};

const startThinkingIndicator = (statusText = '') => {
  if (!process.stdout.isTTY) return null;
  let idx = 0;
  let lastLen = 0;
  const render = () => {
    const line = `${THINKING_FRAMES[idx]}${statusText ? ` ${statusText}` : ''}`;
    process.stdout.write(`\r${line}`);
    lastLen = line.length;
    idx = (idx + 1) % THINKING_FRAMES.length;
  };
  render();
  const timer = setInterval(() => {
    render();
  }, THINKING_INTERVAL_MS);
  return { timer, lastLen };
};

const stopThinkingIndicator = (handle) => {
  if (!handle || !handle.timer) return;
  clearInterval(handle.timer);
  clearTerminalLine();
};

const DEFAULT_WORKFLOW_STEPS = [
  { name: 'brainstorm', instruction: "Generate 2 distinct ideas. Use team language and build on prior turns." },
  { name: 'cluster', instruction: 'Group overlapping ideas into themes and remove duplicates.' },
  { name: 'shortlist', instruction: 'Narrow the options to at most three concrete choices.' },
  { name: 'decide', instruction: 'Pick one option and show explicit agreement.' },
  { name: 'next_action', instruction: 'Define the immediate next action for the chosen option.' }
];

const defaultWorkflowState = () => ({
  step_index: 0,
  cycles_in_step: 0,
  total_turns: 0,
  total_cycles: 0,
  last_transition_reason: 'initial'
});

const sanitizeWorkflowState = (state, stepCount = DEFAULT_WORKFLOW_STEPS.length) => {
  const base = defaultWorkflowState();
  if (!state || typeof state !== 'object') return base;
  const next = {
    step_index: state.step_index,
    cycles_in_step: state.cycles_in_step,
    total_turns: state.total_turns,
    total_cycles: state.total_cycles,
    last_transition_reason: state.last_transition_reason
  };
  const safeStepCount = Math.max(1, Number(stepCount) || 1);
  next.step_index = ((Number(next.step_index) || 0) % safeStepCount + safeStepCount) % safeStepCount;
  next.cycles_in_step = Math.max(0, Number(next.cycles_in_step || 0));
  next.total_turns = Math.max(0, Number(next.total_turns || 0));
  next.total_cycles = Math.max(0, Number(next.total_cycles || 0));
  next.last_transition_reason = typeof next.last_transition_reason === 'string' && next.last_transition_reason.trim()
    ? next.last_transition_reason.trim()
    : base.last_transition_reason;
  return next;
};

const parseWorkflowSteps = (text) => {
  const lines = text.split('\n');
  const steps = [];
  let current = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      if (current && current.instruction.trim()) steps.push(current);
      current = { name: header[1].trim(), instruction: '' };
      continue;
    }
    if (!current) {
      current = { name: `step_${steps.length + 1}`, instruction: '' };
    }
    current.instruction += `${line}\n`;
  }
  if (current && current.instruction.trim()) steps.push(current);

  const cleaned = steps
    .map((s, i) => ({
      name: s.name || `step_${i + 1}`,
      instruction: s.instruction.trim()
    }))
    .filter((s) => s.instruction.length > 0);

  return cleaned.length > 0 ? cleaned : DEFAULT_WORKFLOW_STEPS;
};

const loadWorkflowSteps = async () => {
  try {
    const raw = await readFile(WORKFLOW_FILE, 'utf8');
    return parseWorkflowSteps(raw);
  } catch {
    return DEFAULT_WORKFLOW_STEPS;
  }
};

const loadWorkflowState = async (stepCount = DEFAULT_WORKFLOW_STEPS.length) => {
  try {
    const raw = await readFile(WORKFLOW_STATE_FILE, 'utf8');
    return sanitizeWorkflowState(JSON.parse(raw), stepCount);
  } catch {
    const state = defaultWorkflowState();
    try {
      await writeFile(WORKFLOW_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch {}
    return state;
  }
};

const saveWorkflowState = async (state, stepCount = DEFAULT_WORKFLOW_STEPS.length) => {
  try {
    await writeFile(WORKFLOW_STATE_FILE, JSON.stringify(sanitizeWorkflowState(state, stepCount), null, 2), 'utf8');
  } catch {}
};
const getActiveWorkflowStep = (state, steps) => {
  const safe = Array.isArray(steps) && steps.length > 0 ? steps : DEFAULT_WORKFLOW_STEPS;
  const idx = ((state.step_index || 0) % safe.length + safe.length) % safe.length;
  return safe[idx];
};

const buildWorkflowDirective = (state, speaker, steps) => {
  if (!WORKFLOW_ENABLED) return '';
  const step = getActiveWorkflowStep(state, steps);
  const safeSteps = Array.isArray(steps) && steps.length > 0 ? steps : DEFAULT_WORKFLOW_STEPS;
  const lines = ['[workflow]'];
  lines.push(`Step ${state.step_index + 1} of ${safeSteps.length}: ${step.name}`);
  lines.push(`Cycles in this step: ${state.cycles_in_step}/${WORKFLOW_CYCLE_WINDOW}`);
  lines.push(`Total turns: ${state.total_turns}`);
  lines.push(`Total cycles: ${state.total_cycles}`);
  lines.push(`Instruction: ${step.instruction}`);

  if (speaker === 'Moderator') {
    lines.push('Role rule: You are a facilitator, not an idea generator.');
    lines.push('Do not pitch ideas or solutions. Only push process and decisions.');
    lines.push('If no intervention is needed right now, output exactly: NO_INTERVENTION');
  }
  lines.push("Speak as a teammate in a shared conversation. Prefer 'we' and 'let's' where natural.");
  lines.push('Output one concrete contribution now, not a statement about what you plan to do next.');
  lines.push('Never use any speaker labels or persona-name prefixes.');
  return lines.join('\n');
};

const formatWorkflowMessage = (state, steps) => {
  const step = getActiveWorkflowStep(state, steps);
  const safeSteps = Array.isArray(steps) && steps.length > 0 ? steps : DEFAULT_WORKFLOW_STEPS;
  const lines = [];
  lines.push(`Step ${state.step_index + 1} of ${safeSteps.length}: ${step.name}`);
  lines.push(`Instruction: ${step.instruction}`);
  lines.push(`Cycles in step: ${state.cycles_in_step}/${WORKFLOW_CYCLE_WINDOW}`);
  lines.push(`Total turns: ${state.total_turns}`);
  lines.push(`Total cycles: ${state.total_cycles}`);
  if (state.last_transition_reason) {
    lines.push(`Reason: ${state.last_transition_reason}`);
  }
  return lines.join('\n');
};

const appendVisibleWorkflowTurn = async (turns, state, steps) => {
  const content = formatWorkflowMessage(state, steps);
  turns.push({ speaker: 'Workflow', content });
  await writeFile(FILE, JSON.stringify(turns, null, 2), 'utf8');
  const block = `**Workflow**:\n\n${content}${TURN_SEP}`;
  await writeFile(LOG_FILE, block, { flag: 'a', encoding: 'utf8' });
  process.stdout.write(block);
};

const advanceWorkflowAfterTurn = async (state, steps, turns, cycleCompletedThisTurn) => {
  const safeSteps = Array.isArray(steps) && steps.length > 0 ? steps : DEFAULT_WORKFLOW_STEPS;
  const next = sanitizeWorkflowState(state, safeSteps.length);
  next.total_turns += 1;
  if (cycleCompletedThisTurn) {
    next.total_cycles += 1;
    next.cycles_in_step += 1;
    if (next.cycles_in_step >= WORKFLOW_CYCLE_WINDOW) {
      next.step_index = (next.step_index + 1) % safeSteps.length;
      next.cycles_in_step = 0;
      next.last_transition_reason = `advanced after ${WORKFLOW_CYCLE_WINDOW} full cycles`;
      await appendVisibleWorkflowTurn(turns, next, safeSteps);
    }
  }
  await saveWorkflowState(next, safeSteps.length);
  return next;
};

const hasTranscriptContamination = (text, knownSpeakerNames) => {
  if (TRANSCRIPT_MARKER.test(text)) return true;
  const lines = text.split('\n');
  const commonNonSpeakerLabels = new Set([
    'note', 'idea', 'ideas', 'option', 'options', 'summary', 'action', 'actions',
    'pros', 'cons', 'plan', 'result', 'output', 'reason'
  ]);

  const editDistance = (a, b) => {
    const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
    for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
    for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
    for (let i = 1; i <= a.length; i += 1) {
      for (let j = 1; j <= b.length; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + cost
        );
      }
    }
    return dp[a.length][b.length];
  };

  const isSpeakerLikeLabel = (labelRaw) => {
    const compact = labelRaw.replace(/\s+/g, ' ').trim();
    if (!compact) return false;
    const normalized = compact.toLowerCase().replace(/[^a-z]/g, '');
    if (!normalized || commonNonSpeakerLabels.has(normalized)) return false;
    if (knownSpeakerNames.has(normalized)) return true;
    for (const known of knownSpeakerNames) {
      if (!known || known.length < 3) continue;
      if (Math.abs(known.length - normalized.length) > 2) continue;
      if (editDistance(normalized, known) <= 2) return true;
    }
    return false;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^\*\*[A-Za-z][A-Za-z0-9_ ]{1,25}\*\*:\s*/.test(line)) return true;

    const labelMatch = line.match(/^(?:[-*]\s+)?([A-Za-z][A-Za-z0-9_ ]{1,25}):\s+/);
    if (!labelMatch) continue;
    if (isSpeakerLikeLabel(labelMatch[1])) return true;
  }
  return false;
};

const sentenceCount = (text) => text.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean).length;

const isModeratorProcessNudge = (text) => {
  const processHint = /\b(decide|decision|agree|consensus|pick|choose|vote|shortlist|narrow|move on|switch|next step|focus)\b/i;
  const contentPitch = /\b(idea|launch|build|create|product|platform|service|course|marketplace|app|subscription)\b/i;
  if (!processHint.test(text)) return false;
  if (contentPitch.test(text)) return false;
  const sentences = sentenceCount(text);
  if (sentences < 1 || sentences > 2) return false;
  return text.length <= 260;
};

const normalizeModeratorOutput = (text) => {
  const trimmed = (text || '').trim();
  if (!MODERATOR_STRICT_MODE) return trimmed;
  if (/^NO_INTERVENTION\.?$/i.test(trimmed)) return 'NO_INTERVENTION';
  if (isModeratorProcessNudge(trimmed)) return trimmed;
  return 'NO_INTERVENTION';
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

const generateAttempt = async (payload, knownSpeakerNames, statusText = '') => {
  const indicator = startThinkingIndicator(statusText);
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

    if (DISCARD_MODE === 'transcript_only' && hasTranscriptContamination(fullResponse, knownSpeakerNames)) {
      return { ok: false, reason: 'multi-speaker-transcript', toolCalls: [] };
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
const knownSpeakerNames = new Set(
  [
    ...allPersonaFiles.map((f) => f.replace(/\.txt$/i, '').toLowerCase()),
    'narrator',
    'workflow'
  ].filter(Boolean)
);
const maxPersonaTurns = KEEP_CYCLES * personaSpeakers.size;

let personas = shufflePersonas(allPersonaFiles, availableSpecialPersonas);
let personaIndex = 0;
let workflowSteps = WORKFLOW_ENABLED ? await loadWorkflowSteps() : DEFAULT_WORKFLOW_STEPS;
let workflowState = WORKFLOW_ENABLED ? await loadWorkflowState(workflowSteps.length) : defaultWorkflowState();

while (true) {
  if (WORKFLOW_ENABLED) {
    workflowSteps = await loadWorkflowSteps();
    workflowState = sanitizeWorkflowState(workflowState, workflowSteps.length);
  }
  const system = await readFile(SYSTEM_FILE, 'utf8');
  let turns = [];
  let hasPersonaHistory = false;
  try {
    const raw = await readFile(FILE, 'utf8');
    if (raw.trim()) {
      turns = JSON.parse(raw);
      if (!Array.isArray(turns)) turns = [];
    }
  } catch {
    turns = [];
  }

  if (WORKFLOW_ENABLED) {
    hasPersonaHistory = turns.some((turn) => personaSpeakers.has(turn.speaker));
    if (!hasPersonaHistory) {
      workflowState = defaultWorkflowState();
      await saveWorkflowState(workflowState, workflowSteps.length);
    }
  }

  let seededThisTurn = false;
  if (turns.length === 0) {
    const seed = await readFile(SEED_FILE, 'utf8');
    if (seed.trim().length) {
      turns = [{ speaker: 'seed', content: seed.trim() }];
      await writeFile(FILE, JSON.stringify(turns, null, 2), 'utf8');
      await writeFile(LOG_FILE, `${seed.trim()}\n`, { flag: 'a', encoding: 'utf8' });
      process.stdout.write(`${seed.trim()}\n`);
      seededThisTurn = true;
    }
  }

  if (WORKFLOW_ENABLED) {
    const hasWorkflowTurn = turns.some((turn) => turn.speaker === 'Workflow');
    if (seededThisTurn || (!hasPersonaHistory && !hasWorkflowTurn)) {
      await writeFile(LOG_FILE, '\n', { flag: 'a', encoding: 'utf8' });
      process.stdout.write('\n');
      await appendVisibleWorkflowTurn(turns, workflowState, workflowSteps);
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
  let cycleCompletedThisTurn = false;
  personaIndex += 1;
  if (personaIndex >= personas.length) {
    personas = shufflePersonas(allPersonaFiles, availableSpecialPersonas);
    personaIndex = 0;
    cycleCompletedThisTurn = true;
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

  const workflowDirective = buildWorkflowDirective(workflowState, speaker, workflowSteps);
  const systemPrompt = [persona.trim(), workflowDirective.trim(), system.trim(), ...contextBlocks]
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
    const statusText = `(Turn ${workflowState.total_turns + 1}: Cycle ${workflowState.total_cycles + 1})`;
    const result = await generateAttempt(payload, knownSpeakerNames, statusText);
    if (result.ok) {
      accepted = result;
      break;
    }

    const audit = `[discarded invalid multi-speaker turn] speaker=${speaker} attempt=${attempt} reason=${result.reason}${TURN_SEP}`;
    await writeFile(LOG_FILE, audit, { flag: 'a', encoding: 'utf8' });
    clearTerminalLine();
    process.stdout.write(audit);
  }

  if (!accepted) {
    const skip = `[skipped turn after invalid retries] speaker=${speaker} retries=${MAX_INVALID_TURN_RETRIES}\n\n`;
    await writeFile(LOG_FILE, skip, { flag: 'a', encoding: 'utf8' });
    clearTerminalLine();
    process.stdout.write(skip);

    if (WORKFLOW_ENABLED) {
      workflowState = await advanceWorkflowAfterTurn(workflowState, workflowSteps, turns, cycleCompletedThisTurn);
    }

    await sleep(SLEEP_MS);
    continue;
  }

  let fullResponse = accepted.fullResponse;
  if (speaker === 'Moderator') {
    fullResponse = normalizeModeratorOutput(fullResponse);
  }
  const isModeratorNoIntervention =
    speaker === 'Moderator' && /^NO_INTERVENTION\.?$/i.test(fullResponse);

  if (isModeratorNoIntervention) {
    const note = `[moderator no intervention]${TURN_SEP}`;
    await writeFile(LOG_FILE, note, { flag: 'a', encoding: 'utf8' });
    clearTerminalLine();
    process.stdout.write(note);

    if (WORKFLOW_ENABLED) {
      workflowState = await advanceWorkflowAfterTurn(workflowState, workflowSteps, turns, cycleCompletedThisTurn);
    }

    await sleep(SLEEP_MS);
    continue;
  }

  if (!fullResponse.trim()) {
    const blankNote = `[blank turn: no content generated]${TURN_SEP}`;
    await writeFile(LOG_FILE, blankNote, { flag: 'a', encoding: 'utf8' });
    clearTerminalLine();
    process.stdout.write(blankNote);
    await sleep(SLEEP_MS);
    continue;
  }

  const toolCalls = accepted.toolCalls;
  const prefix = `**${speaker}**:\n\n`;
  await writeFile(LOG_FILE, prefix, { flag: 'a', encoding: 'utf8' });
  await writeFile(LOG_FILE, fullResponse, { flag: 'a', encoding: 'utf8' });
  clearTerminalLine();
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

  if (WORKFLOW_ENABLED) {
    workflowState = await advanceWorkflowAfterTurn(workflowState, workflowSteps, turns, cycleCompletedThisTurn);
  }

  await sleep(SLEEP_MS);
}
