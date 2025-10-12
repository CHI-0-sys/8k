const fetch = require('node-fetch');
const AbortController = require('abort-controller');

class DEXAggregator {
    constructor(logger) {
        this.logger = logger;
        this.jupiterAPI = 'https://quote-api.jup.ag/v6';
        this.raydiumAPI = 'https://api.raydium.io/v2';
        this.orcaAPI = 'https://api.orca.so';
        this.timeout = 12000;
    }

    async fetchWithTimeout(url, options = {}, timeout = this.timeout) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        
        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            return response;
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new Error(`Request timeout after ${timeout}ms`);
            }
            throw error;
        }
    }

    // Jupiter quote
    async getJupiterQuote(inputMint, outputMint, amount, slippageBps = 300) {
        try {
            const url = `${this.jupiterAPI}/quote?inputMint=${encodeURIComponent(inputMint)}&outputMint=${encodeURIComponent(outputMint)}&amount=${amount}&slippageBps=${slippageBps}`;
            
            const response = await this.fetchWithTimeout(url, {
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`Jupiter quote failed: ${response.status}`);
            }

            const data = await response.json();
            
            if (!data || !data.inAmount || !data.outAmount) {
                return null;
            }

            return {
                dex: 'Jupiter',
                inAmount: data.inAmount,
                outAmount: data.outAmount,
                priceImpact: data.priceImpactPct || 0,
                route: data,
                estimatedFee: data.otherAmountThreshold ? 
                    (parseInt(data.inAmount) - parseInt(data.otherAmountThreshold)) : 0
            };
        } catch (error) {
            this.logger.warn('Jupiter quote failed', { error: error.message });
            return null;
        }
    }

    // Raydium quote (simplified - you'd need actual Raydium SDK integration)
    async getRaydiumQuote(inputMint, outputMint, amount, slippageBps = 300) {
        try {
            // Note: This is a placeholder. Real implementation would use Raydium SDK
            // For now, we'll return null to indicate it's not available
            this.logger.debug('Raydium quote requested (not fully implemented)');
            return null;
        } catch (error) {
            this.logger.warn('Raydium quote failed', { error: error.message });
            return null;
        }
    }

    // Orca quote (simplified)
    async getOrcaQuote(inputMint, outputMint, amount, slippageBps = 300) {
        try {
            // Note: This is a placeholder. Real implementation would use Orca SDK
            this.logger.debug('Orca quote requested (not fully implemented)');
            return null;
        } catch (error) {
            this.logger.warn('Orca quote failed', { error: error.message });
            return null;
        }
    }

    // Get best quote across all DEXes
    async getBestQuote(inputMint, outputMint, amount, slippageBps = 300) {
        this.logger.debug('Fetching quotes from multiple DEXes', {
            inputMint: inputMint.substring(0, 8),
            outputMint: outputMint.substring(0, 8),
            amount
        });

        const quotes = await Promise.allSettled([
            this.getJupiterQuote(inputMint, outputMint, amount, slippageBps),
            this.getRaydiumQuote(inputMint, outputMint, amount, slippageBps),
            this.getOrcaQuote(inputMint, outputMint, amount, slippageBps)
        ]);

        const validQuotes = quotes
            .filter(result => result.status === 'fulfilled' && result.value !== null)
            .map(result => result.value);

        if (validQuotes.length === 0) {
            this.logger.warn('No valid quotes from any DEX');
            return null;
        }

        // Find best quote (highest output amount)
        const bestQuote = validQuotes.reduce((best, current) => {
            const currentOutput = parseInt(current.outAmount);
            const bestOutput = parseInt(best.outAmount);
            return currentOutput > bestOutput ? current : best;
        });

        this.logger.info('Best quote found', {
            dex: bestQuote.dex,
            inAmount: bestQuote.inAmount,
            outAmount: bestQuote.outAmount,
            priceImpact: bestQuote.priceImpact
        });

        // Add comparison data
        bestQuote.alternativeQuotes = validQuotes
            .filter(q => q.dex !== bestQuote.dex)
            .map(q => ({
                dex: q.dex,
                outAmount: q.outAmount,
                difference: ((parseInt(bestQuote.outAmount) - parseInt(q.outAmount)) / parseInt(q.outAmount) * 100).toFixed(2) + '%'
            }));

        return bestQuote;
    }

    // Compare quotes and get savings
    async compareQuotes(inputMint, outputMint, amount, slippageBps = 300) {
        const quotes = await Promise.allSettled([
            this.getJupiterQuote(inputMint, outputMint, amount, slippageBps),
            this.getRaydiumQuote(inputMint, outputMint, amount, slippageBps),
            this.getOrcaQuote(inputMint, outputMint, amount, slippageBps)
        ]);

        const validQuotes = quotes
            .filter(result => result.status === 'fulfilled' && result.value !== null)
            .map(result => result.value);

        if (validQuotes.length === 0) return null;

        const best = validQuotes.reduce((b, c) => 
            parseInt(c.outAmount) > parseInt(b.outAmount) ? c : b
        );

        const worst = validQuotes.reduce((w, c) => 
            parseInt(c.outAmount) < parseInt(w.outAmount) ? c : w
        );

        const savingsAmount = parseInt(best.outAmount) - parseInt(worst.outAmount);
        const savingsPercent = (savingsAmount / parseInt(worst.outAmount)) * 100;

        return {
            bestDex: best.dex,
            worstDex: worst.dex,
            savingsAmount,
            savingsPercent: savingsPercent.toFixed(2),
            quotes: validQuotes
        };
    }

    // Get route details
    getRouteDetails(quote) {
        if (!quote || !quote.route) return null;

        return {
            dex: quote.dex,
            inputMint: quote.route.inputMint,
            outputMint: quote.route.outputMint,
            inAmount: quote.inAmount,
            outAmount: quote.outAmount,
            priceImpact: quote.priceImpact,
            marketInfos: quote.route.marketInfos || [],
            slippage: quote.route.slippageBps || 0
        };
    }

    // Calculate effective price
    calculateEffectivePrice(inAmount, outAmount, inDecimals = 6, outDecimals = 9) {
        const adjustedIn = parseInt(inAmount) / Math.pow(10, inDecimals);
        const adjustedOut = parseInt(outAmount) / Math.pow(10, outDecimals);
        return adjustedIn / adjustedOut;
    }

    // Estimate slippage impact
    async estimateSlippage(inputMint, outputMint, amount) {
        const slippageLevels = [50, 100, 300, 500, 1000]; // bps
        const quotes = await Promise.all(
            slippageLevels.map(slippage => 
                this.getJupiterQuote(inputMint, outputMint, amount, slippage)
            )
        );

        const validQuotes = quotes.filter(q => q !== null);
        if (validQuotes.length < 2) return null;

        return {
            slippageLevels: validQuotes.map((q, i) => ({
                slippageBps: slippageLevels[i],
                outAmount: q.outAmount,
                priceImpact: q.priceImpact
            })),
            recommendation: this.recommendSlippage(validQuotes, slippageLevels)
        };
    }

    recommendSlippage(quotes, levels) {
        // Find optimal slippage where price impact is acceptable
        for (let i = 0; i < quotes.length; i++) {
            if (quotes[i].priceImpact < 2) { // Less than 2% impact
                return {
                    slippageBps: levels[i],
                    reason: 'Optimal balance between execution certainty and price impact'
                };
            }
        }

        return {
            slippageBps: levels[2], // Default to 300 bps
            reason: 'Default recommendation'
        };
    }

    // Health check for DEXes
    async healthCheck() {
        const testAmount = 1000000; // 1 USDC
        const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        const solMint = 'So11111111111111111111111111111111111111112';

        const results = await Promise.allSettled([
            this.getJupiterQuote(usdcMint, solMint, testAmount),
            this.getRaydiumQuote(usdcMint, solMint, testAmount),
            this.getOrcaQuote(usdcMint, solMint, testAmount)
        ]);

        return {
            jupiter: results[0].status === 'fulfilled' && results[0].value !== null,
            raydium: results[1].status === 'fulfilled' && results[1].value !== null,
            orca: results[2].status === 'fulfilled' && results[2].value !== null,
            timestamp: Date.now()
        };
    }
}

module.exports = DEXAggregator;