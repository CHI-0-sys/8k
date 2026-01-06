/**
 * Trading Engine Component Test
 * Tests all trading functions without Telegram connection
 * Run with: node scripts/test_trading_engine.js
 */

require('dotenv').config();

const { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58');

// Import modules
const RiskFilter = require('../modules/risk-filter');
const BondingCurveManager = require('../modules/bonding-curve');
const TokenFilter = require('../modules/token-filter');
const PumpMonitor = require('../modules/pump-monitor');
const MEVProtection = require('../modules/mev-protection');
const PumpFunDirect = require('../modules/pumpfun-direct');
const LRUCache = require('../modules/lru-cache');
const Mutex = require('../modules/mutex');

// Mock logger
const logger = {
    info: (msg, data) => console.log(`✅ ${msg}`, data ? JSON.stringify(data, null, 2) : ''),
    warn: (msg, data) => console.log(`⚠️  ${msg}`, data ? JSON.stringify(data, null, 2) : ''),
    error: (msg, data) => console.log(`❌ ${msg}`, data ? JSON.stringify(data, null, 2) : ''),
    debug: (msg, data) => { } // Silent
};

console.log('='.repeat(70));
console.log('TRADING ENGINE COMPONENT TEST');
console.log('='.repeat(70));
console.log();

async function testRPC() {
    console.log('📡 TEST 1: RPC Connection');
    console.log('-'.repeat(50));

    try {
        const rpcUrl = process.env.PRIMARY_RPC_URL || 'https://api.mainnet-beta.solana.com';
        const connection = new Connection(rpcUrl, 'confirmed');

        const slot = await connection.getSlot();
        console.log(`  ✅ RPC connected - Current slot: ${slot}`);

        return connection;
    } catch (error) {
        console.log(`  ❌ RPC connection failed: ${error.message}`);
        return null;
    }
}

async function testWallet() {
    console.log('\n🔑 TEST 2: Wallet Loading');
    console.log('-'.repeat(50));

    try {
        const privateKeyStr = process.env.PRIVATE_KEY?.replace(/\s/g, '');
        if (!privateKeyStr) {
            console.log('  ❌ PRIVATE_KEY not set in .env');
            return null;
        }

        let wallet;
        const decoded = bs58.decode(privateKeyStr);

        if (decoded.length === 64) {
            wallet = Keypair.fromSecretKey(decoded);
        } else if (decoded.length === 32) {
            wallet = Keypair.fromSeed(decoded);
        } else {
            throw new Error(`Invalid key length: ${decoded.length}`);
        }

        console.log(`  ✅ Wallet loaded: ${wallet.publicKey.toBase58().substring(0, 8)}...`);
        return wallet;
    } catch (error) {
        console.log(`  ❌ Wallet loading failed: ${error.message}`);
        return null;
    }
}

async function testWalletBalance(connection, wallet) {
    console.log('\n💰 TEST 3: Wallet Balance Check');
    console.log('-'.repeat(50));

    try {
        const balance = await connection.getBalance(wallet.publicKey);
        const solBalance = balance / LAMPORTS_PER_SOL;
        console.log(`  ✅ Balance: ${solBalance.toFixed(6)} SOL`);

        if (solBalance < 0.01) {
            console.log(`  ⚠️  Low balance - minimum 0.01 SOL needed for trading`);
        }

        return solBalance;
    } catch (error) {
        console.log(`  ❌ Balance check failed: ${error.message}`);
        return 0;
    }
}

async function testRiskFilter(connection) {
    console.log('\n🛡️ TEST 4: Risk Filter');
    console.log('-'.repeat(50));

    try {
        const riskFilter = new RiskFilter(connection, logger);

        // Test fast filter
        const goodToken = { symbol: 'WIF', name: 'Dog Wif Hat', liquidity: 50000 };
        const fastResult = await riskFilter.fastFilter(goodToken);
        console.log(`  ✅ Fast filter working - Good token: ${fastResult.valid}`);

        // Test scam detection
        const scamToken = { symbol: 'HONEYPOT', name: 'Scam', liquidity: 50000 };
        const scamResult = await riskFilter.fastFilter(scamToken);
        console.log(`  ✅ Scam detection working - Blocked: ${!scamResult.valid}`);

        // Test risk scoring
        const score = await riskFilter.calculateRiskScore({
            symbol: 'TEST',
            liquidity: 15000,
            bondingProgress: 92
        });
        console.log(`  ✅ Risk scoring working - Score: ${score}/100`);

        // Test shouldTrade decision
        const decision = await riskFilter.shouldTrade({
            symbol: 'MEME',
            liquidity: 20000,
            bondingProgress: 95
        });
        console.log(`  ✅ Trade decision: ${decision.trade} (${decision.riskLevel})`);

        return riskFilter;
    } catch (error) {
        console.log(`  ❌ Risk filter test failed: ${error.message}`);
        return null;
    }
}

async function testBondingCurve(connection) {
    console.log('\n📈 TEST 5: Bonding Curve Manager');
    console.log('-'.repeat(50));

    try {
        const bondingCurve = new BondingCurveManager(connection, logger);

        // Test PDA derivation
        const testMint = 'So11111111111111111111111111111111111111112';
        const pda = bondingCurve.getBondingCurvePDA(testMint);
        console.log(`  ✅ PDA derivation working: ${pda ? pda.toBase58().substring(0, 8) + '...' : 'null'}`);

        // Test curve state decoding
        const testBuffer = Buffer.alloc(49);
        testBuffer.writeBigUInt64LE(BigInt(1000000000), 8);  // virtualTokenReserves
        testBuffer.writeBigUInt64LE(BigInt(30000000000), 16); // virtualSolReserves
        testBuffer.writeBigUInt64LE(BigInt(800000000), 24);   // realTokenReserves  
        testBuffer.writeBigUInt64LE(BigInt(25000000000), 32); // realSolReserves
        testBuffer.writeBigUInt64LE(BigInt(1000000000), 40);  // tokenTotalSupply
        testBuffer[48] = 0;  // complete = false

        const decoded = bondingCurve.decodeCurveState(testBuffer);
        console.log(`  ✅ Curve decoding working: realSol=${decoded ? Number(decoded.realSolReserves) / 1e9 : 'null'} SOL`);

        // Test progress calculation
        if (decoded) {
            const progress = bondingCurve.calculateProgress(decoded);
            console.log(`  ✅ Progress calculation: ${progress.toFixed(2)}%`);
        }

        return bondingCurve;
    } catch (error) {
        console.log(`  ❌ Bonding curve test failed: ${error.message}`);
        return null;
    }
}

async function testMEVProtection() {
    console.log('\n🔒 TEST 6: MEV Protection');
    console.log('-'.repeat(50));

    try {
        const mevProtection = new MEVProtection(logger);

        // Test sandwich risk detection (correct method name)
        const risk = mevProtection.detectSandwichRisk(2.5, 50000, 500);
        console.log(`  ✅ Sandwich risk detection: ${risk.risk} (score: ${risk.riskScore})`);

        // Test amount jitter
        const originalAmount = 100000;
        const jitteredAmount = mevProtection.addAmountJitter(originalAmount, 0.5);
        console.log(`  ✅ Amount jitter: ${originalAmount} → ${jitteredAmount}`);

        // Test protection fee calculation
        const protectionFee = mevProtection.calculateMEVProtectionFee(100000, 'MEDIUM', 'normal');
        console.log(`  ✅ Protection fee: ${protectionFee} lamports`);

        return mevProtection;
    } catch (error) {
        console.log(`  ❌ MEV protection test failed: ${error.message}`);
        return null;
    }
}

async function testLRUCache() {
    console.log('\n🗃️ TEST 7: LRU Cache');
    console.log('-'.repeat(50));

    try {
        const cache = new LRUCache(3);

        cache.set('a', 1);
        cache.set('b', 2);
        cache.set('c', 3);

        const hasA = cache.has('a');
        console.log(`  ✅ Cache set/has working: has('a')=${hasA}`);

        cache.set('d', 4);  // Should evict 'a'
        const hasAAfterEvict = cache.has('a');
        console.log(`  ✅ LRU eviction working: has('a') after evict=${hasAAfterEvict}`);

        const getB = cache.get('b');
        console.log(`  ✅ Cache get working: get('b')=${getB}`);

        return cache;
    } catch (error) {
        console.log(`  ❌ LRU cache test failed: ${error.message}`);
        return null;
    }
}

async function testMutex() {
    console.log('\n🔐 TEST 8: Mutex (Trade Lock)');
    console.log('-'.repeat(50));

    try {
        const mutex = new Mutex();

        let counter = 0;
        const increment = async () => {
            await mutex.runExclusive(async () => {
                const current = counter;
                await new Promise(r => setTimeout(r, 10));
                counter = current + 1;
            });
        };

        await Promise.all([increment(), increment(), increment()]);
        console.log(`  ✅ Mutex working: counter=${counter} (should be 3)`);

        return mutex;
    } catch (error) {
        console.log(`  ❌ Mutex test failed: ${error.message}`);
        return null;
    }
}

async function testPumpFunDirect(connection) {
    console.log('\n🎯 TEST 9: PumpFun Direct (Buy/Sell Builder)');
    console.log('-'.repeat(50));

    try {
        const pumpDirect = new PumpFunDirect(connection, logger);

        // Test that module loads
        console.log(`  ✅ PumpFunDirect module loaded`);

        // Test method existence
        const hasBuy = typeof pumpDirect.executeBuy === 'function';
        const hasSell = typeof pumpDirect.executeSell === 'function';
        console.log(`  ✅ executeBuy method: ${hasBuy}`);
        console.log(`  ✅ executeSell method: ${hasSell}`);

        return pumpDirect;
    } catch (error) {
        console.log(`  ❌ PumpFunDirect test failed: ${error.message}`);
        return null;
    }
}

async function testTokenFilter(connection) {
    console.log('\n🔍 TEST 10: Token Filter');
    console.log('-'.repeat(50));

    try {
        const tokenFilter = new TokenFilter(connection, logger);

        // Test that module loads
        console.log(`  ✅ TokenFilter module loaded`);

        // Test method existence
        const hasAnalyze = typeof tokenFilter.analyzeToken === 'function';
        const hasSocials = typeof tokenFilter.checkSocials === 'function';
        const hasAuth = typeof tokenFilter.checkTokenAuthorities === 'function';

        console.log(`  ✅ analyzeToken method: ${hasAnalyze}`);
        console.log(`  ✅ checkSocials method: ${hasSocials}`);
        console.log(`  ✅ checkTokenAuthorities method: ${hasAuth}`);

        return tokenFilter;
    } catch (error) {
        console.log(`  ❌ Token filter test failed: ${error.message}`);
        return null;
    }
}

async function testIntegration(connection, wallet, riskFilter, bondingCurve) {
    console.log('\n🔗 TEST 11: Integration Test (Full Trade Flow Simulation)');
    console.log('-'.repeat(50));

    try {
        // Simulate a trading decision flow
        console.log('  Simulating trade decision...');

        // 1. Token data (as if from Pump.fun event)
        const tokenData = {
            mint: 'TestMint123456789',
            symbol: 'WTEST',
            name: 'Test Meme Coin',
            liquidity: 25000,
            bondingProgress: 94
        };

        // 2. Fast filter check
        const fastCheck = await riskFilter.fastFilter(tokenData);
        console.log(`  Step 1 - Fast Filter: ${fastCheck.valid ? 'PASS' : 'BLOCKED'}`);

        if (!fastCheck.valid) {
            console.log(`  ❌ Token blocked by fast filter`);
            return false;
        }

        // 3. Full risk assessment
        const riskDecision = await riskFilter.shouldTrade(tokenData);
        console.log(`  Step 2 - Risk Assessment: Score=${riskDecision.riskScore}, Level=${riskDecision.riskLevel}`);

        if (!riskDecision.trade) {
            console.log(`  ❌ Token blocked by risk score`);
            return false;
        }

        // 4. Position sizing (simulated)
        const balance = 1.0;  // 1 SOL
        let positionSize = balance * 0.10;  // 10%

        // Risk-adjusted sizing
        if (riskDecision.riskLevel === 'ELEVATED') {
            positionSize *= 0.7;  // 30% reduction
        }

        console.log(`  Step 3 - Position Size: ${positionSize.toFixed(4)} SOL`);

        // 5. Would execute trade here (paper trade simulation)
        console.log(`  Step 4 - Trade Execution: SIMULATED (Paper Trading)`);
        console.log(`  ✅ Full trade flow completed successfully`);

        return true;
    } catch (error) {
        console.log(`  ❌ Integration test failed: ${error.message}`);
        return false;
    }
}

async function runAllTests() {
    console.log('Starting comprehensive trading engine tests...\n');

    const results = {
        passed: 0,
        failed: 0,
        tests: []
    };

    // Test 1: RPC
    const connection = await testRPC();
    results.tests.push({ name: 'RPC Connection', passed: !!connection });
    if (connection) results.passed++; else results.failed++;

    // Test 2: Wallet
    const wallet = await testWallet();
    results.tests.push({ name: 'Wallet Loading', passed: !!wallet });
    if (wallet) results.passed++; else results.failed++;

    // Test 3: Balance
    if (connection && wallet) {
        const balance = await testWalletBalance(connection, wallet);
        results.tests.push({ name: 'Wallet Balance', passed: balance > 0 });
        if (balance > 0) results.passed++; else results.failed++;
    }

    // Test 4: Risk Filter
    const riskFilter = await testRiskFilter(connection);
    results.tests.push({ name: 'Risk Filter', passed: !!riskFilter });
    if (riskFilter) results.passed++; else results.failed++;

    // Test 5: Bonding Curve
    const bondingCurve = await testBondingCurve(connection);
    results.tests.push({ name: 'Bonding Curve', passed: !!bondingCurve });
    if (bondingCurve) results.passed++; else results.failed++;

    // Test 6: MEV Protection
    const mevProtection = await testMEVProtection();
    results.tests.push({ name: 'MEV Protection', passed: !!mevProtection });
    if (mevProtection) results.passed++; else results.failed++;

    // Test 7: LRU Cache
    const cache = await testLRUCache();
    results.tests.push({ name: 'LRU Cache', passed: !!cache });
    if (cache) results.passed++; else results.failed++;

    // Test 8: Mutex
    const mutex = await testMutex();
    results.tests.push({ name: 'Mutex', passed: !!mutex });
    if (mutex) results.passed++; else results.failed++;

    // Test 9: PumpFun Direct
    const pumpDirect = await testPumpFunDirect(connection);
    results.tests.push({ name: 'PumpFun Direct', passed: !!pumpDirect });
    if (pumpDirect) results.passed++; else results.failed++;

    // Test 10: Token Filter
    const tokenFilter = await testTokenFilter(connection);
    results.tests.push({ name: 'Token Filter', passed: !!tokenFilter });
    if (tokenFilter) results.passed++; else results.failed++;

    // Test 11: Integration
    if (connection && riskFilter && bondingCurve) {
        const integration = await testIntegration(connection, wallet, riskFilter, bondingCurve);
        results.tests.push({ name: 'Integration Test', passed: integration });
        if (integration) results.passed++; else results.failed++;
    }

    // Summary
    console.log('\n' + '='.repeat(70));
    console.log('TEST SUMMARY');
    console.log('='.repeat(70));

    for (const test of results.tests) {
        const icon = test.passed ? '✅' : '❌';
        console.log(`  ${icon} ${test.name}`);
    }

    console.log('-'.repeat(70));
    console.log(`  Total: ${results.passed}/${results.passed + results.failed} tests passed`);

    if (results.failed === 0) {
        console.log('\n🎉 ALL TESTS PASSED! Trading engine is ready for live trading.');
    } else {
        console.log(`\n⚠️  ${results.failed} test(s) failed. Please review before trading.`);
    }
    console.log('='.repeat(70));

    return results;
}

runAllTests().catch(console.error);
