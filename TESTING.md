# Testing the Fixes

## What Changed

### Code Changes (loopy.js)
1. **Shuffle after each turn** - Personas randomize after every response
2. **Special personas system** - `narrator.txt` and `secretary.txt` always go last

### Persona Changes
1. **blackwell.txt → secretary.txt** - Renamed and updated
   - Tools re-enabled with STRICT criteria
   - Only records confirmed decisions with explicit consensus

2. **moderator.txt** - NEW circuit-breaker persona
   - Detects loops and intervenes
   - Speaks only when conversation is stuck
   - Provides direct, actionable feedback

## How Persona Order Works Now

**Each turn:**
1. Shuffle all regular personas (kane, hendricks, wellington)
2. Add special personas at end: [moderator, secretary]
3. Pick next persona from shuffled list
4. After turn completes, repeat shuffle

**Example rotation:**
```
Turn 1: Wellington → Moderator → Secretary (shuffle)
Turn 2: Hendricks → Moderator → Secretary (shuffle)
Turn 3: Kane → Moderator → Secretary (shuffle)
Turn 4: Wellington → Moderator → Secretary (shuffle)
... always random, but moderator/secretary always last
```

**Note:** System messages (advisor availability) appear as `[Narrator: ...]` while the Moderator persona appears as `**Moderator**:` to avoid naming confusion.

## Testing Steps

### 1. Check Syntax
```bash
node -c loopy.js
# Should output: ✓ loopy.js syntax is valid
```

### 2. Reset Conversation
```bash
node reset-conversation.js
# Backs up old conversation, starts fresh
```

### 3. Run a Short Test
```bash
# Run for ~10 turns (50 seconds with default SLEEP_MS=5000)
timeout 50 node loopy.js | head -100

# Or manually run and watch:
node loopy.js
# Press Ctrl+C after ~10 turns
```

### 4. Check Health
```bash
node test-conversation-health.js
```

**Expected improvements:**
- ✅ Phrase loops should be < 10 per phrase (was 24)
- ✅ Speaker variety should be high (shuffling working)
- ✅ If decisions are made, should see [TOOL_CALLS] blocks
- ✅ Narrator should intervene if looping starts

### 5. Inspect Outputs

**Check conversation.log for:**
```bash
# Should see varied speaker order
grep "^\*\*" conversation.log | head -20

# Should see Moderator and Secretary always last in each cycle
grep -E "^\*\*(Moderator|Secretary)" conversation.log

# Should see system narrator messages (advisor availability) in brackets
grep "^\[Narrator:" conversation.log

# Should see tool calls if decisions were confirmed
grep "\[TOOL_CALLS\]" conversation.log
```

**Check context/plan.txt for:**
```bash
cat context/plan.txt
# Should contain recorded decisions (if any were made)
```

## Success Criteria

### Short-term (10-20 turns)
- [ ] No phrase appears more than 5-6 times
- [ ] Speaker order is varied (not same rotation)
- [ ] Moderator and Secretary always appear last
- [ ] If team makes a decision, Secretary records it

### Medium-term (50+ turns)
- [ ] Conversation doesn't loop endlessly
- [ ] Ideas progress to decisions
- [ ] Moderator intervenes if conversation stalls
- [ ] Plan.txt contains actual decisions, not brainstorms

## Debugging

### If personas aren't shuffling:
```bash
# Add debug output to loopy.js after shuffle:
console.log('Shuffled order:', personas.join(', '));
```

### If tools aren't being called:
- Check secretary.txt has `tools: [plan.update]` in frontmatter
- Verify team is using confirmation language ("Does everyone confirm?")
- Check conversation.log for [TOOL_CALLS] blocks

### If Moderator doesn't speak:
- Moderator only speaks when detecting problems
- If conversation is healthy, Moderator stays silent (this is good!)
- To test: manually create a loop by editing conversation.txt

## Next Steps

After testing shows improvement:
- Consider increasing KEEP_CYCLES from 6 to 8 for better memory
- Add more regular personas for variety
- Fine-tune moderator.txt intervention triggers
- Adjust secretary.txt tool criteria if too strict/loose
