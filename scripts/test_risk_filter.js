/**
 * Test Script for Risk Filter Module
 * Run with: node scripts/test_risk_filter.js
 */

const RiskFilter = require('../modules/risk-filter');

// Mock logger
const mockLogger = {
    info: (msg, data) => console.log(`ℹ️  ${msg}`, data ? JSON.stringify(data, null, 2) : ''),
    warn: (msg, data) => console.log(`⚠️  ${msg}`, data ? JSON.stringify(data, null, 2) : ''),
    error: (msg, data) => console.log(`❌ ${msg}`, data ? JSON.stringify(data, null, 2) : ''),
    debug: (msg, data) => { } // Silent debug
};

// Mock connection (not needed for unit tests)
const mockConnection = null;

// Create filter instance
const riskFilter = new RiskFilter(mockConnection, mockLogger);

console.log('='.repeat(60));
console.log('RISK FILTER UNIT TESTS');
console.log('='.repeat(60));
console.log();

// ============ TEST 1: Hard Scam Detection ============
console.log('📋 TEST 1: Hard Scam Detection');
console.log('-'.repeat(40));

const hardScamTests = [
    { input: 'honeypot token', expected: true, desc: 'Contains honeypot' },
    { input: 'RUGPULL COIN', expected: true, desc: 'Contains rugpull (uppercase)' },
    { input: 'drainer bot', expected: true, desc: 'Contains drainer' },
    { input: 'testnet token', expected: true, desc: 'Contains testnet' },
    { input: 'devnet coin', expected: true, desc: 'Contains devnet' },
    { input: 'exploit master', expected: true, desc: 'Contains exploit' },
    { input: 'PEPE MOON', expected: false, desc: 'Moon is NOT a hard scam' },
    { input: 'SafeMoon', expected: false, desc: 'Safe is NOT a hard scam' },
    { input: 'WIF', expected: false, desc: 'Normal meme coin' },
    { input: 'BONK', expected: false, desc: 'Normal meme coin' },
    { input: 'test coin', expected: false, desc: 'Test is NOT blocked (common word)' },
    { input: 'pump fun', expected: false, desc: 'Pump is NOT blocked' },
    { input: 'dev meme', expected: false, desc: 'Dev is NOT blocked' },
];

let passed = 0;
let failed = 0;

for (const test of hardScamTests) {
    const result = riskFilter.isHardScam(test.input);
    const status = result === test.expected ? '✅ PASS' : '❌ FAIL';
    if (result === test.expected) passed++; else failed++;
    console.log(`  ${status}: "${test.input}" → ${result} (${test.desc})`);
}

console.log(`\n  Results: ${passed}/${passed + failed} tests passed\n`);

// ============ TEST 2: Fast Filter ============
console.log('📋 TEST 2: Fast Filter');
console.log('-'.repeat(40));

const fastFilterTests = [
    // Should BLOCK
    { token: { symbol: 'A'.repeat(20), liquidity: 10000 }, shouldPass: false, desc: 'Symbol too long (20 chars)' },
    { token: { symbol: '', liquidity: 10000 }, shouldPass: false, desc: 'Empty symbol' },
    { token: { symbol: 'WIF', name: 'honeypot', liquidity: 10000 }, shouldPass: false, desc: 'Name contains honeypot' },
    { token: { symbol: 'RUGPULLCOIN', liquidity: 10000 }, shouldPass: false, desc: 'Symbol contains rugpull' },
    { token: { symbol: 'PEPE', liquidity: 1000 }, shouldPass: false, desc: 'Liquidity below $5k' },
    { token: { symbol: 'DOGE', liquidity: 4999 }, shouldPass: false, desc: 'Liquidity at $4999 (below min)' },

    // Should PASS
    { token: { symbol: 'WIF', name: 'Dog Wif Hat', liquidity: 5000 }, shouldPass: true, desc: 'Valid: $5k liquidity' },
    { token: { symbol: 'PEPE', name: 'Pepe The Frog', liquidity: 50000 }, shouldPass: true, desc: 'Valid: High liquidity' },
    { token: { symbol: 'A', liquidity: 10000 }, shouldPass: true, desc: 'Valid: 1 char symbol' },
    { token: { symbol: 'A'.repeat(12), liquidity: 10000 }, shouldPass: true, desc: 'Valid: 12 char symbol (max)' },
    { token: { symbol: 'SAFEMOON', liquidity: 10000 }, shouldPass: true, desc: 'Valid: "safe" is NOT blocked' },
    { token: { symbol: '100XGEM', liquidity: 10000 }, shouldPass: true, desc: 'Valid: "100x" is NOT blocked' },
];

passed = 0;
failed = 0;

async function runFastFilterTests() {
    for (const test of fastFilterTests) {
        const result = await riskFilter.fastFilter(test.token);
        const status = result.valid === test.shouldPass ? '✅ PASS' : '❌ FAIL';
        if (result.valid === test.shouldPass) passed++; else failed++;
        console.log(`  ${status}: ${test.desc}`);
        if (result.valid !== test.shouldPass) {
            console.log(`         Expected: ${test.shouldPass}, Got: ${result.valid}, Reason: ${result.reason}`);
        }
    }
    console.log(`\n  Results: ${passed}/${passed + failed} tests passed\n`);
}

// ============ TEST 3: Risk Scoring ============
console.log('📋 TEST 3: Risk Scoring');
console.log('-'.repeat(40));

const scoringTests = [
    // Low risk tokens
    { token: { symbol: 'WIF', liquidity: 50000, bondingProgress: 95 }, maxScore: 30, desc: 'Good liquidity, optimal bonding' },
    { token: { symbol: 'PEPE', liquidity: 25000, bondingProgress: 93 }, maxScore: 30, desc: 'Decent liquidity, good bonding' },

    // Medium risk tokens  
    { token: { symbol: 'DOGE', liquidity: 15000, bondingProgress: 92 }, minScore: 10, maxScore: 50, desc: 'Moderate liquidity, early bonding' },
    { token: { symbol: 'CAT', liquidity: 8000, bondingProgress: 95 }, minScore: 10, maxScore: 50, desc: 'Low liquidity, good bonding' },

    // High risk tokens (but still tradeable, score <= 75)
    { token: { symbol: 'MOON', name: 'SafeMoon 100x', liquidity: 7000, bondingProgress: 88 }, minScore: 30, maxScore: 75, desc: 'Low liq, early bonding, soft warnings' },
    { token: { symbol: 'GEM', liquidity: 6000, bondingProgress: 85 }, minScore: 30, maxScore: 75, desc: 'Very low liq, very early bonding' },

    // Would be blocked (score > 75)
    { token: { symbol: 'SCAM', liquidity: 5500, bondingProgress: 80, name: 'Moon Safe 100x Gem' }, minScore: 75, desc: 'Borderline - max soft warnings + low metrics' },
];

async function runScoringTests() {
    passed = 0;
    failed = 0;

    for (const test of scoringTests) {
        const score = await riskFilter.calculateRiskScore(test.token);
        const minOk = !test.minScore || score >= test.minScore;
        const maxOk = !test.maxScore || score <= test.maxScore;
        const status = minOk && maxOk ? '✅ PASS' : '❌ FAIL';
        if (minOk && maxOk) passed++; else failed++;

        const range = test.minScore && test.maxScore
            ? `${test.minScore}-${test.maxScore}`
            : test.maxScore
                ? `0-${test.maxScore}`
                : `${test.minScore}+`;

        console.log(`  ${status}: Score ${score}/100 (expected ${range}) - ${test.desc}`);
    }
    console.log(`\n  Results: ${passed}/${passed + failed} tests passed\n`);
}

// ============ TEST 4: shouldTrade Decision ============
console.log('📋 TEST 4: Trade Decision (shouldTrade)');
console.log('-'.repeat(40));

const tradeDecisionTests = [
    // Should TRADE
    { token: { symbol: 'WIF', liquidity: 50000, bondingProgress: 95 }, shouldTrade: true, desc: 'Premium token - LOW risk' },
    { token: { symbol: 'PEPE', liquidity: 20000, bondingProgress: 94 }, shouldTrade: true, desc: 'Good token - NORMAL risk' },
    { token: { symbol: 'MEME', liquidity: 8000, bondingProgress: 91 }, shouldTrade: true, desc: 'Risky token - ELEVATED risk (still trades)' },

    // Should BLOCK
    { token: { symbol: 'HONEYPOT', liquidity: 50000, bondingProgress: 95 }, shouldTrade: false, desc: 'Hard scam keyword' },
    { token: { symbol: 'WIF', liquidity: 4000, bondingProgress: 95 }, shouldTrade: false, desc: 'Liquidity below minimum' },
    { token: { symbol: 'A'.repeat(15), liquidity: 50000, bondingProgress: 95 }, shouldTrade: false, desc: 'Symbol too long' },
];

async function runTradeDecisionTests() {
    passed = 0;
    failed = 0;

    for (const test of tradeDecisionTests) {
        const result = await riskFilter.shouldTrade(test.token);
        const status = result.trade === test.shouldTrade ? '✅ PASS' : '❌ FAIL';
        if (result.trade === test.shouldTrade) passed++; else failed++;
        console.log(`  ${status}: ${test.desc}`);
        console.log(`         Trade: ${result.trade}, Level: ${result.riskLevel}, Score: ${result.riskScore}`);
        if (result.warnings.length > 0) {
            console.log(`         Warnings: ${result.warnings.join(', ')}`);
        }
    }
    console.log(`\n  Results: ${passed}/${passed + failed} tests passed\n`);
}

// ============ TEST 5: API Error Handling ============
console.log('📋 TEST 5: Error Handling (Default to ALLOW)');
console.log('-'.repeat(40));

async function runErrorHandlingTests() {
    passed = 0;
    failed = 0;

    // Test that API errors don't block trades
    const token = { symbol: 'WIF', liquidity: 10000, bondingProgress: 95 };

    // This will fail to reach RugCheck API but should still return score=0
    const score = await riskFilter.getRugCheckScore('invalid_mint_address_12345');
    const test1 = score === 0 ? '✅ PASS' : '❌ FAIL';
    if (score === 0) passed++; else failed++;
    console.log(`  ${test1}: RugCheck API failure returns 0 (allows trade)`);

    // Test shouldTrade with API issues - should still allow
    const result = await riskFilter.shouldTrade(token);
    const test2 = result.trade === true ? '✅ PASS' : '❌ FAIL';
    if (result.trade === true) passed++; else failed++;
    console.log(`  ${test2}: shouldTrade allows trading even if RugCheck fails`);

    console.log(`\n  Results: ${passed}/${passed + failed} tests passed\n`);
}

// ============ Run All Tests ============
async function runAllTests() {
    await runFastFilterTests();
    await runScoringTests();
    await runTradeDecisionTests();
    await runErrorHandlingTests();

    console.log('='.repeat(60));
    console.log('✅ ALL TESTS COMPLETE');
    console.log('='.repeat(60));
    console.log('\nKey Points Verified:');
    console.log('  • Hard scam keywords BLOCK immediately');
    console.log('  • Common words (test, pump, dev, moon, safe) do NOT block');
    console.log('  • Liquidity < $5k is BLOCKED');
    console.log('  • Risk score threshold is 75 (aggressive)');
    console.log('  • API errors default to ALLOW (never miss trades)');
    console.log('  • Soft warnings are logged but don\'t block\n');
}

runAllTests().catch(console.error);
