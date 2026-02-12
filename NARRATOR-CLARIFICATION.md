# Narrator vs Moderator Clarification

## The Problem
We had a naming collision between two different "Narrator" entities:

1. **System Narrator** - Scheduled advisor availability announcements (from advisor.txt)
2. **Narrator Persona** - Reactive loop-breaking persona (from persona/narrator.txt)

## The Solution
Renamed the persona to avoid confusion:

### System Narrator (Unchanged)
**File:** `advisor.txt`
**Format:** `[Narrator: ...]` (in brackets, no speaker name)
**Purpose:** Announces when human advisor Joel is available
**Timing:** Scheduled - every ADVISOR_INTERVAL_MS (default: 24 hours)
**Example:**
```
[Narrator: Your advisor Joel is available today if you need help building something.
Stay focused on your business planning—only reach out with "Dear Advisor" if you've
identified something specific that needs to be implemented. Be mindful of his time.]
```

### Moderator Persona (New)
**File:** `persona/moderator.txt`
**Format:** `**Moderator**:` (standard persona format)
**Purpose:** Breaks conversation loops, prevents analysis paralysis
**Timing:** Reactive - speaks only when detecting problems
**Position:** Special persona, always goes last (before Secretary)
**Example:**
```
**Moderator**: This conversation is looping. Pick ONE thing to actually DO
right now, or move to a completely different topic.
```

## How They Appear in Conversation

```
**Kane**: Let's build a skill swap app!

**Wellington**: That sounds interesting. What features should it have?

**Hendricks**: Maybe we could add social features?

[Narrator: Your advisor Joel is available today if you need help building
something. Stay focused on your business planning—only reach out with
"Dear Advisor" if you've identified something specific that needs to be
implemented. Be mindful of his time.]

**Kane**: Good point. Let's focus on the core features first.

**Moderator**: [Only speaks if conversation starts looping]

**Secretary**: [Records decision if team confirms something]
```

## Special Persona Order

Both Moderator and Secretary are "special personas" that always go last:

```javascript
const SPECIAL_PERSONAS = ['moderator.txt', 'secretary.txt'];
```

**Each turn:**
1. Regular personas shuffled: [Kane, Hendricks, Wellington] → random order
2. Special personas appended in order: [...regular, Moderator, Secretary]
3. Next persona selected from this list
4. After turn completes, shuffle again

**Why this order matters:**
- **Moderator** needs to observe the full discussion to detect loops
- **Secretary** needs to hear full discussion to decide if something should be recorded
- Both benefit from seeing what regular personas said first

## Quick Reference

| Entity | File | Format | When It Appears |
|--------|------|--------|----------------|
| System Narrator | advisor.txt | `[Narrator: ...]` | Every 24h (scheduled) |
| Moderator | persona/moderator.txt | `**Moderator**:` | When loops detected (reactive) |
| Secretary | persona/secretary.txt | `**Secretary**:` | Every rotation (last) |

## Why This Matters

1. **Clear separation** - System vs persona messages are visually distinct
2. **No confusion** - Different names for different purposes
3. **Intentional design** - Brackets = system, ** = persona
4. **Future-proof** - Can add more system messages without collision
