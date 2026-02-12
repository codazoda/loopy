#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const LOG_FILE = process.env.CONVO_LOG || 'conversation.log';
const TURN_SEP = '\n\n---\n\n';

// Parse conversation into turns
async function parseConversation() {
  const content = await readFile(LOG_FILE, 'utf8');
  const turns = content.split(TURN_SEP).filter(t => t.trim());
  return turns.map((turn, idx) => {
    const match = turn.match(/^\*\*([^*]+)\*\*:/);
    const speaker = match ? match[1] : 'Unknown';
    const text = turn.replace(/^\*\*[^*]+\*\*:\s*/, '').trim();
    return { idx, speaker, text, turn };
  });
}

// Test 1: Detect repetitive phrases
function detectRepetition(turns, windowSize = 10, threshold = 0.7) {
  const issues = [];

  for (let i = windowSize; i < turns.length; i++) {
    const window = turns.slice(i - windowSize, i);
    const phrases = window.map(t => t.text.toLowerCase());

    // Count unique phrases
    const uniquePhrases = new Set(phrases);
    const uniqueRatio = uniquePhrases.size / phrases.length;

    if (uniqueRatio < threshold) {
      issues.push({
        type: 'REPETITION',
        turn: i,
        uniqueRatio: uniqueRatio.toFixed(2),
        message: `Low diversity in turns ${i - windowSize}-${i}: ${(uniqueRatio * 100).toFixed(0)}% unique`
      });
    }
  }

  return issues;
}

// Test 2: Detect phrase loops (same phrase appearing multiple times consecutively)
function detectPhraseLoops(turns, minOccurrences = 5) {
  const issues = [];
  const commonPhrases = [
    'let\'s finalize',
    'looking forward to seeing',
    'sounds good',
    'allocate resources',
    'reminder email',
    'next week',
    'user testing and feedback'
  ];

  for (const phrase of commonPhrases) {
    let count = 0;
    let startIdx = -1;

    for (let i = 0; i < turns.length; i++) {
      if (turns[i].text.toLowerCase().includes(phrase)) {
        if (count === 0) startIdx = i;
        count++;
      }
    }

    if (count >= minOccurrences) {
      issues.push({
        type: 'PHRASE_LOOP',
        phrase,
        count,
        startTurn: startIdx,
        message: `Phrase "${phrase}" appears ${count} times (starts at turn ${startIdx})`
      });
    }
  }

  return issues;
}

// Test 3: Check for tool usage
function checkToolUsage(turns) {
  const toolCalls = turns.filter(t => t.text.includes('[TOOL_CALLS]'));
  const issues = [];

  if (toolCalls.length === 0) {
    issues.push({
      type: 'NO_TOOLS',
      message: 'No tool calls found in entire conversation',
      severity: 'WARNING'
    });
  }

  return issues;
}

// Test 4: Detect "planning about planning" anti-pattern
function detectMetaPlanning(turns, threshold = 10) {
  const metaPlanningPhrases = [
    'finalize the plan',
    'discuss the plan',
    'confirm that we have a plan',
    'let\'s finalize that plan'
  ];

  let count = 0;
  const occurrences = [];

  turns.forEach((turn, idx) => {
    const text = turn.text.toLowerCase();
    if (metaPlanningPhrases.some(p => text.includes(p))) {
      count++;
      occurrences.push(idx);
    }
  });

  const issues = [];
  if (count > threshold) {
    issues.push({
      type: 'META_PLANNING',
      count,
      threshold,
      occurrences: occurrences.slice(0, 5), // First 5 occurrences
      message: `Excessive meta-planning detected: ${count} turns about "planning" (threshold: ${threshold})`
    });
  }

  return issues;
}

// Test 5: Check conversation progression (are speakers making unique contributions?)
function checkProgression(turns, windowSize = 20) {
  const issues = [];

  for (let i = windowSize; i < turns.length; i += windowSize) {
    const window = turns.slice(i - windowSize, i);
    const uniqueWords = new Set();
    const totalWords = [];

    window.forEach(turn => {
      const words = turn.text.toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 4); // Only words > 4 chars
      totalWords.push(...words);
      words.forEach(w => uniqueWords.add(w));
    });

    const vocabularyRatio = uniqueWords.size / totalWords.length;

    if (vocabularyRatio < 0.3) {
      issues.push({
        type: 'LOW_PROGRESSION',
        turn: i,
        vocabularyRatio: vocabularyRatio.toFixed(2),
        message: `Low vocabulary diversity in turns ${i - windowSize}-${i}: ${(vocabularyRatio * 100).toFixed(0)}% unique words`
      });
    }
  }

  return issues;
}

// Main test runner
async function runTests() {
  console.log('🔍 Analyzing conversation health...\n');

  const turns = await parseConversation();
  console.log(`📊 Total turns: ${turns.length}\n`);

  const allIssues = [];

  // Run all tests
  allIssues.push(...detectRepetition(turns));
  allIssues.push(...detectPhraseLoops(turns));
  allIssues.push(...checkToolUsage(turns));
  allIssues.push(...detectMetaPlanning(turns));
  allIssues.push(...checkProgression(turns));

  // Report results
  if (allIssues.length === 0) {
    console.log('✅ No issues detected!');
    return;
  }

  console.log(`❌ Found ${allIssues.length} issues:\n`);

  // Group by type
  const byType = {};
  allIssues.forEach(issue => {
    if (!byType[issue.type]) byType[issue.type] = [];
    byType[issue.type].push(issue);
  });

  Object.entries(byType).forEach(([type, issues]) => {
    console.log(`\n${type} (${issues.length} occurrences):`);
    console.log('─'.repeat(50));
    issues.forEach(issue => {
      console.log(`  • ${issue.message}`);
    });
  });

  // Exit with error code if critical issues found
  const criticalTypes = ['PHRASE_LOOP', 'META_PLANNING', 'LOW_PROGRESSION'];
  const hasCritical = allIssues.some(i => criticalTypes.includes(i.type));

  if (hasCritical) {
    console.log('\n⚠️  Critical conversation health issues detected!');
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
