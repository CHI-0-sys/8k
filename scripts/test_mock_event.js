
// scripts/test_mock_event.js
const { EventEmitter } = require('events');
const TradingBot = require('../bot.js').TradingBot; // adapt if needed
const logger = require('../bot.js').logger;

// Mocks
class MockConnection {
    constructor() {
        this.rpcEndpoint = 'https://api.mainnet-beta.solana.com'; // Fake URL for validation
    }
    onLogs(programId, callback) { console.log('Mock: Subscribed to logs'); }
    removeOnLogsListener(id) { console.log('Mock: Unsubscribed'); }
    async getParsedTransaction(sig) {
        console.log('Mock: getParsedTransaction called for', sig);
        return {
            blockTime: Math.floor(Date.now() / 1000) - 5, // 5 seconds ago
            meta: {
                postTokenBalances: [
                    { mint: 'So11111111111111111111111111111111111111112', uiTokenAmount: { uiAmount: 5 } },
                    { mint: 'MOCK_TOKEN_MINT_123456789', uiTokenAmount: { uiAmount: 1000000000 } }
                ]
            }
        };
    }
    async getAccountInfo(pubkey) { return { data: Buffer.from([]) }; } // Mock metadata exists
    async getBalance() { return 1000000000; } // 1 SOL
}

// Override dependencies in your bot or modules if possible, 
// OR just instantiate the modules directly to test the flow.

const PumpMonitor = require('../modules/pump-monitor');
const TokenFilter = require('../modules/token-filter');

async function runTest() {
    console.log('🧪 STARTING MOCK TEST');

    // 1. Setup Mock Connection
    const mockConn = new MockConnection();

    // 2. Setup Modules
    const monitor = new PumpMonitor(mockConn, logger);
    const filter = new TokenFilter(mockConn, logger);

    // Mock the Social Check in filter to always return TRUE
    filter.checkSocials = async () => {
        console.log('Mock: checkSocials returning TRUE');
        return true;
    };

    // 3. Simulate Event
    console.log('⚡ Emitting Mock Event...');

    // We want to test the full flow if possible, but simplest is to test Filter + Logic.

    // Step A: PumpMonitor Logic (Parse Log)
    const mockLogs = {
        signature: 'mock_signature_111',
        logs: ['Program log: Instruction: MintTo', 'Program log: Create']
    };

    // Spy on emit
    let eventCaught = null;
    monitor.emit = (event, data) => {
        console.log(`📡 PumpMonitor Emitted '${event}':`, data);
        eventCaught = data;
    };

    monitor.processLogs(mockLogs, { slot: 100 });

    if (!eventCaught) {
        console.error('❌ PumpMonitor did NOT emit event from valid logs');
        return;
    }

    // Step B: TokenFilter Logic
    console.log('🔍 Testing TokenFilter...');
    const analysis = await filter.analyzeToken(eventCaught.signature);

    if (analysis) {
        console.log('✅ Filter Passed:', analysis);
        console.log('   Mint:', analysis.mint);
        console.log('   Has Twitter:', analysis.hasTwitter);
    } else {
        console.error('❌ Filter Failed (should have passed)');
    }

    console.log('🧪 TEST COMPLETE');
    process.exit(0);
}

runTest();
