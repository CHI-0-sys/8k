const { Connection, PublicKey } = require('@solana/web3.js');
const BondingCurveManager = require('../modules/bonding-curve');
require('dotenv').config();

async function testBondingCurve() {
    console.log('🧪 Testing BondingCurveManager Logic (Unit Test)...');

    // 1. Mock Data Test
    const mockBuffer = Buffer.alloc(49);
    // Discriminator (8 bytes) - mimicking 66063d1201daebea
    mockBuffer.writeBigUInt64LE(BigInt('7351631484083043818'), 0); // 0x66063d1201daebea as decimal... roughly

    // Virtual Token: 1,000,000,000 (1B)
    mockBuffer.writeBigUInt64LE(BigInt(1_000_000_000_000000), 8);
    // Virtual SOL: 30 SOL
    mockBuffer.writeBigUInt64LE(BigInt(30_000_000_000), 16);
    // Real Token: 793,100,000
    mockBuffer.writeBigUInt64LE(BigInt(793_100_000_000000), 24);
    // Real SOL: 42.5 SOL (50% progress to 85)
    mockBuffer.writeBigUInt64LE(BigInt(42_500_000_000), 32); // 42.5 * 1e9
    // Supply: 1B
    mockBuffer.writeBigUInt64LE(BigInt(1_000_000_000_000000), 40);
    // Complete: false (0)
    mockBuffer.writeUInt8(0, 48);

    const logger = { info: console.log, error: console.error, warn: console.warn };
    const manager = new BondingCurveManager(null, logger);

    console.log('📝 Decoding mock buffer...');
    const decoded = manager.decodeCurveState(mockBuffer);

    if (!decoded) {
        console.error('❌ Failed to decode mock buffer');
        return;
    }

    console.log(`   Real SOL: ${decoded.realSolReserves}`);
    const progress = manager.calculateProgress(decoded);
    console.log(`   Calculated Progress: ${progress.toFixed(2)}% (Expected ~50%)`);

    if (progress > 49 && progress < 51) {
        console.log('✅ Math Logic Verified.');
    } else {
        console.error('❌ Math Logic Failed.');
    }

    // 3. Slippage & Velocity Test
    console.log('\n📉 Testing Dynamic Slippage Logic...');

    // Create a mock mint
    const mockMint = 'Mint111111111111111111111111111111111111111';

    // Simulate History: Price increasing rapidly (High Velocity)
    // T=0: Price 0.000030
    manager.recordState(mockMint, {
        virtualSolReserves: BigInt(30_000_000_000),
        virtualTokenReserves: BigInt(1_000_000_000_000000),
        realSolReserves: BigInt(20_000_000_000) // 20 SOL in curve
    });

    // T=1s: Price 0.000031 (+3.3%)
    // We hack the timestamp by relying on internal Date.now() or just accept real-time delay?
    // Let's just mock internal history manually for unit test if possible, or wait.
    // Waiting 1s is slow. Let's inspect internal state.

    // Mock history injection for testing
    const now = Date.now();
    manager.priceHistory.set(mockMint, [
        { timestamp: now - 5000, price: 0.000030, solReserves: BigInt(30e9), tokenReserves: BigInt(1000e12) },
        { timestamp: now - 4000, price: 0.000031, solReserves: BigInt(31e9), tokenReserves: BigInt(980e12) },
        { timestamp: now - 3000, price: 0.000032, solReserves: BigInt(32e9), tokenReserves: BigInt(960e12) },
        { timestamp: now - 2000, price: 0.000034, solReserves: BigInt(34e9), tokenReserves: BigInt(940e12) },
        { timestamp: now - 1000, price: 0.000036, solReserves: BigInt(36e9), tokenReserves: BigInt(920e12) } // Last price. Velocity ~ high.
    ]);

    // Mock getCurveState to return the latest state
    manager.getCurveState = async () => ({
        realSol: 36.0, // 36 SOL in curve. Cap is ~85. Available = 49.
        realSolReserves: BigInt(36_000_000_000),
        virtualSolReserves: BigInt(36_000_000_000),
        virtualTokenReserves: BigInt(920_000_000_000000)
    });

    // Test 1: Small Buy (0.1 SOL) - Should pass
    const slipSmall = await manager.calculateSlippage(mockMint, 0.1, true);
    console.log(`   Small Buy (0.1 SOL): ${slipSmall.toFixed(2)}% (Expected ~1-2.5%)`);

    // Test 2: Huge Buy (10 SOL) - Should likely fail capacity (>5% of 49 is ~2.45)
    // 10 SOL is > 2.45 SOL, so it should return -1
    const slipHuge = await manager.calculateSlippage(mockMint, 10.0, true);
    console.log(`   Huge Buy (10 SOL): ${slipHuge} (Expected -1 REJECT)`);

    // Test 3: Sell with High Volatility
    // Base ~1% + Impact + Velocity Buffer (~20-25% boost)
    const slipSell = await manager.calculateSlippage(mockMint, 1.0, false);
    console.log(`   Volatile Sell (1 SOL): ${slipSell.toFixed(2)}% (Expected Boosted)`);
}

testBondingCurve().catch(console.error);
