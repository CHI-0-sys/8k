const { PublicKey } = require('@solana/web3.js');
const EventEmitter = require('events');

const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

class PumpMonitor extends EventEmitter {
    constructor(connection, logger) {
        super();
        this.connection = connection;
        this.logger = logger;
        this.isMonitoring = false;
        this.subscriptionId = null;
        this.lastLogTime = Date.now();

        // Event throttling to prevent rate limits
        this.eventQueue = [];
        this.isProcessingQueue = false;
        this.minEventInterval = 1000; // 1 event per second max
        this.lastEventEmit = 0;
    }

    getLastEventTime() {
        return this.lastLogTime;
    }

    async start() {
        if (this.isMonitoring) return;

        this.logger.info('Starting Pump.fun monitor...');

        // Exponential backoff for retries
        let retryDelay = 2000; // Start with 2 seconds
        const maxRetryDelay = 60000; // Max 1 minute between retries
        const maxRetries = 5;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                this.subscriptionId = this.connection.onLogs(
                    new PublicKey(PUMP_FUN_PROGRAM),
                    (logs, ctx) => {
                        if (logs.err) return;
                        this.processLogs(logs, ctx);
                    },
                    'confirmed'
                );

                this.isMonitoring = true;
                this.logger.info(`✅ Monitoring Pump.fun (${PUMP_FUN_PROGRAM})`);
                return; // Success, exit retry loop

            } catch (error) {
                this.logger.error(`Failed to start PumpMonitor (attempt ${attempt + 1}/${maxRetries})`, {
                    error: error.message,
                    nextRetryIn: retryDelay / 1000 + 's'
                });

                if (attempt < maxRetries - 1) {
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                    retryDelay = Math.min(retryDelay * 2, maxRetryDelay); // Exponential backoff
                }
            }
        }

        this.logger.error('PumpMonitor failed after all retries - running without WebSocket');
    }

    async stop() {
        if (!this.isMonitoring || !this.subscriptionId) return;

        try {
            await this.connection.removeOnLogsListener(this.subscriptionId);
            this.isMonitoring = false;
            this.subscriptionId = null;
            this.logger.info('🛑 Pump.fun monitor stopped');
        } catch (error) {
            this.logger.error('Failed to stop PumpMonitor', { error: error.message });
        }
    }

    processLogs(logs, ctx) {
        this.lastLogTime = Date.now();
        const signature = logs.signature;
        const logMessages = logs.logs || [];

        // Check for specific instructions in the logs
        const isCreate = logMessages.some(log => log.includes('Program log: Instruction: Create'));
        const isBuy = logMessages.some(log => log.includes('Program log: Instruction: Buy'));
        const isSell = logMessages.some(log => log.includes('Program log: Instruction: Sell'));

        const eventData = {
            signature,
            slot: ctx.slot,
            timestamp: Date.now()
        };

        // Queue events instead of emitting directly (rate limit protection)
        if (isCreate) {
            this.queueEvent('create', eventData);
        }

        if (isBuy) {
            this.queueEvent('buy', eventData);
        }

        if (isSell) {
            this.queueEvent('sell', eventData);
        }
    }

    // Throttled event queue to prevent rate limits
    queueEvent(type, data) {
        this.eventQueue.push({ type, data });
        if (!this.isProcessingQueue) {
            this.processQueue();
        }
    }

    async processQueue() {
        this.isProcessingQueue = true;

        while (this.eventQueue.length > 0) {
            const event = this.eventQueue.shift();

            // Throttle: ensure minimum interval between events
            const now = Date.now();
            const timeSinceLastEmit = now - this.lastEventEmit;
            if (timeSinceLastEmit < this.minEventInterval) {
                await new Promise(r => setTimeout(r, this.minEventInterval - timeSinceLastEmit));
            }

            this.emit(event.type, event.data);
            this.lastEventEmit = Date.now();
        }

        this.isProcessingQueue = false;
    }
}

module.exports = PumpMonitor;
