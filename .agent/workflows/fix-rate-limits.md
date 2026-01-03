---
description: Fix 429 rate limit errors from RPC, Pump.fun, Telegram, or BitQuery APIs
---

# Fix Rate Limits Workflow

## Step 1: Identify the Source

Check the error logs to determine which API is rate limiting:

| Error Message | Source |
|---------------|--------|
| `ws error: Unexpected server response: 429` | Helius RPC WebSocket |
| `Server responded with 429 Too Many Requests` | Solana Web3.js RPC |
| `ETELEGRAM: 429 Too Many Requests` | Telegram API |
| `429` from BitQuery | BitQuery GraphQL API |

## Step 2: Quick Fixes

### Kill Duplicate Bot Instances
// turbo
```bash
pkill -f "node bot.js" 2>/dev/null; echo "Killed any running bot instances"
```

### Check for Multiple Processes
// turbo
```bash
ps aux | grep "node bot" | grep -v grep
```

## Step 3: RPC Rate Limit Fixes

### 3a. Verify RobustConnection has rate limit protection
Check `bot.js` for these settings in RobustConnection:
```javascript
disableRetryOnRateLimit: true  // On fallback connections
wsEndpoint: undefined          // Disable WS on fallbacks
```

### 3b. Add RPC call throttling (if not present)
Add to bot.js after RobustConnection class:
```javascript
// Rate limiter: Max 2 RPC calls per second
const rpcCallTimes = [];
async function throttledRPC(fn) {
    const now = Date.now();
    rpcCallTimes.push(now);
    // Keep only last second of calls
    while (rpcCallTimes.length > 0 && rpcCallTimes[0] < now - 1000) {
        rpcCallTimes.shift();
    }
    if (rpcCallTimes.length > 2) {
        await new Promise(r => setTimeout(r, 500));
    }
    return fn();
}
```

## Step 4: PumpMonitor Rate Limit Fixes

### 4a. Check modules/pump-monitor.js has exponential backoff
The start() method should have:
```javascript
let retryDelay = 2000; // Start with 2 seconds
const maxRetryDelay = 60000; // Max 1 minute
// Exponential backoff: retryDelay = Math.min(retryDelay * 2, maxRetryDelay)
```

### 4b. Add event queue throttling (if processing too fast)
Add to PumpMonitor class:
```javascript
constructor(connection, logger) {
    // ... existing code ...
    this.eventQueue = [];
    this.isProcessing = false;
    this.minEventInterval = 1000; // 1 event per second max
}

async queueEvent(eventData) {
    this.eventQueue.push(eventData);
    if (!this.isProcessing) {
        this.processQueue();
    }
}

async processQueue() {
    this.isProcessing = true;
    while (this.eventQueue.length > 0) {
        const event = this.eventQueue.shift();
        this.emit(event.type, event.data);
        await new Promise(r => setTimeout(r, this.minEventInterval));
    }
    this.isProcessing = false;
}
```

## Step 5: Telegram Rate Limit Fixes

If seeing Telegram 429 errors:
1. Reduce message frequency
2. Add delay between messages:
```javascript
async sendMessage(chatId, text, options = {}) {
    await new Promise(r => setTimeout(r, 100)); // 100ms delay
    return this.bot.sendMessage(chatId, text, options);
}
```

## Step 6: Reduce Unnecessary API Calls

### 6a. Check caching is enabled
Verify LRUCache is being used:
```javascript
this.decisionCache = new LRUCache(1000);
```

### 6b. Batch RPC calls where possible
Use `getMultipleAccountsInfo` instead of multiple `getAccountInfo` calls.

## Step 7: Fallback to RPC-Only Mode

If WebSocket keeps failing, disable it temporarily:
```javascript
// In pump-monitor.js start()
if (process.env.DISABLE_WEBSOCKET === 'true') {
    this.logger.warn('WebSocket disabled - using polling fallback');
    return;
}
```

## Step 8: Verify Fixes

// turbo
```bash
cd /Users/macbookair/Desktop/8k && node -e "
const fs = require('fs');
const bot = fs.readFileSync('bot.js', 'utf8');
const pump = fs.readFileSync('modules/pump-monitor.js', 'utf8');

console.log('=== Rate Limit Protection Check ===');
console.log('RobustConnection disableRetryOnRateLimit:', bot.includes('disableRetryOnRateLimit') ? '✅' : '❌');
console.log('PumpMonitor exponential backoff:', pump.includes('retryDelay') ? '✅' : '❌');
console.log('LRU Cache:', bot.includes('LRUCache') ? '✅' : '❌');
"
```

## Prevention Checklist

- [ ] Only ONE bot instance running (local OR Railway, not both)
- [ ] WebSocket only on primary RPC connection
- [ ] Exponential backoff on all retry logic
- [ ] Event processing throttled to 1/sec max
- [ ] LRU cache enabled (1000 items max)
- [ ] Helius API key is valid and not rate-limited externally

## Emergency: Complete Rate Limit Reset

If all else fails, wait 60 seconds for rate limits to reset:
```bash
echo "Waiting 60 seconds for rate limit reset..." && sleep 60 && echo "Done!"
```
