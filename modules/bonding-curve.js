const { PublicKey } = require('@solana/web3.js');

// Pump.fun Bonding Curve Layout (Manual Decoding)
// Offset | Type | Name
// 0      | u64  | virtualTokenReserves
// 8      | u64  | virtualSolReserves
// 16     | u64  | realTokenReserves
// 24     | u64  | realSolReserves
// 32     | u64  | tokenTotalSupply
// 40     | bool | complete

const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const BONDING_CURVE_SIZE = 49; // Approximate size, we only need the first 41 bytes usually

class BondingCurveManager {
    constructor(connection, logger) {
        this.connection = connection;
        this.logger = logger;
        this.priceHistory = new Map(); // Map<Mint, Array<{timestamp, price}>>
    }

    // ... (existing getBondingCurvePDA, readBigUInt64LE, decodeCurveState methods stay) ...

    recordState(mint, state) {
        if (!state) return;

        const price = Number(state.virtualSolReserves) / Number(state.virtualTokenReserves);
        const timestamp = Date.now();

        if (!this.priceHistory.has(mint)) {
            this.priceHistory.set(mint, []);
        }

        const history = this.priceHistory.get(mint);
        history.push({ timestamp, price, solReserves: state.virtualSolReserves, tokenReserves: state.virtualTokenReserves });

        // Keep last 20 entries (enough for "last 10 transactions" logic approx)
        if (history.length > 20) {
            history.shift();
        }
    }

    getVolatility(mint) {
        const history = this.priceHistory.get(mint);
        if (!history || history.length < 2) return 0;

        // Calculate simple volatility: Standard Deviation of price changes? 
        // Or simpler: (Max Price - Min Price) / Average Price over the last window?
        // User asked for "velocity" (speed of change). 
        // Let's use % change per second averaged over history.

        let totalChange = 0;
        let intervals = 0;

        for (let i = 1; i < history.length; i++) {
            const prev = history[i - 1];
            const curr = history[i];
            const timeDiff = (curr.timestamp - prev.timestamp) / 1000;
            if (timeDiff === 0) continue;

            const priceChange = Math.abs(curr.price - prev.price) / prev.price;
            // velocity = % change per second
            totalChange += (priceChange / timeDiff);
            intervals++;
        }

        return intervals > 0 ? totalChange / intervals : 0;
    }

    async calculateSlippage(mint, amountSol, isBuy = true) {
        const stateData = await this.getCurveState(mint);
        if (!stateData) return 0.25; // Default safe max (25%) if no state

        // 1. Capacity Check
        const curveCapacity = Number(stateData.realSolReserves) / 1e9; // Current Real SOL in curve
        const tradeSize = amountSol; // in SOL

        // Pump.fun curves complete at ~85 SOL.
        // Remaining capacity for buys = 85 - Current Real SOL
        // Liquidity for sells = Current Real SOL

        const availableLiquidity = isBuy ? (85.0 - (stateData.realSol)) : stateData.realSol;

        // "Reject trade if required size > 5% of remaining curve"
        // Note: For buys near graduation, capacity < 5% is common. 
        // But user wants to prevent "Liquidity Exhaustion".
        // Let's Warn and High Slippage, or returns -1 to reject.

        if (availableLiquidity <= 0.001) return -1; // Curve full or empty

        const impact = (tradeSize / availableLiquidity) * 100; // % of available liquidity

        if (impact > 5.0) {
            this.logger.warn(`Trade size ${tradeSize.toFixed(2)} SOL is > 5% of liquidity (${availableLiquidity.toFixed(2)} SOL)`);
            return -1; // REJECT
        }

        // 2. Base Calculation
        let baseSlippage = 1.0; // 1%

        // 3. Velocity Factor
        // "Sample bonding curve price velocity"
        const velocity = this.getVolatility(mint); // % change per second
        // If price is moving 1% per second, that's fast. Add velocity * 5 as buffer?
        const velocityBuffer = velocity * 5.0;

        let finalSlippage = baseSlippage + impact + velocityBuffer;

        // "For sells: Add 20% buffer to calculated slippage during high volatility"
        if (!isBuy && velocity > 0.05) { // High volatility definition > 5% per sec?
            finalSlippage *= 1.20;
        }

        // Cap at 25% (User requirement)
        if (finalSlippage > 25.0) {
            this.logger.warn(`Calculated slippage ${finalSlippage.toFixed(2)}% exceeds limit (25%)`);
            return -1; // REJECT
        }

        return finalSlippage; // Returns percentage (e.g. 5.5 for 5.5%)
    }

    getBondingCurvePDA(mint) {
        try {
            const mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;
            const [pda] = PublicKey.findProgramAddressSync(
                [Buffer.from('bonding-curve'), mintPubkey.toBuffer()],
                PUMP_FUN_PROGRAM
            );
            return pda;
        } catch (error) {
            return null;
        }
    }

    async getMaxSafeTradeSize(mint, isBuy = true) {
        const stateData = await this.getCurveState(mint);
        if (!stateData) return 0; // Unsafe to trade

        const realSol = Number(stateData.realSolReserves) / 1e9;

        if (isBuy) {
            // Capacity = 85 - realSol
            // Max buy = 5% of capacity
            const capacity = 85.0 - realSol;
            if (capacity <= 0) return 0;
            return capacity * 0.05;
        } else {
            // Liquidity = realSol
            // Max sell = 10% of liquidity
            return realSol * 0.10;
        }
    }

    readBigUInt64LE(buffer, offset = 0) {
        return buffer.readBigUInt64LE(offset);
    }

    decodeCurveState(buffer) {
        if (buffer.length < 41) return null;

        // Skip 8 byte discriminator if present? 
        // Pump.fun accounts usually have an 8-byte discriminator at struct start.
        // Let's assume standard Anchor account layout: 8 bytes discriminator + data.
        // If we fetch just the data without the discriminator, offsets shift.
        // Ideally we fetch the whole account data.

        const discriminatorSize = 8;

        try {
            const virtualTokenReserves = this.readBigUInt64LE(buffer, discriminatorSize + 0);
            const virtualSolReserves = this.readBigUInt64LE(buffer, discriminatorSize + 8);
            const realTokenReserves = this.readBigUInt64LE(buffer, discriminatorSize + 16);
            const realSolReserves = this.readBigUInt64LE(buffer, discriminatorSize + 24);
            const tokenTotalSupply = this.readBigUInt64LE(buffer, discriminatorSize + 32);
            const complete = buffer[discriminatorSize + 40] === 1;

            return {
                virtualTokenReserves,
                virtualSolReserves,
                realTokenReserves,
                realSolReserves,
                tokenTotalSupply,
                complete
            };
        } catch (error) {
            this.logger.error('Failed to decode bonding curve', { error: error.message });
            return null;
        }
    }

    calculateProgress(state) {
        if (!state) return 0;
        if (state.complete) return 100;

        // Pump.fun target is approximately 85 SOL in real reserves or specific market cap.
        // A common approximation is checking Real SOL Reserves vs Target.
        // Target SOL ~ 85.
        // Or calculating based on token reserves:
        // Initial Real Token Reserves usually ~793,100,000 (approx 79% of supply).
        // It goes down as people buy.

        // Let's use Real SOL Reserves as the graduation metric.
        // It starts at 0 and goes to ~85.

        const realSol = Number(state.realSolReserves) / 1e9;
        const targetSol = 85.0; // Approximation

        let progress = (realSol / targetSol) * 100;
        return Math.min(progress, 100);
    }

    async getCurveState(mint) {
        try {
            const pda = this.getBondingCurvePDA(mint);
            if (!pda) return null;

            const info = await this.connection.getAccountInfo(pda);
            if (!info || !info.data) return null;

            const state = this.decodeCurveState(info.data);
            if (!state) return null;

            // Record state for history/velocity tracking
            this.recordState(mint, state);

            const progress = this.calculateProgress(state);

            return {
                mint,
                address: pda.toBase58(),
                ...state,
                progress,
                realSol: Number(state.realSolReserves) / 1e9,
                marketCapSOL: Number(state.virtualSolReserves) / 1e9
            };
        } catch (error) {
            this.logger.error(`Error fetching curve state for ${mint}`, { error: error.message });
            return null;
        }
    }

    // Quick check optimized for the loop
    async checkGraduation(mint, threshold = 93) {
        const state = await this.getCurveState(mint);
        if (!state) return null;

        if (state.complete) {
            return { isGraduating: true, isComplete: true, data: state };
        }

        if (state.progress >= threshold) {
            return { isGraduating: true, isComplete: false, data: state };
        }

        return { isGraduating: false, isComplete: false, data: state };
    }
}

module.exports = BondingCurveManager;
