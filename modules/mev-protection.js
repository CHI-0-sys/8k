class MEVProtection {
    constructor(logger) {
        this.logger = logger;
        this.recentTxHashes = new Set();
        this.maxRecentTxs = 1000;
    }

    async randomDelay(minMs = 100, maxMs = 500) {
        const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    addAmountJitter(amount, jitterPercent = 0.5) {
        const jitter = Math.random() * (jitterPercent / 100) * amount;
        const shouldAdd = Math.random() > 0.5;
        return Math.floor(amount + (shouldAdd ? jitter : -jitter));
    }

    async protectTransaction(transaction, options = {}) {
        const { addJitter = true, randomizeCompute = true } = options;

        try {
            if (randomizeCompute) {
                const baseUnits = 200000;
                const jitter = Math.floor(Math.random() * 50000);
                transaction.computeUnitLimit = baseUnits + jitter;
            }

            await this.randomDelay(50, 200);

            return {
                transaction,
                protections: { jitter: addJitter, randomCompute: randomizeCompute }
            };
        } catch (error) {
            this.logger.error('MEV protection failed', { error: error.message });
            return { transaction, protections: {} };
        }
    }

    detectSandwichRisk(priceImpact, liquidityUSD, tradeSize) {
        let riskScore = 0;

        if (priceImpact > 5) riskScore += 30;
        else if (priceImpact > 2) riskScore += 15;

        if (liquidityUSD < 10000) riskScore += 25;
        else if (liquidityUSD < 50000) riskScore += 10;

        const tradeLiquidityRatio = tradeSize / liquidityUSD;
        if (tradeLiquidityRatio > 0.05) riskScore += 25;
        else if (tradeLiquidityRatio > 0.02) riskScore += 15;

        const risk = riskScore >= 50 ? 'HIGH' : riskScore >= 30 ? 'MEDIUM' : 'LOW';

        this.logger.debug('Sandwich risk assessment', { riskScore, risk });

        return {
            riskScore,
            risk,
            shouldProceed: risk !== 'HIGH',
            recommendations: risk === 'HIGH' ? ['Split trade', 'Use max priority fee'] : []
        };
    }

    calculateMEVProtectionFee(baseFee, riskLevel, urgency = 'normal') {
        let multiplier = 1;
        if (riskLevel === 'HIGH') multiplier *= 2.5;
        else if (riskLevel === 'MEDIUM') multiplier *= 1.5;

        const urgencyMultipliers = { 'low': 0.8, 'normal': 1.0, 'high': 1.5, 'critical': 2.0 };
        multiplier *= urgencyMultipliers[urgency] || 1.0;

        return Math.floor(baseFee * multiplier);
    }

    getStats() {
        return {
            recentTxCount: this.recentTxHashes.size,
            protectionEnabled: true,
            features: { jitter: true, randomCompute: true }
        };
    }
}

module.exports = MEVProtection;