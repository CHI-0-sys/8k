/**
 * Balanced Risk Assessment Filter for Pump.fun Trading
 * 
 * Philosophy: Aggressive trading while blocking obvious scams.
 * Over-filtering kills profitability; under-filtering causes losses.
 * 
 * Decision Flow:
 * Token → Fast Filter → [BLOCK if scam/low liquidity]
 *                    ↓
 *             Calculate Risk Score
 *                    ↓
 *          Score > 75? → BLOCK
 *                    ↓
 *                TRADE
 *         (attach risk level: LOW/NORMAL/ELEVATED)
 */

const axios = require('axios');
const { PublicKey } = require('@solana/web3.js');
const LRUCache = require('./lru-cache');

// ============ CONSTANTS ============

// Hard Block List - These are ALWAYS scams
const HARD_BLOCK_KEYWORDS = [
    'honeypot', 'rugpull', 'scam', 'drainer', 'exploit', 'hack', 'testnet', 'devnet'
];

// Soft Warning Keywords - Log but don't block
const SOFT_WARNING_KEYWORDS = ['moon', 'safe', '100x', 'elon', 'rich', 'diamond'];

// Symbol constraints
const MIN_SYMBOL_LENGTH = 1;
const MAX_SYMBOL_LENGTH = 12;

// Liquidity thresholds (USD)
const MIN_LIQUIDITY_USD = 5000;  // Hard block below this
const LOW_LIQUIDITY_USD = 10000;
const MODERATE_LIQUIDITY_USD = 20000;

// Bonding curve thresholds
const BONDING_LOW_THRESHOLD = 90;
const BONDING_MID_THRESHOLD = 93;
const BONDING_HIGH_THRESHOLD = 98;

// Risk score thresholds
const RISK_SCORE_BLOCK_THRESHOLD = 75;  // Score > 75 = BLOCK (Be aggressive, meme coins look risky)

// API Configuration
const RUGCHECK_API_URL = 'https://api.rugcheck.xyz/v1';
const RUGCHECK_CACHE_TTL = 5 * 60 * 1000;  // 5 minutes
const METADATA_TIMEOUT = 1500;  // 1.5 seconds max

// Pump.fun Program ID
const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

class RiskFilter {
    constructor(connection, logger) {
        this.connection = connection;
        this.logger = logger;

        // API Result Caches
        this.rugCheckCache = new LRUCache(500);
        this.metadataCache = new LRUCache(500);

        // Axios instance with short timeout
        this.httpClient = axios.create({
            timeout: METADATA_TIMEOUT,
            headers: { 'Accept': 'application/json' }
        });
    }

    // ============ MAIN API INTERFACE ============

    /**
     * Fast Filter - For high-speed sniping
     * Returns: { valid: bool, reason: string }
     */
    async fastFilter(token) {
        const startTime = Date.now();

        try {
            const { symbol, name, liquidity } = token;

            // 1. Symbol Length Check
            if (!this.isValidSymbolLength(symbol)) {
                return {
                    valid: false,
                    reason: `Invalid symbol length: ${symbol?.length || 0} (must be 1-12)`
                };
            }

            // 2. Hard Scam Check (name + symbol)
            const combinedText = `${name || ''} ${symbol || ''}`.toLowerCase();
            if (this.isHardScam(combinedText)) {
                return {
                    valid: false,
                    reason: `Hard scam keyword detected in: ${combinedText}`
                };
            }

            // 3. Minimum Liquidity Check
            const liquidityUSD = liquidity || 0;
            if (liquidityUSD < MIN_LIQUIDITY_USD) {
                return {
                    valid: false,
                    reason: `Liquidity too low: $${liquidityUSD.toFixed(0)} (min: $${MIN_LIQUIDITY_USD})`
                };
            }

            // All fast checks passed
            const elapsed = Date.now() - startTime;
            this.logger.debug(`Fast filter passed in ${elapsed}ms`, { symbol, liquidity: liquidityUSD });

            return { valid: true, reason: 'Passed fast filter' };

        } catch (error) {
            // On error, ALLOW - never miss trades due to filter errors
            this.logger.warn('Fast filter error - allowing trade', { error: error.message });
            return { valid: true, reason: 'Filter error - defaulting to allow' };
        }
    }

    /**
     * Full Trade Decision - Should we trade this token?
     * Returns: { trade: bool, riskScore: 0-100, riskLevel: 'LOW'|'NORMAL'|'ELEVATED', reason: string, warnings: string[] }
     */
    async shouldTrade(token) {
        const startTime = Date.now();
        const warnings = [];

        try {
            // 1. Fast Filter First
            const fastResult = await this.fastFilter(token);
            if (!fastResult.valid) {
                return {
                    trade: false,
                    riskScore: 100,
                    riskLevel: 'BLOCKED',
                    reason: fastResult.reason,
                    warnings: []
                };
            }

            // 2. Collect Soft Warnings (log, don't block)
            this.collectSoftWarnings(token, warnings);

            // 3. Calculate Full Risk Score
            const riskScore = await this.calculateRiskScore(token);

            // 4. Decision based on score
            if (riskScore > RISK_SCORE_BLOCK_THRESHOLD) {
                return {
                    trade: false,
                    riskScore,
                    riskLevel: 'HIGH',
                    reason: `Risk score too high: ${riskScore}/100 (max: ${RISK_SCORE_BLOCK_THRESHOLD})`,
                    warnings
                };
            }

            // 5. Determine Risk Level
            const riskLevel = this.getRiskLevel(riskScore);

            const elapsed = Date.now() - startTime;
            this.logger.info(`Trade approved in ${elapsed}ms`, {
                symbol: token.symbol,
                riskScore,
                riskLevel,
                warnings: warnings.length
            });

            return {
                trade: true,
                riskScore,
                riskLevel,
                reason: `Score ${riskScore}/100 - ${riskLevel} risk`,
                warnings
            };

        } catch (error) {
            // On error, ALLOW with ELEVATED risk - never miss trades
            this.logger.warn('Risk assessment error - allowing with elevated risk', {
                error: error.message,
                token: token.symbol
            });

            return {
                trade: true,
                riskScore: 50,
                riskLevel: 'ELEVATED',
                reason: 'Assessment error - defaulting to allow',
                warnings: ['Risk assessment failed - trading with caution']
            };
        }
    }

    /**
     * Calculate Risk Score (0-100)
     * Lower is better, higher is riskier
     */
    async calculateRiskScore(token) {
        let score = 0;

        const { liquidity, bondingProgress, mint } = token;

        // 1. Liquidity Scoring (max 25 pts)
        if (liquidity < MIN_LIQUIDITY_USD) {
            score += 25;  // Should have been blocked by fast filter
        } else if (liquidity < LOW_LIQUIDITY_USD) {
            score += 15;
        } else if (liquidity < MODERATE_LIQUIDITY_USD) {
            score += 5;
        }
        // >= $20k liquidity = 0 pts (good)

        // 2. Bonding Curve Scoring (max 20 pts)
        if (typeof bondingProgress === 'number') {
            if (bondingProgress < BONDING_LOW_THRESHOLD) {
                // Too early, risky
                score += 20;
            } else if (bondingProgress < BONDING_MID_THRESHOLD) {
                // Getting closer but still early
                score += 10;
            } else if (bondingProgress > BONDING_HIGH_THRESHOLD) {
                // Too late (>98%), might miss graduation
                score += 15;
            }
            // 93-98% is the sweet spot = 0 pts
        }

        // 3. RugCheck API Scoring (max 20 pts)
        const rugCheckScore = await this.getRugCheckScore(mint);
        score += rugCheckScore;

        // 4. Soft Warning Scoring (max 15 pts, +5 each warning, capped at 3)
        const softWarningScore = this.getSoftWarningScore(token);
        score += Math.min(softWarningScore, 15);

        // Clamp to 0-100
        return Math.max(0, Math.min(100, score));
    }

    /**
     * Check if string contains hard scam keywords
     * Returns: bool (true if contains blocked keywords)
     */
    isHardScam(str) {
        if (!str) return false;
        const lowerStr = str.toLowerCase();
        return HARD_BLOCK_KEYWORDS.some(keyword => lowerStr.includes(keyword));
    }

    // ============ INTERNAL HELPERS ============

    /**
     * Validate symbol length (1-12 characters)
     */
    isValidSymbolLength(symbol) {
        if (!symbol) return false;
        const len = symbol.length;
        return len >= MIN_SYMBOL_LENGTH && len <= MAX_SYMBOL_LENGTH;
    }

    /**
     * Get risk level label from score
     */
    getRiskLevel(score) {
        if (score <= 25) return 'LOW';
        if (score <= 50) return 'NORMAL';
        return 'ELEVATED';
    }

    /**
     * Collect soft warnings (don't block, just log)
     */
    collectSoftWarnings(token, warnings) {
        const { name, symbol, twitter, website } = token;
        const combinedText = `${name || ''} ${symbol || ''}`.toLowerCase();

        // 1. Very short name (<3 chars)
        if (symbol && symbol.length < 3) {
            warnings.push(`Very short symbol: "${symbol}" (${symbol.length} chars)`);
        }

        // 2. Numeric-only name
        if (symbol && /^\d+$/.test(symbol)) {
            warnings.push(`Numeric-only symbol: "${symbol}"`);
        }

        // 3. Soft warning keywords
        for (const keyword of SOFT_WARNING_KEYWORDS) {
            if (combinedText.includes(keyword)) {
                warnings.push(`Contains "${keyword}" in name/symbol`);
            }
        }

        // 4. No socials
        if (!twitter && !website) {
            warnings.push('No Twitter or Website found');
        }
    }

    /**
     * Calculate score from soft warnings
     */
    getSoftWarningScore(token) {
        const { name, symbol } = token;
        const combinedText = `${name || ''} ${symbol || ''}`.toLowerCase();

        let warningCount = 0;

        for (const keyword of SOFT_WARNING_KEYWORDS) {
            if (combinedText.includes(keyword)) {
                warningCount++;
            }
        }

        // Cap at 3 warnings max (15 pts)
        return Math.min(warningCount, 3) * 5;
    }

    // ============ RUGCHECK API ============

    /**
     * Get RugCheck risk score (0-20 pts)
     * On failure → ALLOW (return 0)
     */
    async getRugCheckScore(mint) {
        if (!mint) return 0;

        // Check cache first
        const cacheKey = `rugcheck_${mint}`;
        const cached = this.rugCheckCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp < RUGCHECK_CACHE_TTL)) {
            return cached.score;
        }

        try {
            const response = await this.httpClient.get(
                `${RUGCHECK_API_URL}/tokens/${mint}/report`,
                { timeout: METADATA_TIMEOUT }
            );

            const data = response.data;

            // Count risks
            const riskCount = data?.risks?.length || 0;

            let score = 0;
            if (riskCount > 3) {
                score = 20;  // Many risks
            } else if (riskCount > 1) {
                score = 10;  // Some risks
            }
            // 0-1 risks = 0 pts (good)

            // Cache result
            this.rugCheckCache.set(cacheKey, { score, timestamp: Date.now() });

            this.logger.debug('RugCheck result', { mint, riskCount, score });
            return score;

        } catch (error) {
            // On API failure → ALLOW trade (assume safe)
            this.logger.debug('RugCheck API failed - assuming safe', {
                mint,
                error: error.message
            });

            // Cache the failure to avoid hammering API
            this.rugCheckCache.set(cacheKey, { score: 0, timestamp: Date.now() });
            return 0;
        }
    }

    /**
     * Full RugCheck analysis with detailed risks
     */
    async getRugCheckDetails(mint) {
        if (!mint) return null;

        try {
            const response = await this.httpClient.get(
                `${RUGCHECK_API_URL}/tokens/${mint}/report`,
                { timeout: METADATA_TIMEOUT }
            );

            return {
                risks: response.data?.risks || [],
                riskLevel: response.data?.riskLevel || 'unknown',
                score: response.data?.score || 0,
                metadata: response.data?.token || null
            };

        } catch (error) {
            return null;
        }
    }

    // ============ METADATA FETCHING ============

    /**
     * Fetch token metadata with timeout
     * On failure → Flag as ELEVATED risk
     */
    async fetchMetadata(uri) {
        if (!uri) return null;

        // Check cache
        const cached = this.metadataCache.get(uri);
        if (cached && (Date.now() - cached.timestamp < RUGCHECK_CACHE_TTL)) {
            return cached.data;
        }

        try {
            const response = await this.httpClient.get(uri, {
                timeout: METADATA_TIMEOUT
            });

            const data = response.data;

            // Cache result
            this.metadataCache.set(uri, { data, timestamp: Date.now() });

            return data;

        } catch (error) {
            this.logger.debug('Metadata fetch failed', { uri, error: error.message });
            return null;
        }
    }

    /**
     * Extract socials from metadata
     */
    extractSocials(metadata) {
        if (!metadata) return { twitter: null, website: null };

        let twitter = null;
        let website = null;

        // Check standard locations
        if (metadata.twitter) twitter = metadata.twitter;
        if (metadata.extensions?.twitter) twitter = metadata.extensions.twitter;
        if (metadata.external_url) website = metadata.external_url;
        if (metadata.extensions?.website) website = metadata.extensions.website;

        // Check description for links
        const desc = metadata.description || '';
        if (!twitter && (desc.includes('twitter.com') || desc.includes('x.com'))) {
            twitter = 'found_in_description';
        }

        return { twitter, website };
    }

    // ============ PUMP.FUN TRANSACTION PARSING ============

    /**
     * Parse Pump.fun Create instruction from transaction
     * Format: discriminator(8) + name(string) + symbol(string) + uri(string)
     * String format: [length LE u32][bytes]
     * 
     * On parse failure → ALLOW, flag as ELEVATED
     */
    parseCreateInstruction(transaction) {
        try {
            if (!transaction || !transaction.transaction || !transaction.transaction.message) {
                return { success: false, error: 'Invalid transaction format' };
            }

            const message = transaction.transaction.message;
            const accountKeys = message.accountKeys || message.staticAccountKeys || [];

            // Find Pump.fun program ID in account keys
            const pumpProgramIndex = accountKeys.findIndex(key => {
                const keyStr = typeof key === 'string' ? key : key.pubkey?.toString();
                return keyStr === PUMP_FUN_PROGRAM.toBase58();
            });

            if (pumpProgramIndex === -1) {
                return { success: false, error: 'Pump.fun program not found in transaction' };
            }

            // Find the instruction that references Pump.fun
            const instructions = message.instructions || [];
            let createInstruction = null;

            for (const ix of instructions) {
                const programIdx = ix.programIdIndex !== undefined
                    ? ix.programIdIndex
                    : ix.programId;

                if (programIdx === pumpProgramIndex ||
                    (typeof programIdx === 'string' && programIdx === PUMP_FUN_PROGRAM.toBase58())) {

                    // Check if data is long enough (> 50 bytes typically for Create)
                    const data = ix.data;
                    if (data && data.length > 50) {
                        createInstruction = ix;
                        break;
                    }
                }
            }

            if (!createInstruction) {
                return { success: false, error: 'Create instruction not found' };
            }

            // Decode the instruction data
            let rawData;
            if (typeof createInstruction.data === 'string') {
                // Base58 or base64 encoded
                try {
                    rawData = Buffer.from(createInstruction.data, 'base64');
                } catch {
                    const bs58 = require('bs58');
                    rawData = Buffer.from(bs58.decode(createInstruction.data));
                }
            } else if (Buffer.isBuffer(createInstruction.data)) {
                rawData = createInstruction.data;
            } else {
                rawData = Buffer.from(createInstruction.data);
            }

            // Parse: discriminator (8 bytes) + strings
            const discriminator = rawData.slice(0, 8);
            let offset = 8;

            // Read name
            const nameResult = this.readString(rawData, offset);
            if (!nameResult.success) {
                return { success: false, error: 'Failed to read name' };
            }
            offset = nameResult.newOffset;

            // Read symbol
            const symbolResult = this.readString(rawData, offset);
            if (!symbolResult.success) {
                return { success: false, error: 'Failed to read symbol' };
            }
            offset = symbolResult.newOffset;

            // Read URI
            const uriResult = this.readString(rawData, offset);
            if (!uriResult.success) {
                return { success: false, error: 'Failed to read uri' };
            }

            return {
                success: true,
                name: nameResult.value,
                symbol: symbolResult.value,
                uri: uriResult.value,
                discriminator: discriminator.toString('hex')
            };

        } catch (error) {
            // On parse failure → ALLOW, flag as ELEVATED
            return {
                success: false,
                error: error.message,
                elevated: true  // Flag for caller to set ELEVATED risk
            };
        }
    }

    /**
     * Read a length-prefixed string from buffer
     * Format: [length LE u32][bytes]
     */
    readString(buffer, offset) {
        try {
            if (offset + 4 > buffer.length) {
                return { success: false };
            }

            const length = buffer.readUInt32LE(offset);
            offset += 4;

            if (offset + length > buffer.length) {
                return { success: false };
            }

            const value = buffer.slice(offset, offset + length).toString('utf8');

            return {
                success: true,
                value,
                newOffset: offset + length
            };

        } catch {
            return { success: false };
        }
    }

    // ============ QUICK ANALYSIS FOR EVENTS ============

    /**
     * Quick token analysis from Pump.fun event
     * Used by event handlers for rapid decision making
     */
    async quickAnalyze(event) {
        const startTime = Date.now();

        try {
            // Try to parse Create instruction if we have the transaction
            let tokenInfo = {
                mint: event.mint,
                name: event.name || 'UNKNOWN',
                symbol: event.symbol || 'UNK',
                liquidity: 0,
                bondingProgress: 0
            };

            // If we have signature, try to fetch and parse tx
            if (event.signature && !event.name) {
                const tx = await this.connection.getParsedTransaction(event.signature, {
                    maxSupportedTransactionVersion: 0,
                    commitment: 'confirmed'
                });

                if (tx) {
                    const parsed = this.parseCreateInstruction(tx);
                    if (parsed.success) {
                        tokenInfo.name = parsed.name;
                        tokenInfo.symbol = parsed.symbol;

                        // Try to fetch metadata for socials
                        if (parsed.uri) {
                            const metadata = await this.fetchMetadata(parsed.uri);
                            if (metadata) {
                                const socials = this.extractSocials(metadata);
                                tokenInfo.twitter = socials.twitter;
                                tokenInfo.website = socials.website;
                            }
                        }
                    } else if (parsed.elevated) {
                        // Parse failed, but allow with elevated risk
                        tokenInfo.forceElevated = true;
                    }
                }
            }

            // Run trade decision
            const decision = await this.shouldTrade(tokenInfo);

            const elapsed = Date.now() - startTime;
            this.logger.debug(`Quick analysis completed in ${elapsed}ms`, {
                symbol: tokenInfo.symbol,
                trade: decision.trade,
                riskScore: decision.riskScore
            });

            return {
                ...decision,
                tokenInfo,
                elapsed
            };

        } catch (error) {
            // On error, ALLOW with ELEVATED risk
            this.logger.warn('Quick analysis error - allowing with elevated risk', {
                error: error.message
            });

            return {
                trade: true,
                riskScore: 50,
                riskLevel: 'ELEVATED',
                reason: 'Analysis error - defaulting to allow',
                warnings: ['Quick analysis failed'],
                tokenInfo: { mint: event.mint, symbol: event.symbol || 'UNK' },
                elapsed: Date.now() - startTime
            };
        }
    }

    /**
     * Enhanced token data enrichment
     * Adds liquidity and bonding curve data from chain
     */
    async enrichTokenData(mint, bondingCurveManager) {
        const enriched = { mint };

        try {
            // Get bonding curve state
            if (bondingCurveManager) {
                const curveState = await bondingCurveManager.getCurveState(mint);
                if (curveState) {
                    enriched.bondingProgress = curveState.progress;
                    enriched.realSol = curveState.realSol;
                    enriched.marketCapSOL = curveState.marketCapSOL;
                    enriched.complete = curveState.complete;

                    // Estimate USD liquidity (SOL * estimated price)
                    // Using rough $200/SOL estimate for quick calculation
                    enriched.liquidity = curveState.realSol * 200;
                }
            }
        } catch (error) {
            this.logger.debug('Failed to enrich token data', { mint, error: error.message });
        }

        return enriched;
    }

    // ============ UTILITY METHODS ============

    /**
     * Clear all caches
     */
    clearCaches() {
        this.rugCheckCache.clear();
        this.metadataCache.clear();
        this.logger.info('Risk filter caches cleared');
    }

    /**
     * Get cache statistics
     */
    getCacheStats() {
        return {
            rugCheckCacheSize: this.rugCheckCache.size,
            metadataCacheSize: this.metadataCache.size
        };
    }

    /**
     * Health check for external APIs
     */
    async healthCheck() {
        const results = {
            rugcheck: false,
            timestamp: Date.now()
        };

        try {
            const response = await this.httpClient.get(
                `${RUGCHECK_API_URL}/health`,
                { timeout: 3000 }
            );
            results.rugcheck = response.status === 200;
        } catch {
            results.rugcheck = false;
        }

        return results;
    }
}

module.exports = RiskFilter;
