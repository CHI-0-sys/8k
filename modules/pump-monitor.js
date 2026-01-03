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

        if (isCreate) {
            this.emit('create', eventData);
        }

        if (isBuy) {
            this.emit('buy', eventData);
        }

        if (isSell) {
            this.emit('sell', eventData);
        }
    }
}

module.exports = PumpMonitor;
