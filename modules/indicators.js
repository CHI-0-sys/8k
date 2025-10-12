
class TechnicalIndicators {
    constructor() {
        this.priceHistory = new Map();
        this.volumeHistory = new Map();
    }

    addPriceData(tokenAddress, price, timestamp = Date.now()) {
        if (!this.priceHistory.has(tokenAddress)) {
            this.priceHistory.set(tokenAddress, []);
        }
        const history = this.priceHistory.get(tokenAddress);
        history.push({ price, timestamp });
        if (history.length > 200) history.shift();
    }

    addVolumeData(tokenAddress, volume, timestamp = Date.now()) {
        if (!this.volumeHistory.has(tokenAddress)) {
            this.volumeHistory.set(tokenAddress, []);
        }
        const history = this.volumeHistory.get(tokenAddress);
        history.push({ volume, timestamp });
        if (history.length > 200) history.shift();
    }

    calculateRSI(tokenAddress, period = 14) {
        const history = this.priceHistory.get(tokenAddress);
        if (!history || history.length < period + 1) return null;

        const prices = history.map(h => h.price);
        const changes = [];
        for (let i = 1; i < prices.length; i++) {
            changes.push(prices[i] - prices[i - 1]);
        }

        let gains = 0, losses = 0;
        for (let i = 0; i < period; i++) {
            if (changes[i] > 0) gains += changes[i];
            else losses += Math.abs(changes[i]);
        }

        let avgGain = gains / period;
        let avgLoss = losses / period;

        for (let i = period; i < changes.length; i++) {
            const change = changes[i];
            const gain = change > 0 ? change : 0;
            const loss = change < 0 ? Math.abs(change) : 0;
            avgGain = (avgGain * (period - 1) + gain) / period;
            avgLoss = (avgLoss * (period - 1) + loss) / period;
        }

        if (avgLoss === 0) return 100;
        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }

    calculateEMA(data, period) {
        if (data.length < period) return null;
        const multiplier = 2 / (period + 1);
        let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
        for (let i = period; i < data.length; i++) {
            ema = (data[i] - ema) * multiplier + ema;
        }
        return ema;
    }

    calculateMACD(tokenAddress, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
        const history = this.priceHistory.get(tokenAddress);
        if (!history || history.length < slowPeriod) return null;

        const prices = history.map(h => h.price);
        const emaFast = this.calculateEMA(prices, fastPeriod);
        const emaSlow = this.calculateEMA(prices, slowPeriod);
        
        if (!emaFast || !emaSlow) return null;
        const macdLine = emaFast - emaSlow;
        
        const macdHistory = [];
        for (let i = slowPeriod - 1; i < prices.length; i++) {
            const fast = this.calculateEMA(prices.slice(0, i + 1), fastPeriod);
            const slow = this.calculateEMA(prices.slice(0, i + 1), slowPeriod);
            macdHistory.push(fast - slow);
        }

        const signalLine = this.calculateEMA(macdHistory, signalPeriod);
        const histogram = macdLine - signalLine;

        return {
            macd: macdLine,
            signal: signalLine,
            histogram: histogram,
            trend: histogram > 0 ? 'bullish' : 'bearish'
        };
    }

    analyzeToken(tokenAddress) {
        const rsi = this.calculateRSI(tokenAddress);
        const macd = this.calculateMACD(tokenAddress);

        if (!rsi || !macd) return null;

        let score = 50;
        if (rsi < 30) score += 15;
        else if (rsi > 70) score -= 15;

        if (macd.trend === 'bullish' && macd.histogram > 0) score += 15;
        else if (macd.trend === 'bearish') score -= 10;

        score = Math.max(0, Math.min(100, score));

        return {
            signals: { rsi: { value: rsi }, macd },
            score,
            recommendation: score >= 70 ? 'STRONG_BUY' : score >= 60 ? 'BUY' : score >= 40 ? 'HOLD' : 'SELL',
            confidence: Math.abs(score - 50) / 50
        };
    }

    clearTokenData(tokenAddress) {
        this.priceHistory.delete(tokenAddress);
        this.volumeHistory.delete(tokenAddress);
    }
}

module.exports = TechnicalIndicators;
