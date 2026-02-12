# Fixes for Conversation Loop Issues

## Problems Confirmed by Tests

1. **Phrase loops**: "allocate resources" appears 24 times, "sounds good" 22 times
2. **No tool usage**: Zero tool calls despite tool being available
3. **Meta-planning**: 16 turns about "planning" without action
4. **Low progression**: Vocabulary diversity drops to 14% in later turns

## Implemented Fixes

### ✅ Fix 1: Shuffle After Each Turn (DONE)

**Problem:** Same personas in same order leads to repetitive patterns.

**Solution:** Shuffle the persona order after EVERY turn, keeping conversation unpredictable.

**Implementation in loopy.js:**
- Added `shufflePersonas()` function that shuffles regular personas
- Keeps special personas (narrator.txt, secretary.txt) at the end in order
- Shuffles and resets to position 0 after each turn completes

**Why this works:**
- No complex logic needed
- Prevents speaker patterns from forming
- Ensures variety without manual intervention
- Special personas (narrator, secretary) always go last to observe and record

### ✅ Fix 2: Special Personas System (DONE)

**Created two special personas that always go last:**

**moderator.txt** - Circuit breaker who intervenes when conversation loops:
- Detects repetition, meta-planning, lack of progress
- Provides BRIEF, DIRECT interventions (1-2 sentences)
- Only speaks when there's a clear problem
- Goal: Prevent analysis paralysis

**secretary.txt** (renamed from blackwell.txt) - Records ONLY confirmed decisions:
- Has plan.update tool enabled
- STRICT rules about when to record (only after explicit consensus)
- Clear examples of what to record vs. ignore
- Prevents tool spam by requiring confirmation

**Why they go last:**
- Moderator can observe full turn and detect patterns
- Secretary can hear full discussion before deciding to record
- Both need context from regular personas first

**Note:** System messages (advisor availability) use `[Narrator: ...]` format, while the Moderator persona uses `**Moderator**:` format to avoid confusion.

### 🔧 Fix 3: Better Tool Guidelines (DONE)

**Problem:** Tools were either unused OR called too often.

**Solution:** Clear, strict criteria in secretary.txt:
- Must have explicit agreement from 2-3 people
- Must ask "Does everyone confirm this decision?"
- Clear examples of recordable vs. non-recordable statements
- Short, clear instruction format for plan.update

### 📋 Remaining Optional Fixes

### Fix 4: Increase Context Window (OPTIONAL)

Current MAX_TURNS=6 may be too short for complex discussions.

```bash
MAX_TURNS=12  # Consider doubling to reduce amnesia
```

### Fix 5: Circuit Breaker Code (OPTIONAL)

Add automated repetition detection in loopy.js (in addition to narrator persona):

```javascript
// After tool execution, before TURN_SEP:
const recentTurns = parts.slice(-5);
const repetitiveWords = ['finalize', 'allocate', 'sounds good', 'next week'];
let score = 0;
recentTurns.forEach(t => {
  repetitiveWords.forEach(w => {
    if (t.toLowerCase().includes(w)) score++;
  });
});

if (score > 8) {
  const msg = `\n[System: Repetition detected. Take concrete action or change topic.]\n`;
  await writeFile(FILE, msg, { flag: 'a' });
  await writeFile(LOG_FILE, msg, { flag: 'a' });
  process.stdout.write(msg);
}
```

## Testing

Run health tests:
```bash
node test-conversation-health.js
```

Success criteria:
- ✅ Phrase loops < 10 occurrences per phrase
- ✅ At least 1 [TOOL_CALLS] per 20 turns (if decisions being made)
- ✅ Meta-planning mentions < 5
- ✅ Vocabulary diversity > 30% in all windows

## Summary of Changes

**Files Modified:**
- ✅ `loopy.js` - Added shuffle-after-turn logic with special personas
- ✅ `persona/blackwell.txt` → `persona/secretary.txt` - Renamed, re-enabled tools with strict criteria
- ✅ `persona/moderator.txt` - Created circuit-breaker persona (renamed from narrator to avoid conflict with system narrator)

**Files Created:**
- ✅ `test-conversation-health.js` - Automated conversation health tests
- ✅ `reset-conversation.js` - Utility to reset when stuck
- ✅ `loopy-fixes.md` - This document

**Key Insight:**
The simpler approach (shuffle after each turn + special personas) is more elegant than complex detection logic. Let the narrator persona handle circuit-breaking naturally.
