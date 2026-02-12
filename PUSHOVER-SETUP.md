# Pushover Setup Guide

The Secretary persona can send push notifications to Joel via Pushover when the team needs help.

## Prerequisites

1. **Pushover Account** - Sign up at https://pushover.net/
2. **Pushover App** - Install on your phone (iOS/Android)

## Setup Steps

### 1. Get Your User Key

1. Log in to https://pushover.net/
2. Your **User Key** is displayed at the top of the dashboard
3. Copy it - you'll need it for `PUSHOVER_USER`

### 2. Create an Application

1. Go to https://pushover.net/apps/build
2. Fill in the form:
   - **Name:** Loopy AI Team (or whatever you prefer)
   - **Type:** Application
   - **Description:** Push notifications from AI conversation loop
   - **URL:** (optional)
   - **Icon:** (optional)
3. Click **Create Application**
4. Copy the **API Token/Key** - you'll need it for `PUSHOVER_TOKEN`

### 3. Set Environment Variables

**Option 1: Use .env file (recommended)**

```bash
# Copy the example file
cp .env.example .env

# Edit .env and add your tokens
# PUSHOVER_TOKEN=azc123example456token789here
# PUSHOVER_USER=uqr123example456userkey789

# Run normally - .env is automatically loaded
node loopy.js
```

**Option 2: Set in shell**

```bash
export PUSHOVER_TOKEN="your-app-api-token-here"
export PUSHOVER_USER="your-user-key-here"
node loopy.js
```

**Note:** The `.env` file is automatically loaded by loopy.js and is already in `.gitignore` for safety.

### 4. Test the Setup

You can test manually with curl:

```bash
curl -s \
  --form-string "token=YOUR_PUSHOVER_TOKEN" \
  --form-string "user=YOUR_PUSHOVER_USER" \
  --form-string "message=Test from Loopy" \
  https://api.pushover.net/1/messages.json
```

Expected response:
```json
{"status":1,"request":"unique-request-id"}
```

## How It Works in Loopy

### When Secretary Sends Notifications

The Secretary persona will call `pushover.notify` when:
- Team addresses "Dear Advisor" or similar
- Team explicitly asks to contact Joel
- There's a specific, actionable request that needs human help

**Example conversation:**
```
**Kane**: We're stuck on the database choice. Dear Advisor, which would
you recommend for our use case - PostgreSQL or MongoDB?

**Secretary**: I'll notify Joel.
[Calls pushover.notify with the question]
```

### What You'll Receive

**On your phone:**
- Title: "Loopy Team" (or custom title)
- Message: The specific request from the team
- Sound/vibration based on your Pushover settings

**In the console:**
```
[pushover.notify] Sent: "Loopy Team" - Team stuck on database choice - needs advice on...
```

## Configuration Options

### Change Default Title

The Secretary can specify a custom title:
```javascript
pushover.notify({
  title: "Urgent: Database Help",
  message: "Team needs PostgreSQL vs MongoDB advice"
})
```

### Adjust Priority (Advanced)

You can modify the tool in `loopy.js` to set priority:
- `-2` = lowest priority
- `-1` = low priority
- `0` = normal (default)
- `1` = high priority (bypass quiet hours)
- `2` = emergency (requires confirmation)

Add to the formData in loopy.js:
```javascript
priority: '1'  // high priority
```

### Notification Sounds

Configure in your Pushover app settings or per-notification.

## Troubleshooting

### "Skipped: PUSHOVER_TOKEN and PUSHOVER_USER must be set"

Environment variables aren't set. Check:
```bash
echo $PUSHOVER_TOKEN
echo $PUSHOVER_USER
```

### "Failed: [errors]"

Common errors:
- `invalid token` - Check PUSHOVER_TOKEN is correct
- `invalid user` - Check PUSHOVER_USER is correct
- `application token is invalid` - Your app may be disabled

### Not Receiving Notifications

1. Check Pushover app is installed on your phone
2. Check phone isn't in Do Not Disturb mode
3. Check Pushover app settings allow notifications
4. Verify the API call succeeded in console logs

## Rate Limits

Pushover free tier:
- 10,000 messages per month
- Should be more than enough for Loopy usage

If Secretary sends too many notifications, consider:
- Making the criteria in `secretary.txt` stricter
- Increasing `ADVISOR_INTERVAL_MS` to reduce advisor availability notices
- Adding a cooldown to the pushover.notify tool

## Security Notes

- **Never commit** `.env` files with tokens
- Add `.env` to `.gitignore`
- Tokens are like passwords - keep them secret
- Rotate tokens if accidentally exposed (create new app in Pushover)

## Example Usage Patterns

### Good Uses (Secretary will send):
```
"Dear Advisor, we've decided on approach X. Can you review the plan?"
"Need help implementing authentication. What library do you recommend?"
"Stuck on deployment - getting error Y. Can you take a look?"
```

### Bad Uses (Secretary will NOT send):
```
"I wonder what Joel thinks?" (too vague)
"Let's brainstorm more ideas" (not actionable)
"This is going well!" (not a request)
```

The Secretary persona is trained to be respectful of your time and only notify when truly needed.
