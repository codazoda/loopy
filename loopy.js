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
const WORKFLOW_STATE_FILE = process.env.WORKFLOW_STATE_FILE || `${CONTEXT_DIR}/workflow_state.json`;
const WORKFLOW_STAGES = ['brainstorm', 'cluster', 'shortlist', 'decide', 'next_action'];
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

const normalizeOption = (text) =>
  text
    .toLowerCase()
    .replace(/[`"'*_[\](){}]/g, ' ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const defaultWorkflowState = () => ({
  stage: 'brainstorm',
  cycle_count_in_stage: 0,
  candidate_options: [],
  shortlist_options: [],
  locked_decision: null,
  last_transition_reason: 'initial',
  decide_window_failures: 0
});

const cleanOptionList = (value, limit) => {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const cleaned = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const option = item.trim().replace(/\s+/g, ' ');
    if (option.length < 8) continue;
    const key = normalizeOption(option);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    cleaned.push(option);
    if (cleaned.length >= limit) break;
  }
  return cleaned;
};

const sanitizeWorkflowState = (state) => {
  const base = defaultWorkflowState();
  if (!state || typeof state !== 'object') return base;
  const next = { ...base, ...state };
  if (!WORKFLOW_STAGES.includes(next.stage)) next.stage = base.stage;
  next.cycle_count_in_stage = Math.max(0, Number(next.cycle_count_in_stage || 0));
  next.decide_window_failures = Math.max(0, Number(next.decide_window_failures || 0));
  next.candidate_options = cleanOptionList(next.candidate_options, 12);
  next.shortlist_options = cleanOptionList(next.shortlist_options, 3);
  next.locked_decision = typeof next.locked_decision === 'string' && next.locked_decision.trim()
    ? next.locked_decision.trim()
    : null;
  next.last_transition_reason = typeof next.last_transition_reason === 'string' && next.last_transition_reason.trim()
    ? next.last_transition_reason.trim()
    : base.last_transition_reason;
  return next;
};

const loadWorkflowState = async () => {
  try {
    const raw = await readFile(WORKFLOW_STATE_FILE, 'utf8');
    return sanitizeWorkflowState(JSON.parse(raw));
  } catch {
    const state = defaultWorkflowState();
    try {
      await writeFile(WORKFLOW_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch {}
    return state;
  }
};

const saveWorkflowState = async (state) => {
  try {
    await writeFile(WORKFLOW_STATE_FILE, JSON.stringify(sanitizeWorkflowState(state), null, 2), 'utf8');
  } catch {}
};

const extractOptionsFromText = (text) => {
  const options = [];
  const lines = text.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const bullet = line.match(/^[-*]\s+(.+)$/);
    const numbered = line.match(/^\d+[.)]\s+(.+)$/);
    const candidate = bullet?.[1] || numbered?.[1] || '';
    if (!candidate) continue;
    if (/^no confirmed decisions yet\.?$/i.test(candidate)) continue;
    if (candidate.length < 8 || candidate.length > 220) continue;
    options.push(candidate.replace(/\s+/g, ' ').trim());
  }
  if (options.length > 0) return options;

  const sentences = text
    .replace(/\s+/g, ' ')
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sentence of sentences) {
    if (sentence.length < 25 || sentence.length > 180) continue;
    if (/^(i agree|we should choose|no intervention)/i.test(sentence)) continue;
    options.push(sentence);
    if (options.length >= 3) break;
  }
  return options;
};

const collectCandidateOptions = (turns, personaSpeakers) => {
  const recentPersonaTurns = turns
    .filter((turn) => personaSpeakers.has(turn.speaker))
    .slice(-50);
  const collected = [];
  for (const turn of recentPersonaTurns) {
    collected.push(...extractOptionsFromText(turn.content || ''));
  }
  return cleanOptionList(collected, 12);
};

const pickTopOptions = (options, limit) => cleanOptionList(options, limit);

const detectAgreementDecision = (turns, personaSpeakers, shortlistOptions) => {
  const recentPersonaTurns = turns
    .filter((turn) => personaSpeakers.has(turn.speaker))
    .slice(-40);
  if (recentPersonaTurns.length === 0) return null;

  const optionSets = shortlistOptions.map((option) => ({
    option,
    key: normalizeOption(option),
    supporters: new Set()
  }));

  for (const turn of recentPersonaTurns) {
    const content = (turn.content || '').trim();
    if (!content) continue;
    if (!/\b(i agree|i support|i vote for|i pick|i choose|my vote is|we should choose|i'm for)\b/i.test(content)) {
      continue;
    }
    const contentNorm = normalizeOption(content);
    let matched = null;
    for (const option of optionSets) {
      if (!option.key) continue;
      if (contentNorm.includes(option.key)) {
        matched = option;
        break;
      }
    }
    if (matched) matched.supporters.add(turn.speaker);
  }

  let winner = null;
  for (const option of optionSets) {
    if (option.supporters.size >= 2) {
      if (!winner || option.supporters.size > winner.supporters.size) winner = option;
    }
  }
  return winner ? winner.option : null;
};

const evaluateWorkflowState = (state, turns, personaSpeakers) => {
  const next = sanitizeWorkflowState(state);
  const reason = [];
  next.candidate_options = collectCandidateOptions(turns, personaSpeakers);

  if (next.stage === 'brainstorm') {
    if (next.candidate_options.length >= 5) {
      next.stage = 'cluster';
      next.cycle_count_in_stage = 0;
      next.last_transition_reason = 'enough ideas captured for clustering';
      return next;
    }
  } else if (next.stage === 'cluster') {
    if (next.candidate_options.length >= 4 || next.cycle_count_in_stage >= 2) {
      next.shortlist_options = pickTopOptions(next.candidate_options, 3);
      if (next.shortlist_options.length >= 2) {
        next.stage = 'shortlist';
        next.cycle_count_in_stage = 0;
        next.last_transition_reason = 'clustered ideas into shortlist';
        return next;
      }
      reason.push('not enough strong options for shortlist');
    }
  } else if (next.stage === 'shortlist') {
    if (next.shortlist_options.length < 2) {
      next.shortlist_options = pickTopOptions(next.candidate_options, 3);
    }
    if (next.shortlist_options.length >= 2 && next.cycle_count_in_stage >= 1) {
      next.stage = 'decide';
      next.cycle_count_in_stage = 0;
      next.decide_window_failures = 0;
      next.last_transition_reason = 'ready for decision vote';
      return next;
    }
  } else if (next.stage === 'decide') {
    if (next.shortlist_options.length < 2) {
      next.shortlist_options = pickTopOptions(next.candidate_options, 3);
    }
    const winner = detectAgreementDecision(turns, personaSpeakers, next.shortlist_options);
    if (winner) {
      next.locked_decision = winner;
      next.stage = 'next_action';
      next.cycle_count_in_stage = 0;
      next.last_transition_reason = 'two explicit agreements reached';
      return next;
    }
    if (next.cycle_count_in_stage >= 1) {
      next.decide_window_failures += 1;
      const forced = pickTopOptions(next.shortlist_options.length > 0 ? next.shortlist_options : next.candidate_options, 2);
      if (forced.length >= 2) {
        next.shortlist_options = forced;
      }
      next.cycle_count_in_stage = 0;
      next.last_transition_reason = 'forced binary choice after stalled decision window';
      return next;
    }
  }

  if (reason.length > 0) next.last_transition_reason = reason.join('; ');
  return next;
};

const buildWorkflowDirective = (state, speaker) => {
  if (!WORKFLOW_ENABLED) return '';
  const lines = ['[workflow]'];
  lines.push(`Current stage: ${state.stage}`);
  lines.push(`Cycles in stage: ${state.cycle_count_in_stage}`);
  if (state.shortlist_options.length > 0) {
    lines.push(`Shortlist options: ${state.shortlist_options.map((o, i) => `${i + 1}. ${o}`).join(' | ')}`);
  }
  if (state.locked_decision) {
    lines.push(`Locked decision: ${state.locked_decision}`);
  }

  if (speaker === 'Moderator') {
    lines.push('Role rule: You are a facilitator, not an idea generator.');
    lines.push('Do not pitch ideas or solutions. Only push process and decisions.');
    lines.push('If no intervention is needed right now, output exactly: NO_INTERVENTION');
  }

  if (state.stage === 'brainstorm') {
    lines.push('Objective: brainstorm now. Contribute 2 distinct ideas in this turn.');
    lines.push("Use team language like 'let's' and build on what others just said.");
    lines.push('Keep ideas concrete and different. Do not decide yet.');
  } else if (state.stage === 'cluster') {
    lines.push('Objective: group and merge overlapping ideas into clear themes.');
  } else if (state.stage === 'shortlist') {
    lines.push('Objective: narrow to at most three concrete options.');
  } else if (state.stage === 'decide') {
    lines.push('Objective: choose one option. State explicit agreement with one shortlist option.');
  } else if (state.stage === 'next_action') {
    lines.push('Objective: define the immediate next action for the locked decision.');
  }
  lines.push("Speak as a teammate in a shared conversation. Prefer 'we' and 'let's' where natural.");
  lines.push('Output one concrete contribution now, not a statement about what you plan to do next.');
  lines.push('Never use any speaker labels or persona-name prefixes.');
  if (state.stage !== 'brainstorm') {
    lines.push('Avoid restarting broad brainstorming unless explicitly asked.');
  }
  return lines.join('\n');
};

const getWorkflowObjectiveText = (stage) => {
  if (stage === 'brainstorm') return 'Brainstorm now. Contribute 2 distinct ideas in this turn.';
  if (stage === 'cluster') return 'Group and merge overlapping ideas into clear themes.';
  if (stage === 'shortlist') return 'Narrow to at most three concrete options.';
  if (stage === 'decide') return 'Choose one option and state explicit agreement.';
  if (stage === 'next_action') return 'Define the immediate next action for the locked decision.';
  return 'Contribute to the current stage objective.';
};

const formatWorkflowMessage = (state) => {
  const lines = [];
  lines.push(`Stage: ${state.stage}`);
  lines.push(`Objective: ${getWorkflowObjectiveText(state.stage)}`);
  if (state.shortlist_options.length > 0) {
    lines.push(`Shortlist: ${state.shortlist_options.join(' | ')}`);
  }
  if (state.locked_decision) {
    lines.push(`Locked decision: ${state.locked_decision}`);
  }
  if (state.last_transition_reason) {
    lines.push(`Reason: ${state.last_transition_reason}`);
  }
  return lines.join('\n');
};

const appendVisibleWorkflowTurn = async (turns, state) => {
  const content = formatWorkflowMessage(state);
  turns.push({ speaker: 'Workflow', content });
  await writeFile(FILE, JSON.stringify(turns, null, 2), 'utf8');
  const block = `**Workflow**:\n\n${content}${TURN_SEP}`;
  await writeFile(LOG_FILE, block, { flag: 'a', encoding: 'utf8' });
  process.stdout.write(block);
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

const isStageAligned = (stage, text) => {
  const t = (text || '').toLowerCase();
  if (stage === 'brainstorm') return /\bidea|option|could|what if|let's try\b/.test(t);
  if (stage === 'cluster') return /\btheme|group|combine|merge|overlap|cluster\b/.test(t);
  if (stage === 'shortlist') return /\bshortlist|top|pick two|pick three|best options\b/.test(t);
  if (stage === 'decide') return /\bchoose|pick|agree|vote|decision\b/.test(t);
  if (stage === 'next_action') return /\bnext step|first step|today|this week|action\b/.test(t);
  return true;
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

const generateAttempt = async (payload, knownSpeakerNames) => {
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
let workflowState = WORKFLOW_ENABLED ? await loadWorkflowState() : defaultWorkflowState();
let pendingWorkflowCycles = 0;

while (true) {
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
      pendingWorkflowCycles = 0;
      await saveWorkflowState(workflowState);
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
      await appendVisibleWorkflowTurn(turns, workflowState);
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

  const workflowDirective = buildWorkflowDirective(workflowState, speaker);
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
    const result = await generateAttempt(payload, knownSpeakerNames);
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

    if (WORKFLOW_ENABLED && cycleCompletedThisTurn) {
      pendingWorkflowCycles += 1;
      workflowState.cycle_count_in_stage += 1;
      if (pendingWorkflowCycles >= WORKFLOW_CYCLE_WINDOW) {
        const prevStage = workflowState.stage;
        workflowState = evaluateWorkflowState(workflowState, turns, personaSpeakers);
        pendingWorkflowCycles = 0;
        await saveWorkflowState(workflowState);
        if (workflowState.stage !== prevStage) {
          await appendVisibleWorkflowTurn(turns, workflowState);
        }
      }
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
    process.stdout.write(note);

    if (WORKFLOW_ENABLED && cycleCompletedThisTurn) {
      pendingWorkflowCycles += 1;
      workflowState.cycle_count_in_stage += 1;
      if (pendingWorkflowCycles >= WORKFLOW_CYCLE_WINDOW) {
        const prevStage = workflowState.stage;
        workflowState = evaluateWorkflowState(workflowState, turns, personaSpeakers);
        pendingWorkflowCycles = 0;
        await saveWorkflowState(workflowState);
        if (workflowState.stage !== prevStage) {
          await appendVisibleWorkflowTurn(turns, workflowState);
        }
      }
    }

    await sleep(SLEEP_MS);
    continue;
  }

  if (!fullResponse.trim()) {
    const blankNote = `[blank turn: no content generated]${TURN_SEP}`;
    await writeFile(LOG_FILE, blankNote, { flag: 'a', encoding: 'utf8' });
    process.stdout.write(blankNote);
    await sleep(SLEEP_MS);
    continue;
  }

  const toolCalls = accepted.toolCalls;
  const prefix = `**${speaker}**:\n\n`;
  await writeFile(LOG_FILE, prefix, { flag: 'a', encoding: 'utf8' });
  await writeFile(LOG_FILE, fullResponse, { flag: 'a', encoding: 'utf8' });
  process.stdout.write(prefix);
  process.stdout.write(fullResponse);

  if (WORKFLOW_ENABLED && speaker !== 'Moderator' && !isStageAligned(workflowState.stage, fullResponse)) {
    const mismatch = `\n[workflow mismatch] stage=${workflowState.stage} speaker=${speaker}\n`;
    await writeFile(LOG_FILE, mismatch, { flag: 'a', encoding: 'utf8' });
    process.stdout.write(mismatch);
  }

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

  if (WORKFLOW_ENABLED && cycleCompletedThisTurn) {
    pendingWorkflowCycles += 1;
    workflowState.cycle_count_in_stage += 1;
    if (pendingWorkflowCycles >= WORKFLOW_CYCLE_WINDOW) {
      const prevStage = workflowState.stage;
      workflowState = evaluateWorkflowState(workflowState, turns, personaSpeakers);
      pendingWorkflowCycles = 0;
      await saveWorkflowState(workflowState);
      if (workflowState.stage !== prevStage) {
        await appendVisibleWorkflowTurn(turns, workflowState);
      }
    }
  }

  await sleep(SLEEP_MS);
}
