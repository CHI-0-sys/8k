const { Connection, Keypair } = require('@solana/web3.js');
const TokenFilter = require('../modules/token-filter');
require('dotenv').config();

async function testFilters() {
    console.log('🧪 Testing Pump.fun Token Filters (Pure RPC)...');

    const rpcUrl = process.env.PRIMARY_RPC_URL || 'https://api.mainnet-beta.solana.com';
    const connection = new Connection(rpcUrl, 'confirmed');

    const logger = {
        info: (msg, meta) => console.log(`[INFO] ${msg}`, meta || ''),
        warn: (msg, meta) => console.log(`[WARN] ${msg}`, meta || ''),
        error: (msg, meta) => console.error(`[ERROR] ${msg}`, meta || ''),
        debug: (msg, meta) => console.log(`[DEBUG] ${msg}`, meta || '')
    };

    const filter = new TokenFilter(connection, logger);

    // 1. Negative Test: USDC (Not a Pump token)
    // Should fail because Mint Authority is not the Curve.
    const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    console.log(`\n1️⃣  Testing USDC (Should Fail): ${usdcMint}`);

    console.log('--- Checking Authorities ---');
    const authUSDC = await filter.checkTokenAuthorities(usdcMint);
    console.log(`Result: ${!authUSDC ? '✅ PASS (Correctly Rejected)' : '❌ FAIL (False Positive)'}`);

    console.log('--- Checking Holder Distribution ---');
    const holderUSDC = await filter.checkHolderDistribution(usdcMint);
    // USDC likely has huge holders or distribution that triggers warning, or maybe not.
    // We just want to ensure it runs without crashing.
    console.log(`Result: ${holderUSDC ? 'PASS' : 'FAIL (Expected)'}`);


    // 2. Resilience Test: Random Uninitialized Key
    // Should handle "Account Not Found" gracefully (Reject or Safe Default)
    const randomMint = Keypair.generate().publicKey.toBase58();
    console.log(`\n2️⃣  Testing Random/New Mint: ${randomMint}`);

    console.log('--- Checking Authorities ---');
    const authRandom = await filter.checkTokenAuthorities(randomMint);
    // Logic defaults to false if account not found (safe)
    console.log(`Result: ${!authRandom ? '✅ PASS (Correctly Rejected for missing info)' : '❌ FAIL'}`);

    console.log('\n✨ Test Complete');
}

testFilters().catch(console.error);
