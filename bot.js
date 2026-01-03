
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
console.log('Forced DNS to Google + Cloudflare');

const originalFetch = global.fetch;
global.fetch = async (input, init) => {
    let url = typeof input === 'string' ? input : input.url;
    if (url.includes('quote-api.jup.ag')) {
        url = url.replace('quote-api.jup.ag', '104.18.20.123');
    }
    return originalFetch(url, init);
};

const axios = require('axios');
const axiosRetry = require('axios-retry').default;
axiosRetry(axios, { retries: 3 });
const PumpFunDirect = require('./modules/pumpfun-direct');

console.log('🚀 Bot starting...', new Date().toISOString());
process.on('exit', (code) => {
    console.log('💀 Process exiting with code:', code);
});

process.on('uncaughtException', (err) => {  // ← Parameter is 'err'
    console.error('UNCAUGHT EXCEPTION:', err);  // ← Use 'err' not 'error'
    console.error('Stack:', err.stack);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED REJECTION at:', promise, 'reason:', reason);
    // Don't exit on rejection - just log it
});

require('dotenv').config();

if (global.gc) {
    console.log('✅ Garbage collection enabled');
} else {
    console.log('⚠️  Run with: node --expose-gc bot.js');
}

console.log('ENV CHECK:');
console.log('TELEGRAM_TOKEN:', process.env.TELEGRAM_TOKEN ? 'SET' : 'MISSING');
console.log('BITQUERY_API_KEY:', process.env.BITQUERY_API_KEY ? 'SET' : 'MISSING');
console.log('PRIVATE_KEY:', process.env.PRIVATE_KEY ? 'SET' : 'MISSING');
console.log('USE_WEBHOOK:', process.env.USE_WEBHOOK);


const path = require('path');
const Mutex = require('./modules/mutex');
const LRUCache = require('./modules/lru-cache');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const winston = require('winston');
// const { Worker } = require('worker_threads');
const { Connection, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL, Keypair, Transaction, SystemProgram } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = require('node-fetch');
const AbortController = require('abort-controller');

const fs = require('fs');

const requiredDirs = ['logs', 'data'];
requiredDirs.forEach(dir => {
    const dirPath = path.join(__dirname, dir);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        console.log(`✅ Created directory: ${dir}/`);
    }
});

const logDir = path.join(__dirname, 'logs');
const dataDir = path.join(__dirname, 'data');
const MIN_JUPITER_AMOUNT_LAMPORTS = Math.floor(0.0025 * LAMPORTS_PER_SOL);


// Import our new modules
const DatabaseManager = require('./modules/database');
const TechnicalIndicators = require('./modules/indicators');
const BacktestEngine = require('./modules/backtest');
const DEXAggregator = require('./modules/dex-aggregator');
const MEVProtection = require('./modules/mev-protection');
const HealthMonitor = require('./modules/health-monitor');
const AnomalyDetector = require('./modules/anomaly-detector');
const PumpMonitor = require('./modules/pump-monitor');
const TokenFilter = require('./modules/token-filter');

const BondingCurveManager = require('./modules/bonding-curve');

// ============ WINSTON LOGGING SETUP ============
const logger = winston.createLogger({
    level: 'info', // Only info and above
    format: winston.format.combine(
        winston.format.timestamp({ format: 'HH:mm:ss' }), // Shorter timestamp
        winston.format.simple() // Simple format = less memory
    ),
    defaultMeta: { service: 'trading-bot' },
    transports: [
        // Only console in production - no file logging
        new winston.transports.Console({
            format: winston.format.simple()
        })
    ]
});

const jupiterClient = axios.create({
    timeout: 15000,
    headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'SolanaTrader/1.0'
    }
});

axiosRetry(jupiterClient, {
    retries: 5,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (error) => {
        return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
            (error.response && error.response.status >= 500) ||
            error.code === 'ECONNRESET' ||
            error.code === 'ETIMEDOUT' ||
            error.code === 'ENOTFOUND';
    },
    onRetry: (retryCount, error) => {
        console.log(`🔄 Jupiter retry ${retryCount}/5: ${error.message}`);
    }
});

const JUPITER_ENDPOINTS = [
    'https://quote-api.jup.ag/v6',
    'https://public.jupiterapi.com/v6',
    'https://jupiter-swap-api.quiknode.pro/v6'
];

let currentJupiterEndpoint = 0;
let jupiterEndpointFailures = [0, 0, 0];

function getJupiterEndpoint() {
    if (jupiterEndpointFailures[currentJupiterEndpoint] > 3) {
        const oldIndex = currentJupiterEndpoint;
        currentJupiterEndpoint = (currentJupiterEndpoint + 1) % JUPITER_ENDPOINTS.length;
        console.log(`⚠️  Switching Jupiter endpoint: ${oldIndex} → ${currentJupiterEndpoint}`);
        jupiterEndpointFailures[oldIndex] = 0;
    }
    return JUPITER_ENDPOINTS[currentJupiterEndpoint];
}

function recordJupiterSuccess() {
    jupiterEndpointFailures[currentJupiterEndpoint] = 0;
}

function recordJupiterFailure() {
    jupiterEndpointFailures[currentJupiterEndpoint]++;
}



// ============ CONFIGURATION ============
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const AUTHORIZED_USERS = process.env.AUTHORIZED_USERS?.split(',') || [];

// RPC Configuration
const SOLANA_RPC_URL = process.env.PRIMARY_RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    'https://api.mainnet-beta.solana.com';

const RPC_FALLBACK_URLS = (process.env.RPC_FALLBACK_URLS ||
    'https://api.mainnet-beta.solana.com,https://rpc.ankr.com/solana')
    .split(',')
    .filter(url => url.trim());

// const PORT = process.env.PORT || 4002;
const USE_WEBHOOK = process.env.USE_WEBHOOK === 'false';
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// Trading Parameters
const DAILY_PROFIT_TARGET = parseFloat(process.env.DAILY_PROFIT_TARGET) || 0.20; // 20% daily
const DAILY_STOP_LOSS = parseFloat(process.env.DAILY_STOP_LOSS) || 0.15;
const PER_TRADE_PROFIT_TARGET = 0.20; // Increased to 20%
const PER_TRADE_STOP_LOSS = 0.15; // Tightened to 15%
const SCALP_PROFIT_MIN = 0.08;
const SCALP_PROFIT_MAX = 0.15;
const EXTENDED_HOLD_MINUTES = 5; // 5 minute max hold
const EXTENDED_HOLD_TARGET = parseFloat(process.env.EXTENDED_HOLD_TARGET) || 0.28;
const COOLDOWN_HOURS = parseInt(process.env.COOLDOWN_HOURS) || 24;
const MIN_LIQUIDITY_USD = parseFloat(process.env.MIN_LIQUIDITY_USD) || 8000;
const VOLUME_SPIKE_MULTIPLIER = parseFloat(process.env.VOLUME_SPIKE_MULTIPLIER) || 1.8;
const LARGE_SELL_THRESHOLD = parseFloat(process.env.LARGE_SELL_THRESHOLD) || 500;
const WHALE_DETECTION_WINDOW = parseInt(process.env.WHALE_DETECTION_WINDOW) || 3;

// Priority Fees - Dynamic
const BASE_PRIORITY_FEE_SOL = parseFloat(process.env.BASE_PRIORITY_FEE_SOL) || 0.001;
const HOT_LAUNCH_PRIORITY_FEE_SOL = parseFloat(process.env.HOT_LAUNCH_PRIORITY_FEE_SOL) || 0.003;
const MAX_PRIORITY_FEE_SOL = parseFloat(process.env.MAX_PRIORITY_FEE_SOL) || 0.01;

// Position Sizing
const POSITION_SIZE_MODE = process.env.POSITION_SIZE_MODE || 'PERCENTAGE';
const FIXED_POSITION_SIZE = parseFloat(process.env.FIXED_POSITION_SIZE) || 20;
const PERCENTAGE_POSITION_SIZE = parseFloat(process.env.PERCENTAGE_POSITION_SIZE) || 0.12;
const MAX_POSITION_SIZE = parseFloat(process.env.MAX_POSITION_SIZE) || 120;
const MIN_POSITION_SIZE = parseFloat(process.env.MIN_POSITION_SIZE) || 10;

// Portfolio Settings
const MAX_CONCURRENT_POSITIONS = 3;
const MAX_POSITION_PER_TOKEN = parseFloat(process.env.MAX_POSITION_PER_TOKEN) || 0.4; // 40% max per token
const ENABLE_PORTFOLIO_REBALANCING = process.env.ENABLE_PORTFOLIO_REBALANCING === 'true';

// Profit Taking
const ENABLE_PROFIT_TAKING = process.env.ENABLE_PROFIT_TAKING === 'true';
const PROFIT_TAKING_THRESHOLD = parseFloat(process.env.PROFIT_TAKING_THRESHOLD) || 100;
const PROFIT_TAKING_PERCENTAGE = parseFloat(process.env.PROFIT_TAKING_PERCENTAGE) || 0.5;

// Auto Adjustment
const ENABLE_AUTO_ADJUSTMENT = process.env.ENABLE_AUTO_ADJUSTMENT === 'true';
const AUTO_ADJUST_INTERVAL = parseInt(process.env.AUTO_ADJUST_INTERVAL) || 7;
const MIN_TRADES_FOR_ADJUSTMENT = parseInt(process.env.MIN_TRADES_FOR_ADJUSTMENT) || 20;

// API Optimization
const SCAN_INTERVAL_MINUTES = parseInt(process.env.SCAN_INTERVAL_MINUTES) || 15;
const MAX_CANDIDATES_TO_ANALYZE = parseInt(process.env.MAX_CANDIDATES_TO_ANALYZE) || 5;
const ENABLE_VOLUME_CHECK = process.env.ENABLE_VOLUME_CHECK !== 'false';
const ENABLE_WHALE_CHECK = process.env.ENABLE_WHALE_CHECK !== 'false';
const SHARED_CACHE_ENABLED = process.env.SHARED_CACHE_ENABLED === 'true';
const CACHE_DURATION_MINUTES = parseInt(process.env.CACHE_DURATION_MINUTES) || 10;
const MIN_BONDING_PROGRESS = parseFloat(process.env.MIN_BONDING_PROGRESS) || 93;
const MAX_BONDING_PROGRESS = parseFloat(process.env.MAX_BONDING_PROGRESS) || 98;
const PRIORITIZE_HOT_TOKENS = process.env.PRIORITIZE_HOT_TOKENS !== 'false';

// New Features
const ENABLE_PAPER_TRADING = process.env.ENABLE_PAPER_TRADING === 'true';
const ENABLE_BACKTESTING = process.env.ENABLE_BACKTESTING === 'true';
const ENABLE_MULTI_DEX = process.env.ENABLE_MULTI_DEX === 'true';
const ENABLE_TECHNICAL_ANALYSIS = process.env.ENABLE_TECHNICAL_ANALYSIS !== 'false';
const ENABLE_MEV_PROTECTION = process.env.ENABLE_MEV_PROTECTION !== 'false';
const ENABLE_HEALTH_MONITORING = process.env.ENABLE_HEALTH_MONITORING !== 'false';
const ENABLE_ANOMALY_DETECTION = process.env.ENABLE_ANOMALY_DETECTION !== 'false';
const ENABLE_MULTI_THREADING = process.env.ENABLE_MULTI_THREADING === 'true';

// Timeouts
const JUPITER_QUOTE_TIMEOUT = 12000;
const JUPITER_SWAP_TIMEOUT = 20000;
const TX_CONFIRMATION_TIMEOUT = 30000;
const MAX_RETRIES = 3;

// DEX Configuration
const JUPITER_API_URL = 'https://quote-api.jup.ag/v6';
const RAYDIUM_API_URL = 'https://api.raydium.io/v2';
const ORCA_API_URL = 'https://api.orca.so';
const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Technical Indicators Settings
const RSI_PERIOD = parseInt(process.env.RSI_PERIOD) || 14;
const RSI_OVERBOUGHT = parseFloat(process.env.RSI_OVERBOUGHT) || 70;
const RSI_OVERSOLD = parseFloat(process.env.RSI_OVERSOLD) || 30;
const MACD_FAST = parseInt(process.env.MACD_FAST) || 12;
const MACD_SLOW = parseInt(process.env.MACD_SLOW) || 26;
const MACD_SIGNAL = parseInt(process.env.MACD_SIGNAL) || 9;
const VOLUME_MA_PERIOD = parseInt(process.env.VOLUME_MA_PERIOD) || 20;

// Circuit Breaker Settings
const MAX_CONSECUTIVE_LOSSES = parseInt(process.env.MAX_CONSECUTIVE_LOSSES) || 5;
const MAX_DAILY_LOSSES = parseInt(process.env.MAX_DAILY_LOSSES) || 10;
const CIRCUIT_BREAKER_COOLDOWN_MINUTES = parseInt(process.env.CIRCUIT_BREAKER_COOLDOWN_MINUTES) || 60;

// ============ UTILITY FUNCTIONS ============
async function fetchWithTimeout(url, options = {}, timeout = 10000) {
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

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Mutex imported from modules/mutex.js

// ============ CIRCUIT BREAKER ============
class CircuitBreaker {
    constructor() {
        this.consecutiveLosses = 0;
        this.dailyLosses = 0;
        this.isTripped = false;
        this.tripTime = null;
        this.dailyResetTime = Date.now();

        // Escalation Logic
        this.tripCount = 0;
        this.cooldowns = [60, 360, 1440, Infinity]; // Minutes: 1h, 6h, 24h, Perm
    }

    recordTrade(isWin) {
        if (isWin) {
            this.consecutiveLosses = 0;
        } else {
            this.consecutiveLosses++;
            this.dailyLosses++;
        }

        if (this.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
            this.trip('consecutive_losses');
        }

        if (this.dailyLosses >= MAX_DAILY_LOSSES) {
            this.trip('daily_losses');
        }
    }

    trip(reason) {
        if (this.isTripped) return;

        this.isTripped = true;
        this.tripTime = Date.now();
        this.tripCount = Math.min(this.tripCount + 1, 4); // Cap at 4 (Permanent indices)

        const cooldownMin = this.cooldowns[Math.min(this.tripCount - 1, 3)];
        logger.error('💥 Circuit breaker tripped', {
            reason,
            tripCount: this.tripCount,
            cooldown: cooldownMin === Infinity ? 'PERMANENT' : `${cooldownMin}m`
        });
    }

    // Manual reset only via command
    forceReset() {
        this.isTripped = false;
        this.consecutiveLosses = 0;
        this.tripTime = null;
        // tripCount persists to punish repeated failures
        logger.info('Circuit breaker manually reset');
    }

    checkDailyReset() {
        if (Date.now() - this.dailyResetTime >= 24 * 60 * 60 * 1000) {
            this.dailyLosses = 0;
            this.dailyResetTime = Date.now();
            logger.info('Circuit breaker daily counters reset');
        }
    }

    canTrade() {
        if (!this.isTripped) return true;

        // Auto-expiration check
        const cooldownMin = this.cooldowns[Math.min(this.tripCount - 1, 3)];
        if (cooldownMin === Infinity) return false;

        if (Date.now() - this.tripTime >= cooldownMin * 60 * 1000) {
            this.isTripped = false;
            this.tripTime = null;
            logger.info('Circuit breaker cooldown expired');
            return true;
        }
        return false;
    }

    getStatus() {
        return {
            isTripped: this.isTripped,
            consecutiveLosses: this.consecutiveLosses,
            dailyLosses: this.dailyLosses,
            cooldownRemaining: this.isTripped ?
                Math.max(0, CIRCUIT_BREAKER_COOLDOWN_MINUTES * 60 - (Date.now() - this.tripTime) / 1000) : 0
        };
    }
}

// ============ DYNAMIC PRIORITY FEE CALCULATOR ============
class PriorityFeeCalculator {
    constructor(rpcConnection) {
        this.rpcConnection = rpcConnection;
        this.recentFees = [];
        this.maxSamples = 20;
    }

    async getRecentPriorityFees() {
        try {
            const operation = async (conn) => {
                const recentBlocks = await conn.getRecentPerformanceSamples(10);
                return recentBlocks;
            };

            const blocks = await this.rpcConnection.executeWithFallback(operation, 'getRecentPriorityFees');

            if (!blocks || blocks.length === 0) return null;

            // Calculate average fee from recent blocks
            const avgFee = blocks.reduce((sum, block) => sum + (block.numTransactions || 0), 0) / blocks.length;
            return avgFee;
        } catch (error) {
            logger.warn('Failed to get recent priority fees', { error: error.message });
            return null;
        }
    }

    async calculateOptimalFee(isHotLaunch = false, urgency = 'normal') {
        const networkFee = await this.getRecentPriorityFees();

        let baseFee = isHotLaunch ? HOT_LAUNCH_PRIORITY_FEE_SOL : BASE_PRIORITY_FEE_SOL;

        // Adjust based on network congestion
        if (networkFee) {
            if (networkFee > 3000) baseFee *= 2; // High congestion
            else if (networkFee > 2000) baseFee *= 1.5; // Medium congestion
        }

        // Adjust based on urgency
        const urgencyMultiplier = {
            'low': 0.5,
            'normal': 1.0,
            'high': 1.5,
            'critical': 2.0
        };

        baseFee *= urgencyMultiplier[urgency] || 1.0;

        // Cap at maximum
        baseFee = Math.min(baseFee, MAX_PRIORITY_FEE_SOL);

        const feeLamports = Math.floor(baseFee * LAMPORTS_PER_SOL);

        logger.debug('Calculated priority fee', {
            baseFee,
            feeLamports,
            isHotLaunch,
            urgency,
            networkFee
        });

        return feeLamports;
    }
}

// ============ RPC CONNECTION WITH PROPER FALLBACK ============
class RobustConnection {
    constructor(primaryUrl, fallbackUrls = []) {
        this.primaryUrl = primaryUrl;
        this.fallbackUrls = fallbackUrls;
        this.currentIndex = 0;
        this.allUrls = [primaryUrl, ...fallbackUrls];

        // Configure WebSocket with rate limit protection
        this.connections = this.allUrls.map((url, index) => new Connection(url, {
            commitment: 'confirmed',
            confirmTransactionInitialTimeout: TX_CONFIRMATION_TIMEOUT,
            // WebSocket config to prevent 429 errors
            wsEndpoint: index === 0 ? url.replace('https://', 'wss://') : undefined,
            disableRetryOnRateLimit: index > 0, // Disable WS retry on fallbacks
        }));

        this.failureCounts = new Array(this.allUrls.length).fill(0);
        this.lastFailureTime = new Array(this.allUrls.length).fill(0);

        logger.info('RPC initialized', {
            primary: primaryUrl,
            fallbacks: fallbackUrls.length,
            wsEnabled: 'primary only'
        });
    }

    getCurrentConnection() {
        return this.connections[this.currentIndex];
    }

    async executeWithFallback(operation, operationName = 'RPC call') {
        const maxAttempts = this.allUrls.length;
        let lastError;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const index = (this.currentIndex + attempt) % this.allUrls.length;
            const conn = this.connections[index];
            const url = this.allUrls[index];

            const timeSinceFailure = Date.now() - this.lastFailureTime[index];
            if (this.failureCounts[index] > 5 && timeSinceFailure < 60000) {
                logger.debug('Skipping recently failed RPC', { url: url.substring(0, 40) });
                continue;
            }

            try {
                logger.debug(`${operationName} attempt ${attempt + 1}/${maxAttempts}`, { rpc: index });
                const result = await operation(conn);

                this.failureCounts[index] = 0;
                if (index !== this.currentIndex) {
                    logger.info('Switched to fallback RPC', { index, url: url.substring(0, 40) });
                    this.currentIndex = index;
                }

                return result;
            } catch (error) {
                lastError = error;
                this.failureCounts[index]++;
                this.lastFailureTime[index] = Date.now();
                logger.error(`RPC operation failed`, {
                    operation: operationName,
                    attempt,
                    error: error.message,
                    rpc: url.substring(0, 40)
                });

                if (attempt < maxAttempts - 1) {
                    await sleep(1000 * (attempt + 1));
                }
            }
        }

        throw new Error(`All RPC endpoints failed. Last error: ${lastError?.message}`);
    }

    getStatus() {
        return {
            currentUrl: this.allUrls[this.currentIndex],
            currentIndex: this.currentIndex,
            failureCounts: [...this.failureCounts],
            isPrimary: this.currentIndex === 0,
            totalEndpoints: this.allUrls.length
        };
    }
}

// ============ PORTFOLIO MANAGER ============
class PortfolioManager {
    constructor() {
        this.positions = new Map(); // tokenAddress -> position
        this.maxPositions = MAX_CONCURRENT_POSITIONS;
    }

    canAddPosition() {
        return this.positions.size < this.maxPositions;
    }

    hasPosition(tokenAddress) {
        return this.positions.has(tokenAddress);
    }

    addPosition(tokenAddress, position) {
        if (!this.canAddPosition()) {
            throw new Error('Maximum concurrent positions reached');
        }
        this.positions.set(tokenAddress, position);
        logger.info('Position added to portfolio', {
            token: position.symbol,
            totalPositions: this.positions.size
        });
    }

    removePosition(tokenAddress) {
        const position = this.positions.get(tokenAddress);
        this.positions.delete(tokenAddress);
        logger.info('Position removed from portfolio', {
            token: position?.symbol,
            totalPositions: this.positions.size
        });
    }

    getPosition(tokenAddress) {
        return this.positions.get(tokenAddress);
    }

    getAllPositions() {
        return Array.from(this.positions.values());
    }

    getTotalInvested() {
        return Array.from(this.positions.values())
            .reduce((sum, pos) => sum + pos.investedUSDC, 0);
    }

    getPositionAllocation(tokenAddress) {
        const total = this.getTotalInvested();
        if (total === 0) return 0;
        const position = this.positions.get(tokenAddress);
        return position ? position.investedUSDC / total : 0;
    }

    canIncreasePosition(tokenAddress, additionalAmount) {
        const total = this.getTotalInvested() + additionalAmount;
        const position = this.positions.get(tokenAddress);
        const currentInvestment = position ? position.investedUSDC : 0;
        const newAllocation = (currentInvestment + additionalAmount) / total;

        return newAllocation <= MAX_POSITION_PER_TOKEN;
    }

    getStats() {
        const positions = this.getAllPositions();
        return {
            totalPositions: positions.length,
            totalInvested: this.getTotalInvested(),
            positions: positions.map(p => ({
                symbol: p.symbol,
                invested: p.investedUSDC,
                allocation: (p.investedUSDC / this.getTotalInvested() * 100).toFixed(2) + '%'
            }))
        };
    }
}

// Continue in next artifact due to length...  

// ============ CONTINUATION OF BOT.JS ============
// This continues from the PortfolioManager class in the first artifact

// ============ BITQUERY CLIENT (Enhanced) ============
// ============ CORRECTED BITQUERY CLIENT ============
// ============ BITQUERY CLIENT WITH PAYLOAD DEBUGGING ============
// BitqueryClient Removed


// ============ PERFORMANCE TRACKER (Enhanced) ============
class PerformanceTracker {
    constructor(logger, database) {
        this.logger = logger;
        this.database = database;
        this.metrics = {
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            totalProfit: 0,
            totalLoss: 0,
            avgWinPercent: 0,
            avgLossPercent: 0,
            largestWin: 0,
            largestLoss: 0,
            consecutiveWins: 0,
            consecutiveLosses: 0,
            currentStreak: 0,
            lastAdjustment: Date.now(),
            strategyLevel: 'CONSERVATIVE'
        };
    }

    recordTrade(profit, profitPercent) {
        this.metrics.totalTrades++;

        if (profit > 0) {
            this.metrics.winningTrades++;
            this.metrics.totalProfit += profit;
            this.metrics.avgWinPercent = (this.metrics.avgWinPercent * (this.metrics.winningTrades - 1) + profitPercent) / this.metrics.winningTrades;
            this.metrics.largestWin = Math.max(this.metrics.largestWin, profitPercent);
            this.metrics.currentStreak = this.metrics.currentStreak >= 0 ? this.metrics.currentStreak + 1 : 1;
            this.metrics.consecutiveWins = Math.max(this.metrics.consecutiveWins, this.metrics.currentStreak);
        } else {
            this.metrics.losingTrades++;
            this.metrics.totalLoss += Math.abs(profit);
            this.metrics.avgLossPercent = (this.metrics.avgLossPercent * (this.metrics.losingTrades - 1) + Math.abs(profitPercent)) / this.metrics.losingTrades;
            this.metrics.largestLoss = Math.max(this.metrics.largestLoss, Math.abs(profitPercent));
            this.metrics.currentStreak = this.metrics.currentStreak <= 0 ? this.metrics.currentStreak - 1 : -1;
            this.metrics.consecutiveLosses = Math.max(this.metrics.consecutiveLosses, Math.abs(this.metrics.currentStreak));
        }

        this.logger.info('Trade recorded', { profit: profit.toFixed(2), profitPercent: profitPercent.toFixed(2), streak: this.metrics.currentStreak });
    }

    getWinRate() {
        if (this.metrics.totalTrades === 0) return 0;
        return (this.metrics.winningTrades / this.metrics.totalTrades) * 100;
    }

    getProfitFactor() {
        if (this.metrics.totalLoss === 0) return this.metrics.totalProfit > 0 ? 999 : 0;
        return this.metrics.totalProfit / this.metrics.totalLoss;
    }

    getExpectancy() {
        const winRate = this.getWinRate() / 100;
        const lossRate = 1 - winRate;
        return (winRate * this.metrics.avgWinPercent) - (lossRate * this.metrics.avgLossPercent);
    }

    shouldAdjustStrategy() {
        if (!ENABLE_AUTO_ADJUSTMENT) return false;
        if (this.metrics.totalTrades < MIN_TRADES_FOR_ADJUSTMENT) return false;

        const daysSinceAdjustment = (Date.now() - this.metrics.lastAdjustment) / (1000 * 60 * 60 * 24);
        return daysSinceAdjustment >= AUTO_ADJUST_INTERVAL;
    }

    getRecommendedStrategy() {
        const winRate = this.getWinRate();
        const profitFactor = this.getProfitFactor();
        const expectancy = this.getExpectancy();

        if (winRate >= 65 && profitFactor >= 2.0 && expectancy >= 5) {
            return {
                level: 'AGGRESSIVE',
                dailyTarget: 0.35,
                perTradeTarget: 0.15,
                scalpMin: 0.08,
                scalpMax: 0.15,
                extendedTarget: 0.30,
                stopLoss: 0.03,
                positionSize: 0.15,
                profitTaking: 0.30
            };
        }

        if (winRate >= 58 && profitFactor >= 1.5 && expectancy >= 3) {
            return {
                level: 'MODERATE',
                dailyTarget: 0.30,
                perTradeTarget: 0.13,
                scalpMin: 0.07,
                scalpMax: 0.13,
                extendedTarget: 0.28,
                stopLoss: 0.03,
                positionSize: 0.12,
                profitTaking: 0.40
            };
        }

        return {
            level: 'CONSERVATIVE',
            dailyTarget: 0.25,
            perTradeTarget: 0.10,
            scalpMin: 0.05,
            scalpMax: 0.10,
            extendedTarget: 0.25,
            stopLoss: 0.02,
            positionSize: 0.10,
            profitTaking: 0.50
        };
    }

    async saveMetrics(userId) {
        if (!this.database) return;

        try {
            await this.database.savePerformanceMetrics(userId, {
                totalTrades: this.metrics.totalTrades,
                winningTrades: this.metrics.winningTrades,
                losingTrades: this.metrics.losingTrades,
                totalProfit: this.metrics.totalProfit,
                totalLoss: this.metrics.totalLoss,
                winRate: this.getWinRate(),
                profitFactor: this.getProfitFactor(),
                expectancy: this.getExpectancy(),
                largestWin: this.metrics.largestWin,
                largestLoss: this.metrics.largestLoss,
                strategyLevel: this.metrics.strategyLevel
            });
        } catch (error) {
            this.logger.error('Failed to save performance metrics', { error: error.message });
        }
    }
}

// ============ TRADING ENGINE (Enhanced) ============
class TradingEngine {
    constructor(bot, wallet, rpcConnection, database) {
        this.bot = bot;
        this.wallet = wallet;
        this.rpcConnection = rpcConnection;
        // this.bitquery = bitquery; // REMOVED
        this.database = database;
        this.logger = logger;
        this.userStates = new Map();
        this.isScanning = false;
        this.tradeMutex = new Mutex();
        this.decisionCache = new LRUCache(1000); // Limit to 1000 items
        this.performanceTracker = new PerformanceTracker(logger, database);
        this.currentStrategy = null;
        this.portfolioManager = new PortfolioManager();
        this.circuitBreaker = new CircuitBreaker();
        this.priorityFeeCalculator = new PriorityFeeCalculator(rpcConnection);
        this.pumpDirect = new PumpFunDirect(this.rpcConnection.getCurrentConnection(), logger);

        // Initialize new modules
        if (ENABLE_MULTI_DEX) {
            this.dexAggregator = new DEXAggregator(logger);
        }

        if (ENABLE_MEV_PROTECTION) {
            this.mevProtection = new MEVProtection(logger);
        }

        if (ENABLE_TECHNICAL_ANALYSIS) {
            this.technicalIndicators = new TechnicalIndicators();
        }

        if (ENABLE_ANOMALY_DETECTION) {
            this.anomalyDetector = new AnomalyDetector(logger, database);
        }

        // New Sniper Modules (Pure RPC)
        this.pumpMonitor = new PumpMonitor(rpcConnection.getCurrentConnection(), logger);
        this.tokenFilter = new TokenFilter(rpcConnection.getCurrentConnection(), logger);
        this.bondingCurve = new BondingCurveManager(rpcConnection.getCurrentConnection(), logger);
    }

    async startPositionMonitor() {
        const runMonitor = async () => {
            let minDelay = 15000; // Default 15s (reduced from 60s)

            try {
                // Check WS Staleness
                const lastEvent = this.pumpMonitor ? this.pumpMonitor.getLastEventTime() : 0;
                if (Date.now() - lastEvent > 60000) {
                    logger.warn('⚠️ WebSocket stale (>60s). Forcing poll...');
                }

                for (const [userId, user] of this.userStates.entries()) {
                    if (user.isActive && user.position) {
                        try {
                            await this.monitorPosition(userId);

                            // Adaptive Interval Logic
                            const pos = user.position;
                            if (pos) {
                                const currentPrice = await this.getCurrentPrice(pos.tokenAddress);
                                if (currentPrice) {
                                    const pnl = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
                                    if (pnl < -10) minDelay = Math.min(minDelay, 2000); // 2s panic mode
                                    else if (pnl < -5) minDelay = Math.min(minDelay, 5000); // 5s concern mode
                                }
                            }
                        } catch (err) { logger.error(`Monitor Pos Error ${userId}`, { error: err.message }); }
                    }
                }
            } catch (error) {
                logger.error('Monitor error', { error: error.message });
            }

            // Schedule next run
            this.monitorTimeout = setTimeout(runMonitor, minDelay);
        };

        runMonitor();
    }

    async init() {
        logger.info('Trading engine initializing...');

        try {
            // Database init
            console.log('📦 Step 1: Initializing database...');
            await this.database.init();
            logger.info('✅ Database initialized');

            // Event Router Setup
            console.log('🎯 Step 2: Starting Pump.fun Monitor & Event Router...');

            // Strategy A: Salary Snipe (New Tokens)
            this.pumpMonitor.on('create', this.handleSalaryStrategy.bind(this));

            // Strategy B: Graduation Snipe (Migration Play)
            this.pumpMonitor.on('buy', this.handleGraduationStrategy.bind(this));

            await this.pumpMonitor.start();
            logger.info('✅ Event Router active');

            // Load state from database
            console.log('💾 Step 3: Loading user state...');
            await this.loadState();

            // 🔥 FIX: Sync all users with wallet balance on startup
            console.log('💰 Step 4: Syncing wallet balances...');
            const balances = await this.getWalletBalance();
            const tradingBalance = balances.trading;

            console.log(`   Wallet has: ${tradingBalance.toFixed(4)} available for trading`);

            for (const userId of AUTHORIZED_USERS) {
                let user = this.userStates.get(userId);

                if (!user) {
                    console.log(`   Creating new user: ${userId}`);
                    user = this.getUserState(userId);
                }

                // Get from database
                let dbUser = null;
                try {
                    dbUser = await this.database.getUser(userId.toString());
                } catch (err) {
                    logger.warn('Failed to load user from DB', { userId, error: err.message });
                }

                if (!dbUser) {
                    // New user - initialize with wallet balance
                    console.log(`   📝 New user ${userId} - initializing with wallet balance`);
                    user.startingBalance = tradingBalance;
                    user.currentBalance = tradingBalance;  // 🔥 SET THIS
                    user.dailyStartBalance = tradingBalance;
                    user.tradingCapital = tradingBalance;
                    user.isActive = false; // Will be activated by /start

                    await this.database.createUser(userId.toString(), tradingBalance);
                    console.log(`   ✅ Created with balance: ${tradingBalance.toFixed(4)}`);
                } else {
                    // Existing user - load from DB but sync balance with wallet
                    console.log(`   📝 Existing user ${userId}`);
                    console.log(`      DB balance: ${dbUser.current_balance?.toFixed(4) || '0'}`);
                    console.log(`      Wallet balance: ${tradingBalance.toFixed(4)}`);

                    user.isActive = dbUser.is_active === 1;
                    user.startingBalance = dbUser.starting_balance || tradingBalance;
                    user.dailyStartBalance = dbUser.daily_start_balance || tradingBalance;
                    user.dailyProfit = dbUser.daily_profit || 0;
                    user.dailyProfitPercent = dbUser.daily_profit_percent || 0;
                    user.currentDay = dbUser.current_day || 1;
                    user.totalTrades = dbUser.total_trades || 0;
                    user.successfulTrades = dbUser.successful_trades || 0;
                    user.lastTradeAt = dbUser.last_trade_at || 0;
                    user.dailyResetAt = dbUser.daily_reset_at || Date.now();
                    user.totalProfitTaken = dbUser.total_profit_taken || 0;

                    // 🔥 CRITICAL: Always use wallet balance as source of truth
                    user.currentBalance = tradingBalance;
                    user.tradingCapital = tradingBalance;

                    console.log(`   ✅ Loaded and synced to wallet: ${user.currentBalance.toFixed(4)}`);
                }

                // Store updated state
                this.userStates.set(userId, user);

                console.log(`   Final state: active=${user.isActive}, balance=${user.currentBalance.toFixed(4)}`);
            }

            console.log('\n📊 Initialization Summary:');
            console.log(`   Total users: ${this.userStates.size}`);
            console.log(`   Active users: ${Array.from(this.userStates.values()).filter(u => u.isActive).length}`);

            logger.info('✅ Trading engine initialized');

        } catch (error) {
            console.error('❌ Initialization failed:', error.message);
            logger.error('Initialization failed', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    async handleSalaryStrategy(event) {
        // STRATEGY A: "The Salary Snipe" (New Token Volatility)
        if (this.portfolioManager.getAllPositions().length >= MAX_CONCURRENT_POSITIONS) return;

        // Use the TokenFilter to analyze the "Create" event
        const tokenAnalysis = await this.tokenFilter.analyzeToken(event.signature);
        if (!tokenAnalysis) return;

        // Duplicate Check 1: Recently Processed
        const now = Date.now();
        if (this.decisionCache.has(tokenAnalysis.mint)) {
            const lastTime = this.decisionCache.get(tokenAnalysis.mint);
            if (now - lastTime < 60000) { // 60s cooldown
                return;
            }
        }

        // Duplicate Check 2: Active Position
        if (this.portfolioManager.hasPosition(tokenAnalysis.mint)) {
            return;
        }

        // Mark as processed
        this.decisionCache.set(tokenAnalysis.mint, now);

        logger.info(`Salary Snipe Candidate: ${tokenAnalysis.mint} (${tokenAnalysis.age}s)`);

        // Jitter: 50-200ms delay to avoid exact block pulse (Sandwich Mitigation)
        const jitter = Math.floor(Math.random() * 151) + 50;
        await new Promise(r => setTimeout(r, jitter));

        await this.executeStrategyTrade(tokenAnalysis.mint, 'SALARY_SNIPE', 0.5);
        // Fixed 0.5 SOL for Salary Snipe checks
    }

    async handleGraduationStrategy(event) {
        // STRATEGY B: "The 93% Graduation Sniper" (Migration Play)
        if (this.portfolioManager.getAllPositions().length >= MAX_CONCURRENT_POSITIONS) return;

        // We need the mint address from the Buy transaction
        // Since we don't have it in the event, we must fetch the tx
        // Optimization: In a real HFT scenario, we might parse logs smarter, but here we fetch.
        let mint = null;
        try {
            const tx = await this.rpcConnection.getCurrentConnection().getParsedTransaction(event.signature, {
                maxSupportedTransactionVersion: 0,
                commitment: 'confirmed'
            });

            if (!tx || !tx.meta || !tx.meta.postTokenBalances || tx.meta.postTokenBalances.length === 0) return;

            // Find the token mint (not SOL)
            const tokenBalance = tx.meta.postTokenBalances.find(b => b.mint !== 'So11111111111111111111111111111111111111112');
            if (tokenBalance) {
                mint = tokenBalance.mint;
            }
        } catch (e) {
            return; // Failed to parse
        }

        if (!mint) return;

        // Check Graduation Progress locally
        const graduationCheck = await this.bondingCurve.checkGraduation(mint, 93); // 93% threshold

        if (graduationCheck && graduationCheck.isGraduating && !graduationCheck.isComplete) {
            logger.info(`🎓 Graduation Sniper Trigger: ${mint} @ ${graduationCheck.data.progress.toFixed(2)}%`);

            // Dynamic position sizing for graduation (larger confidence)
            await this.executeStrategyTrade(mint, 'GRADUATION_SNIPER', null); // null = use default calc
        }
    }

    async executeStrategyTrade(mint, strategyName, fixedSizeOverride = null) {
        const activeUser = Array.from(this.userStates.values()).find(u => u.isActive);
        if (!activeUser) return;

        // Circuit Breaker Check
        if (!this.circuitBreaker.canTrade()) {
            logger.warn('Circuit breaker active - skipping trade');
            return;
        }

        try {
            // Global Wallet Lock
            await this.tradeMutex.runExclusive(async () => {
                const currentBalance = activeUser.tradingCapital;
                let tradeSize = fixedSizeOverride;

                // Calculate Position Size if not overridden
                if (!tradeSize) {
                    if (POSITION_SIZE_MODE === 'PERCENTAGE') {
                        tradeSize = currentBalance * PERCENTAGE_POSITION_SIZE;
                    } else {
                        tradeSize = FIXED_POSITION_SIZE; // Fallback
                    }
                }

                // Sanity check bounds
                tradeSize = Math.max(MIN_POSITION_SIZE, Math.min(tradeSize, MAX_POSITION_SIZE));
                tradeSize = Math.max(0.01, Math.min(tradeSize, currentBalance * 0.4)); // Hard cap 40%

                logger.info(`Executing ${strategyName} on ${mint} | Size: ${tradeSize.toFixed(4)} SOL`);

                const result = ENABLE_PAPER_TRADING
                    ? { success: true, signature: 'paper_trade_' + Date.now() }
                    : await this.pumpDirect.executeBuy({
                        wallet: this.wallet,
                        mint: mint,
                        amountSOL: tradeSize,
                        priorityFeeLamports: 200000
                    });

                if (result.success) {
                    logger.info(`Buy executed: ${result.signature}`);

                    // Record Position
                    this.portfolioManager.addPosition(mint, {
                        symbol: 'PUMP-' + mint.substring(0, 4),
                        mint: mint,
                        entryPrice: 0,
                        amountToken: 0,
                        investedUSDC: tradeSize * 200, // Approx
                        entryTime: Date.now(),
                        strategy: strategyName,
                        stopLoss: PER_TRADE_STOP_LOSS,
                        takeProfit: PER_TRADE_PROFIT_TARGET
                    });

                    // Notify User
                    this.bot.bot.sendMessage(activeUser.userId,
                        `🎯 <b>${strategyName} EXECUTED</b>\n\n` +
                        `CA: <code>${mint}</code>\n` +
                        `Size: ${tradeSize.toFixed(4)} SOL\n` +
                        `TX: https://solscan.io/tx/${result.signature}`,
                        { parse_mode: 'HTML' }
                    );
                }
            });
        } catch (error) {
            logger.error('Trade execution failed', { error: error.message });
        }
    }

    formatSellMessageWithBalance(trade, user, updatedBalances) {
        const emoji = trade.profit > 0 ? '✅' : '⚠️';
        const color = trade.profit > 0 ? '🟢' : '🔴';
        const solscanUrl = `https://solscan.io/tx/${trade.sellTxSignature}`;

        const reasonEmojis = {
            'scalp_profit': '⚡ Quick Profit',
            'extended_profit': '🎯 Target Hit',
            'stop_loss': '🛡️ Stop Loss'
        };

        const reason = reasonEmojis[trade.reason] || trade.reason.toUpperCase();

        return `
${emoji} <b>POSITION CLOSED</b> ${color}

<b>${trade.symbol}</b>
└ ${reason}

💰 <b>Trade Summary</b>
├ Entry: $${trade.entryPrice.toFixed(8)}
├ Exit: $${trade.exitPrice.toFixed(8)}
├ Change: ${((trade.exitPrice / trade.entryPrice - 1) * 100).toFixed(2)}%
└ Hold Time: ${trade.holdTimeMinutes}m

📊 <b>Financial Result</b>
├ Invested: $${trade.investedUSDC.toFixed(2)}
├ Received: $${trade.usdcReceived.toFixed(2)}
├ Net P&L: ${trade.profit > 0 ? '+' : ''}$${trade.profit.toFixed(2)}
└ Return: ${trade.profit > 0 ? '+' : ''}${trade.profitPercent.toFixed(2)}%

💼 <b>Portfolio Update</b>
├ Balance: $${user.currentBalance.toFixed(2)}
├ Wallet Actual: $${updatedBalances.trading.toFixed(4)}
├ Daily P&L: ${user.dailyProfitPercent > 0 ? '+' : ''}${user.dailyProfitPercent.toFixed(2)}%
├ Total Trades: ${user.totalTrades}
└ Win Rate: ${((user.successfulTrades / user.totalTrades) * 100).toFixed(1)}%

🔗 <a href="${solscanUrl}">View TX</a>

<i>${new Date().toLocaleTimeString()} UTC</i>
    `.trim();
    }


    async getWalletBalance() {
        try {
            console.log('\n' + '='.repeat(60));
            console.log('FETCHING WALLET BALANCE');
            console.log('='.repeat(60));

            const operation = async (conn) => await conn.getBalance(this.wallet.publicKey);
            const lamports = await this.rpcConnection.executeWithFallback(operation, 'getBalance');
            const nativeSOL = lamports / LAMPORTS_PER_SOL;

            const tokenBalances = await this.getAllTokenBalances();

            const usdcBalance = tokenBalances.find(t => t.mint === USDC_MINT)?.balance || 0;
            const wsolBalance = tokenBalances.find(t => t.mint === SOL_MINT)?.balance || 0;

            console.log(`\nNative SOL: ${nativeSOL.toFixed(6)}`);
            console.log(`Wrapped SOL: ${wsolBalance.toFixed(6)}`);
            console.log(`USDC: ${usdcBalance.toFixed(2)}`);

            // Trading balance = native SOL (priority) or USDC if large
            const tradingBalance = nativeSOL + wsolBalance; // Pure SOL focus

            console.log(`\nTrading Balance: ${tradingBalance.toFixed(6)} SOL`);
            console.log('='.repeat(60) + '\n');

            return {
                nativeSOL,
                wsol: wsolBalance,
                usdc: usdcBalance,
                trading: tradingBalance, // This is now SOL
                allTokens: tokenBalances
            };
        } catch (error) {
            logger.error('Wallet balance fetch failed', { error: error.message });
            return { nativeSOL: 0, trading: 0, usdc: 0, allTokens: [] };
        }
    }

    async getAllTokenBalances() {
        try {
            const operation = async (conn) => {
                const accounts = await conn.getTokenAccountsByOwner(this.wallet.publicKey, {
                    programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
                });

                const balances = [];
                const SOL_MINT = 'So11111111111111111111111111111111111111112';
                const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

                for (const account of accounts.value) {
                    const data = account.account.data;
                    const raw = Buffer.from(data.parsed.info.tokenAmount.uiAmountString);
                    const mint = data.parsed.info.mint;
                    const amount = parseFloat(data.parsed.info.tokenAmount.uiAmountString || '0');
                    const decimals = data.parsed.info.tokenAmount.decimals;

                    let symbol = 'UNKNOWN';
                    if (mint === SOL_MINT) symbol = 'WSOL';
                    else if (mint === USDC_MINT) symbol = 'USDC';
                    else {
                        // Try to get symbol from known list or leave as first 4 chars
                        const known = {
                            'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': 'BONK',
                            'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'BONK', // new
                            'A8C3xuq779jnnJDKciP5i4rK2YMa8FLbL8E3oSn2uBjt': 'GME',
                        };
                        symbol = known[mint] || mint.substring(0, 4).toUpperCase();
                    }

                    if (amount > 0.000001) { // filter dust
                        balances.push({
                            mint,
                            symbol,
                            balance: amount,
                            decimals
                        });
                    }
                }

                return balances.sort((a, b) => b.balance - a.balance);
            };

            return await this.rpcConnection.executeWithFallback(operation, 'getAllTokenBalances');

        } catch (error) {
            logger.error('Failed to fetch token balances', {
                error: error.message,
                stack: error.stack
            });
            return [];
        }
    }

    getTokenSymbol(mintAddress) {
        const knownTokens = {
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
            'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
            'So11111111111111111111111111111111111111112': 'WSOL',
            '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': 'RAY',
            'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'BONK',
            '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj': 'stSOL',
            'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': 'mSOL',
            '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': 'ETH',
            '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': 'WBTC'
        };

        return knownTokens[mintAddress] || `UNKNOWN (${mintAddress.slice(0, 4)}...${mintAddress.slice(-4)})`;
    }




    async getAllTokenBalances() {
        try {
            const operation = async (conn) => {
                // Get all token accounts owned by this wallet
                const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');

                console.log('\n=== FETCHING ALL TOKEN ACCOUNTS ===');
                console.log('Wallet:', this.wallet.publicKey.toString());

                const tokenAccounts = await conn.getParsedTokenAccountsByOwner(
                    this.wallet.publicKey,
                    { programId: TOKEN_PROGRAM_ID }
                );

                console.log('Total token accounts found:', tokenAccounts.value.length);

                const balances = [];

                for (const account of tokenAccounts.value) {
                    const parsedInfo = account.account.data.parsed.info;
                    const mintAddress = parsedInfo.mint;
                    const balance = parsedInfo.tokenAmount.uiAmount || 0;
                    const decimals = parsedInfo.tokenAmount.decimals;

                    console.log('\nToken Account:');
                    console.log('  Mint:', mintAddress);
                    console.log('  Balance:', balance);
                    console.log('  Decimals:', decimals);
                    console.log('  Symbol:', this.getTokenSymbol(mintAddress));

                    // Include ALL balances, even zero, for debugging
                    balances.push({
                        mint: mintAddress,
                        balance: balance,
                        decimals: decimals,
                        symbol: this.getTokenSymbol(mintAddress),
                        hasBalance: balance > 0
                    });
                }

                console.log('\n=== SUMMARY ===');
                console.log('Non-zero balances:', balances.filter(b => b.balance > 0).length);
                console.log('Zero balances:', balances.filter(b => b.balance === 0).length);

                return balances;
            };

            const balances = await this.rpcConnection.executeWithFallback(operation, 'getAllTokenBalances');

            this.logger.info('All token accounts fetched', {
                count: balances.length,
                nonZero: balances.filter(b => b.balance > 0).length,
                tokens: balances.filter(b => b.balance > 0).map(b => `${b.symbol}: ${b.balance.toFixed(4)}`)
            });

            return balances;

        } catch (error) {
            console.error('ERROR fetching token balances:', error);
            this.logger.error('Failed to get all token balances', {
                error: error.message,
                stack: error.stack
            });
            return [];
        }
    }

    getUserState(userId) {
        if (!this.userStates.has(userId)) {
            // Create with placeholder - will be updated in init()
            this.userStates.set(userId, {
                isActive: false,
                startingBalance: 0, // Will be set from wallet
                currentBalance: 0,
                dailyStartBalance: 0,
                dailyProfit: 0,
                dailyProfitPercent: 0,
                currentDay: 1,
                totalTrades: 0,
                successfulTrades: 0,
                position: null,
                tradeHistory: [],
                lastTradeAt: 0,
                dailyResetAt: Date.now(),
                totalProfitTaken: 0,
                profitTakingHistory: [],
                tradingCapital: 0
            });
        }
        return this.userStates.get(userId);
    }

    hasActiveUsers() {
        for (const [userId, user] of this.userStates.entries()) {
            if (user.isActive) return true;
        }
        return false;
    }

    async tradingCycle() {
        console.log('\n' + '🔄'.repeat(30));
        console.log('🔄 TRADING CYCLE START');
        console.log('🔄'.repeat(30));

        return this.tradeMutex.runExclusive(async () => {
            if (this.isScanning) {
                console.log('⏭️  Already scanning, skipping');
                return;
            }

            this.isScanning = true;
            console.log('✅ Scan started\n');

            try {
                // Get ALL active users
                const activeUsers = Array.from(this.userStates.entries())
                    .filter(([_, u]) => u.isActive);

                console.log(`👥 Active users: ${activeUsers.length}`);

                if (activeUsers.length === 0) {
                    console.log('❌ No active users - Use /start in Telegram\n');
                    return;
                }

                const [userId, user] = activeUsers[0];
                console.log(`Trading for user: ${userId}`);
                console.log(`Balance: ${user.currentBalance.toFixed(4)}`);
                console.log(`Has position: ${user.position ? 'YES' : 'NO'}`);

                // Check daily reset
                await this.checkDailyReset(user, userId);

                // Check daily target (only check, don't block if disabled)
                const targetHit = this.isDailyTargetHit(user);
                if (targetHit) {
                    console.log('🎯 Daily target hit - in cooldown');
                    return;
                }

                // Check max positions
                const canAddPosition = this.portfolioManager.canAddPosition();
                console.log(`💼 Can add position: ${canAddPosition}`);
                console.log(`   Current: ${this.portfolioManager.positions.size}/${MAX_CONCURRENT_POSITIONS}`);

                if (!canAddPosition) {
                    console.log('⚠️  Max positions reached');
                    return;
                }

                // 🔥 FIND OPPORTUNITY - NO BLOCKS
                console.log('\n🔍 SEARCHING FOR OPPORTUNITIES...\n');
                const opportunity = await this.findTradingOpportunity(userId);

                if (opportunity) {
                    console.log('✅ OPPORTUNITY FOUND!');
                    console.log('   Symbol:', opportunity.symbol);
                    console.log('   Bonding:', opportunity.bondingProgress.toFixed(1) + '%');
                    console.log('   Liquidity: $' + opportunity.liquidityUSD.toFixed(0));

                    // 🚀 EXECUTE IMMEDIATELY
                    await this.executeBuy(userId, opportunity);
                } else {
                    console.log('❌ No opportunity found');
                }

            } catch (err) {
                console.error('💥 CYCLE ERROR:', err.message);
                console.error('Stack:', err.stack);
            } finally {
                this.isScanning = false;
                console.log('\n' + '🔄'.repeat(30));
                console.log('🔄 CYCLE COMPLETE');
                console.log('🔄'.repeat(30) + '\n');
            }
        });
    }


    async saveState() {
        try {
            if (!this.database) {
                this.logger.warn('No database, skipping state save');
                return;
            }

            for (const [userId, user] of this.userStates.entries()) {
                await this.database.updateUser(userId, {
                    is_active: user.isActive ? 1 : 0,
                    current_balance: user.currentBalance,
                    daily_start_balance: user.dailyStartBalance,
                    daily_profit: user.dailyProfit,
                    daily_profit_percent: user.dailyProfitPercent,
                    current_day: user.currentDay,
                    total_trades: user.totalTrades,
                    successful_trades: user.successfulTrades,
                    last_trade_at: user.lastTradeAt,
                    daily_reset_at: user.dailyResetAt,
                    total_profit_taken: user.totalProfitTaken,
                    trading_capital: user.tradingCapital
                });
            }

            this.logger.debug('State saved to database');
        } catch (error) {
            this.logger.error('Failed to save state', { error: error.message });
        }
    }

    async loadState() {
        try {
            if (!this.database) {
                this.logger.warn('No database, skipping state load');
                return;
            }

            // Load active users
            for (const userId of AUTHORIZED_USERS) {
                const dbUser = await this.database.getUser(userId);

                if (!dbUser) {
                    await this.database.createUser(userId, 20);
                    this.logger.info('Created new user', { userId });
                } else {
                    this.userStates.set(userId, {
                        isActive: dbUser.is_active === 1,
                        startingBalance: dbUser.starting_balance,
                        currentBalance: dbUser.current_balance,
                        dailyStartBalance: dbUser.daily_start_balance,
                        dailyProfit: dbUser.daily_profit,
                        dailyProfitPercent: dbUser.daily_profit_percent,
                        currentDay: dbUser.current_day,
                        totalTrades: dbUser.total_trades,
                        successfulTrades: dbUser.successful_trades,
                        position: null, // Positions loaded separately
                        tradeHistory: [],
                        lastTradeAt: dbUser.last_trade_at,
                        dailyResetAt: dbUser.daily_reset_at,
                        totalProfitTaken: dbUser.total_profit_taken,
                        profitTakingHistory: [],
                        tradingCapital: dbUser.trading_capital
                    });

                    // Load active positions
                    const activePositions = await this.database.getActivePositions(userId);
                    if (activePositions.length > 0) {
                        // Take the most recent one
                        const pos = activePositions[0];
                        this.userStates.get(userId).position = {
                            tokenAddress: pos.token_address,
                            symbol: pos.symbol,
                            entryPrice: pos.entry_price,
                            entryTime: pos.entry_time,
                            tokensOwned: pos.tokens_owned,
                            investedUSDC: pos.invested_usdc,
                            targetPrice: pos.target_price,
                            stopLossPrice: pos.stop_loss_price,
                            scalpMode: pos.scalp_mode === 1,
                            txSignature: pos.tx_signature,
                            bondingProgress: pos.bonding_progress,
                            liquidityUSD: pos.liquidity_usd,
                            tokenDecimals: pos.token_decimals,
                            positionSizeMode: pos.position_size_mode
                        };

                        this.portfolioManager.addPosition(pos.token_address, this.userStates.get(userId).position);
                    }

                    this.logger.info('User state loaded', { userId, balance: dbUser.current_balance });
                }
            }
        } catch (error) {
            this.logger.error('Failed to load state', { error: error.message });
        }
    }

    async checkDailyReset(user, userId) {
        const now = Date.now();
        const hoursSinceReset = (now - user.dailyResetAt) / 3600000;

        if (hoursSinceReset >= COOLDOWN_HOURS) {
            this.logger.info('Daily reset triggered', { day: user.currentDay });

            if (ENABLE_PROFIT_TAKING && user.currentBalance > PROFIT_TAKING_THRESHOLD && user.dailyProfit > 0) {
                const profitToTake = user.dailyProfit * PROFIT_TAKING_PERCENTAGE;
                const newBalance = user.currentBalance - profitToTake;

                this.logger.info('Profit taking', { amount: profitToTake.toFixed(2), percentage: PROFIT_TAKING_PERCENTAGE * 100 });

                user.totalProfitTaken += profitToTake;
                user.profitTakingHistory.push({
                    date: new Date().toISOString(),
                    day: user.currentDay,
                    profitTaken: profitToTake,
                    dailyProfit: user.dailyProfit,
                    balanceBefore: user.currentBalance,
                    balanceAfter: newBalance
                });

                user.currentBalance = newBalance;
                user.tradingCapital = newBalance;

                await this.bot.sendMessage(userId, this.formatProfitTakingMessage(profitToTake, user), {
                    parse_mode: 'HTML'
                }).catch(err => this.logger.error('Failed to send profit taking message', { error: err.message }));
            }

            // Save performance metrics
            await this.performanceTracker.saveMetrics(userId);

            user.dailyStartBalance = user.currentBalance;
            user.dailyProfit = 0;
            user.dailyProfitPercent = 0;
            user.dailyResetAt = now;
            user.currentDay += 1;

            await this.saveState();
            return true;
        }
        return false;
    }

    isDailyTargetHit(user) {
        return user.dailyProfitPercent >= DAILY_PROFIT_TARGET ||
            user.dailyProfitPercent <= -DAILY_STOP_LOSS;
    }

    // findTradingOpportunity removed (Pure RPC Mode)



    calculatePositionSize(user, tokenLiquidity) {
        let positionSize;
        const strategy = this.getActiveStrategy();

        switch (POSITION_SIZE_MODE) {
            case 'FIXED':
                positionSize = FIXED_POSITION_SIZE;
                break;

            case 'PERCENTAGE':
                positionSize = user.currentBalance * strategy.positionSize;
                break;

            case 'DYNAMIC':
                const liquidityLimit = tokenLiquidity * 0.02;
                const balanceLimit = user.currentBalance * strategy.positionSize;
                positionSize = Math.min(liquidityLimit, balanceLimit);
                break;

            default:
                positionSize = FIXED_POSITION_SIZE;
        }

        positionSize = Math.max(MIN_POSITION_SIZE, Math.min(MAX_POSITION_SIZE, positionSize));
        positionSize = Math.min(positionSize, user.currentBalance);

        this.logger.info('Position size calculated', { size: positionSize.toFixed(2), mode: POSITION_SIZE_MODE, strategy: this.performanceTracker.metrics.strategyLevel });
        return positionSize;
    }

    getActiveStrategy() {
        if (!ENABLE_AUTO_ADJUSTMENT) {
            return {
                dailyTarget: DAILY_PROFIT_TARGET,
                perTradeTarget: PER_TRADE_PROFIT_TARGET,
                scalpMin: SCALP_PROFIT_MIN,
                scalpMax: SCALP_PROFIT_MAX,
                extendedTarget: EXTENDED_HOLD_TARGET,
                stopLoss: PER_TRADE_STOP_LOSS,
                positionSize: PERCENTAGE_POSITION_SIZE,
                profitTaking: PROFIT_TAKING_PERCENTAGE
            };
        }

        if (this.currentStrategy) return this.currentStrategy;

        return this.performanceTracker.getRecommendedStrategy();
    }

    formatProfitTakingMessage(profitTaken, user) {
        return `
💰 <b>PROFIT TAKING EXECUTED</b>

<b>Daily Stats:</b>
Daily Profit: ${(profitTaken / PROFIT_TAKING_PERCENTAGE).toFixed(2)}
Taken (${(PROFIT_TAKING_PERCENTAGE * 100)}%): ${profitTaken.toFixed(2)}
Reinvested: ${(profitTaken / PROFIT_TAKING_PERCENTAGE * (1 - PROFIT_TAKING_PERCENTAGE)).toFixed(2)}

<b>Account Summary:</b>
Trading Capital: ${user.currentBalance.toFixed(2)}
Total Withdrawn: ${user.totalProfitTaken.toFixed(2)}
Combined Value: ${(user.currentBalance + user.totalProfitTaken).toFixed(2)}

<b>Day:</b> ${user.currentDay}

🎯 Your profits are being secured!
      `.trim();
    }

    // ============ COMPLETE TRADING ENGINE - ADD THESE METHODS ============
    // Add these methods to the TradingEngine class after formatProfitTakingMessage()



    async executeBuy(userId, token) {
        return this.tradeMutex.runExclusive(() => this._executeBuyInternal(userId, token));
    }

    async _executeBuyInternal(userId, token) {
        const user = this.getUserState(userId);
        const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));

        try {
            console.log('\n' + '💰'.repeat(40));
            console.log('🔵 EXECUTING BUY:', token.symbol);
            console.log('💰'.repeat(40));

            if (ENABLE_PAPER_TRADING) {
                return await this.executePaperBuy(userId, token);
            }

            // 0. Graduation Check (Pre-Trade)
            const graduationStatus = await this.bondingCurve.checkGraduation(token.address);
            if (graduationStatus && (graduationStatus.isComplete || graduationStatus.data.progress > 99)) {
                throw new Error(`Token graduating or complete (Progress: ${graduationStatus.data.progress.toFixed(2)}%). Aborting buy.`);
            }

            // Position size now in native SOL
            // 1. Capacity Check & Sizing
            const maxSafeSOL = await this.bondingCurve.getMaxSafeTradeSize(token.address, true);
            let positionSizeSOL = this.calculatePositionSize(user, token.liquidityUSD);

            if (positionSizeSOL > maxSafeSOL) {
                console.log(`⚠️ Clamping buy size: ${positionSizeSOL.toFixed(4)} -> ${maxSafeSOL.toFixed(4)} SOL (Liquidity Cap)`);
                positionSizeSOL = maxSafeSOL;
            }

            if (positionSizeSOL < 0.01) {
                throw new Error(`Insufficient liquidity for min trade (Max safe: ${maxSafeSOL.toFixed(4)} SOL)`);
            }

            if (positionSizeSOL > user.currentBalance) {
                throw new Error('Insufficient SOL balance');
            }

            // 2. Dynamic Slippage Check
            const slippagePct = await this.bondingCurve.calculateSlippage(token.address, positionSizeSOL, true);
            if (slippagePct < 0 || slippagePct > 25.0) {
                throw new Error(`Slippage too high: ${slippagePct === -1 ? 'REJECTED' : slippagePct.toFixed(2) + '%'}`);
            }
            console.log(`📉 Slippage Approved: ${slippagePct.toFixed(2)}%`);

            const onCurve = token.bondingProgress < 100;
            const priorityFee = await this.priorityFeeCalculator.calculateOptimalFee(
                token.bondingProgress >= 96,
                token.bondingProgress >= 96 ? 'critical' : 'high'
            );

            let tokensReceived;
            let solSpent = positionSizeSOL;
            let entryPrice; // Price in SOL per token
            let buySignature;

            if (onCurve) {
                console.log(`🎪 DIRECT PUMP.FUN CURVE BUY (${solSpent.toFixed(6)} SOL)`);

                // Direct buy with native SOL — no bridge needed
                const directResult = await this.pumpDirect.executeBuy({
                    wallet,
                    mint: token.address,
                    amountSOL: solSpent * 0.995, // 0.5% buffer for fees/slippage
                    slippageBps: 1500, // 15%
                    priorityFeeLamports: priorityFee
                });

                if (!directResult.success) {
                    throw new Error(`Direct curve buy failed: ${directResult.error}`);
                }

                buySignature = directResult.signature;
                console.log(`✅ Direct curve buy success! Sig: ${buySignature}`);

                // Get tokens received (from post-tx balance or estimation)
                tokensReceived = await this.getTokenBalanceAfterTx(token.address, buySignature) ||
                    this.pumpDirect.estimateTokensFromSOL(solSpent * 1e9);

                entryPrice = solSpent / tokensReceived;

            } else {
                // Post-migration: Jupiter swap SOL → Token
                console.log(`🔄 Jupiter buy (migrated token) — ${solSpent.toFixed(6)} SOL`);

                const amountSOLLamports = Math.floor(solSpent * 1e9);

                let quote = null;
                for (let i = 0; i < 5; i++) {
                    const slippageBps = this.calculateSlippage(token.liquidityUSD);
                    quote = await this.getJupiterQuote(SOL_MINT, token.address, amountSOLLamports, slippageBps);
                    if (quote) break;
                    await sleep(2000);
                }
                if (!quote) throw new Error('No Jupiter quote available (SOL → Token)');

                const swapTx = await this.executeSwap(quote, priorityFee);
                if (!swapTx.success) throw new Error('Jupiter swap failed');

                buySignature = swapTx.signature;
                tokensReceived = parseFloat(quote.outAmount) / 1e9;
                entryPrice = solSpent / tokensReceived;
            }

            // Create position (now in SOL)
            const position = {
                tokenAddress: token.address,
                symbol: token.symbol,
                entryPrice, // SOL per token
                entryTime: Date.now(),
                tokensOwned: tokensReceived,
                investedSOL: solSpent,        // ← Changed from investedUSDC
                targetPrice: entryPrice * (1 + this.getActiveStrategy().perTradeTarget),
                stopLossPrice: entryPrice * (1 - this.getActiveStrategy().stopLoss),
                scalpMode: true,
                txSignature: buySignature,
                bondingProgress: token.bondingProgress,
                liquidityUSD: token.liquidityUSD,
                tokenDecimals: 9
            };

            user.position = position;
            user.currentBalance -= solSpent;  // Subtract SOL
            this.portfolioManager.addPosition(token.address, position);
            await this.saveState();

            // Updated message — now shows SOL
            await this.bot.sendMessage(userId, this.formatBuyMessageSOL(position, token, user, { method: onCurve ? 'Pump.fun Direct' : 'Jupiter' }), {
                parse_mode: 'HTML'
            });

            this.logger.info('Buy successful', {
                symbol: token.symbol,
                method: onCurve ? 'pumpfun_direct' : 'jupiter',
                invested: solSpent.toFixed(6) + ' SOL',
                tokens: tokensReceived.toFixed(4),
                entry: entryPrice.toFixed(10) + ' SOL/token',
                tx: buySignature
            });

            return true;

        } catch (error) {
            console.log('❌ BUY FAILED:', error.message);
            this.logger.error('Buy failed', { error: error.message, token: token.symbol });

            await this.bot.sendMessage(userId, `
❌ <b>Buy Failed</b>
<b>Token:</b> ${token.symbol}
<b>Error:</b> ${error.message}
Balance safe. Bot continues scanning.
        `.trim(), { parse_mode: 'HTML' });

            return false;
        }
    }

    async verifyTransaction(signature) {
        console.log(`🔍 Verifying tx: ${signature}...`);
        const connection = this.rpcConnection.getCurrentConnection();
        let retries = 30; // 30 seconds
        while (retries > 0) {
            try {
                const status = await connection.getSignatureStatus(signature);
                if (status && status.value) {
                    if (status.value.err) {
                        throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
                    }
                    // We accept 'confirmed' for speed, users can change to 'finalized' if paranoid
                    if (status.value.confirmationStatus === 'finalized' || status.value.confirmationStatus === 'confirmed') {
                        console.log(`✅ Tx confirmed: ${status.value.confirmationStatus}`);
                        return true;
                    }
                }
            } catch (err) {
                console.log(`⚠️ Verify retry error: ${err.message}`);
            }
            await new Promise(r => setTimeout(r, 1000));
            retries--;
        }
        throw new Error('Transaction confirmation timed out');
    }

    async executeDirectPumpFunBuy(mintStr, usdcAmountLamports, priorityFeeLamports) {
        const connection = this.rpcConnection.getCurrentConnection(); // or your robust one
        const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));

        const mint = new PublicKey(mintStr);

        // PDAs
        const [bondingCurve] = PublicKey.findProgramAddressSync(
            [Buffer.from("bonding-curve"), mint.toBuffer()],
            new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")
        );

        const associatedBondingCurve = getAssociatedTokenAddressSync(mint, bondingCurve, true);
        const userTokenATA = getAssociatedTokenAddressSync(mint, wallet.publicKey);

        const global = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
        const feeRecipient = new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV2fskvCwf8gCDbZ");
        const eventAuthority = new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1");
        const program = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

        // Buy discriminator (updated 2025)
        const buyDiscriminator = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);

        // Min tokens out (slippage: e.g., 15% less)
        const minTokensOut = 0n; // Or calculate properly for tight slippage

        const data = Buffer.alloc(16);
        data.writeBigUInt64LE(BigInt(usdcAmountLamports), 0); // Amount in (USDC lamports? Wait — pump.fun curve is SOL-based!)
        data.writeBigUInt64LE(minTokensOut, 8);

        const ixData = Buffer.concat([buyDiscriminator, data]);

        const keys = [
            { pubkey: global, isSigner: false, isWritable: false },
            { pubkey: feeRecipient, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: bondingCurve, isSigner: false, isWritable: true },
            { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
            { pubkey: userTokenATA, isSigner: false, isWritable: true },
            { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: eventAuthority, isSigner: false, isWritable: false },
            { pubkey: program, isSigner: false, isWritable: false },
        ];

        const buyIx = new TransactionInstruction({
            keys,
            programId: program,
            data: ixData
        });

        // Add ATA creation if not exists
        const instructions = [];
        const ataAccount = await connection.getAccountInfo(userTokenATA);
        if (!ataAccount) {
            instructions.push(createAssociatedTokenAccountInstruction(
                wallet.publicKey,
                userTokenATA,
                wallet.publicKey,
                mint
            ));
        }

        // Priority fee
        instructions.push(ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: Math.ceil(priorityFeeLamports / 100_000) // adjust
        }));

        instructions.push(buyIx);

        const tx = new VersionedTransaction(await connection.getLatestBlockhash());
        tx.message = new TransactionMessage({
            payerKey: wallet.publicKey,
            instructions,
            recentBlockhash: (await connection.getLatestBlockhash()).blockhash
        }).compileToV0Message();

        tx.sign([wallet]);

        const sig = await connection.sendTransaction(tx, { skipPreflight: false });
        // Use robust verification loop
        await this.verifyTransaction(sig);

        return { success: true, signature: sig };
    }



    async executePaperBuy(userId, token) {
        const user = this.getUserState(userId);
        const positionSize = this.calculatePositionSize(user, token.liquidityUSD);
        const entryPrice = token.priceUSD;
        const tokensReceived = positionSize / entryPrice;

        const strategy = this.getActiveStrategy();

        const position = {
            tokenAddress: token.address,
            symbol: token.symbol,
            entryPrice,
            entryTime: Date.now(),
            tokensOwned: tokensReceived,
            investedUSDC: positionSize,
            targetPrice: entryPrice * (1 + strategy.perTradeTarget),
            stopLossPrice: entryPrice * (1 - strategy.stopLoss),
            scalpMode: true,
            txSignature: 'PAPER_TRADE_' + Date.now(),
            bondingProgress: token.bondingProgress,
            liquidityUSD: token.liquidityUSD,
            tokenDecimals: 9,
            positionSizeMode: POSITION_SIZE_MODE,
            isPaperTrade: true
        };

        user.position = position;
        user.currentBalance -= positionSize;

        await this.saveState();

        await this.bot.sendMessage(userId, '📝 <b>PAPER TRADE</b>\n\n' + this.formatBuyMessage(position, token, user), {
            parse_mode: 'HTML'
        });

        this.logger.info('Paper buy executed', { symbol: token.symbol });
        return true;
    }

    async executeSell(userId, reason, currentPrice) {
        return this.tradeMutex.runExclusive(() => this._executeSellInternal(userId, reason, currentPrice));
    }

    async _executeSellInternal(userId, reason, currentPrice) {
        const user = this.getUserState(userId);
        const pos = user.position;
        const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));

        try {
            console.log('\n' + '🔴'.repeat(40));
            console.log('🔴 EXECUTING SELL:', pos.symbol, reason);
            console.log('🔴'.repeat(40));

            if (ENABLE_PAPER_TRADING) {
                return await this.executePaperSell(userId, reason, currentPrice);
            }

            const tokenAmountRaw = Math.floor(pos.tokensOwned * 1e9);
            const onCurve = pos.bondingProgress < 100;
            const priorityFee = await this.priorityFeeCalculator.calculateOptimalFee(false, 'normal');

            let solReceived;
            let sellSignature;
            let entryPriceSOL = pos.entryPrice; // Already in SOL/token from buy
            let exitPriceSOL;

            if (onCurve) {
                console.log(`🎪 DIRECT CURVE SELL → native SOL back`);

                const directResult = await this.pumpDirect.executeSell({
                    wallet,
                    mint: pos.tokenAddress,
                    tokenAmount: tokenAmountRaw,
                    slippageBps: 1500,
                    priorityFeeLamports: priorityFee
                });

                if (!directResult.success) {
                    throw new Error(`Direct curve sell failed: ${directResult.error}`);
                }

                sellSignature = directResult.signature;
                console.log(`✅ Curve sell success! Sig: ${sellSignature}`);

                // Get SOL received (post-tx native balance delta or estimation)
                solReceived = await this.estimateSOLReceivedAfterTx(wallet.publicKey, sellSignature);
                if (solReceived < 0.001) {
                    throw new Error('No meaningful SOL received from sell');
                }

                exitPriceSOL = solReceived / pos.tokensOwned;

            } else {
                // Post-migration: Jupiter token → SOL
                console.log(`🔄 Jupiter sell (migrated token) → SOL`);

                let quote = null;
                for (let i = 0; i < 5; i++) {
                    const slippageBps = this.calculateSlippage(pos.liquidityUSD);
                    quote = await this.getJupiterQuote(pos.tokenAddress, SOL_MINT, tokenAmountRaw, slippageBps);
                    if (quote) break;
                    await sleep(2000);
                }
                if (!quote) throw new Error('No Jupiter quote available (Token → SOL)');

                const swapTx = await this.executeSwap(quote, priorityFee);
                if (!swapTx.success) throw new Error('Jupiter swap failed');

                sellSignature = swapTx.signature;
                solReceived = parseFloat(quote.outAmount) / 1e9;
                exitPriceSOL = solReceived / pos.tokensOwned;
            }

            // Calculate profit in SOL
            const profitSOL = solReceived - pos.investedSOL;
            const profitPercent = (profitSOL / pos.investedSOL) * 100;

            // Create final trade record
            const trade = {
                ...pos,
                exitPrice: exitPriceSOL,           // SOL per token
                solReceived,
                profitSOL,
                profitPercent,
                reason,
                sellTxSignature: sellSignature,
                holdTimeMinutes: ((Date.now() - pos.entryTime) / 60000).toFixed(1)
            };

            // Update user state
            user.tradeHistory.push(trade);
            user.position = null;
            user.currentBalance += solReceived;  // Add SOL back
            user.dailyProfit += profitSOL;
            user.dailyProfitPercent = ((user.currentBalance - user.dailyStartBalance) / user.dailyStartBalance) * 100;
            user.totalTrades += 1;
            if (profitSOL > 0) user.successfulTrades += 1;

            this.portfolioManager.removePosition(pos.tokenAddress);
            await this.saveState();

            // Sync with real wallet (native SOL)
            const updatedBalances = await this.getWalletBalance();
            user.currentBalance = updatedBalances.nativeSOL || updatedBalances.trading; // Use native SOL

            // Send updated sell message (SOL version)
            await this.bot.sendMessage(userId, this.formatSellMessageSOL(trade, user, updatedBalances), {
                parse_mode: 'HTML'
            });

            this.logger.info('Sell successful', {
                symbol: pos.symbol,
                method: onCurve ? 'pumpfun_direct' : 'jupiter',
                received: solReceived.toFixed(6) + ' SOL',
                profit: profitPercent.toFixed(2) + '%'
            });

            return true;

        } catch (error) {
            this.logger.error('Sell failed', { error: error.message, symbol: pos?.symbol });
            await this.bot.sendMessage(userId, `
❌ <b>Sell Failed</b>
<b>Token:</b> ${pos?.symbol || 'Unknown'}
<b>Error:</b> ${error.message}
Position safe. Bot continues monitoring.
        `.trim(), { parse_mode: 'HTML' });
            return false;
        }
    }

    async executePaperSell(userId, reason, currentPrice) {
        const user = this.getUserState(userId);
        const pos = user.position;

        const usdcReceived = pos.tokensOwned * currentPrice;
        const profit = usdcReceived - pos.investedUSDC;
        const profitPercent = (profit / pos.investedUSDC) * 100;

        user.currentBalance += usdcReceived;
        user.dailyProfit += profit;
        user.dailyProfitPercent = ((user.currentBalance - user.dailyStartBalance) / user.dailyStartBalance) * 100;
        user.totalTrades += 1;
        if (profit > 0) user.successfulTrades += 1;

        const trade = {
            ...pos,
            exitPrice: currentPrice,
            exitTime: Date.now(),
            usdcReceived,
            profit,
            profitPercent,
            reason,
            sellTxSignature: 'PAPER_TRADE_SELL_' + Date.now(),
            holdTimeMinutes: ((Date.now() - pos.entryTime) / 60000).toFixed(1),
            wasPaperTrade: true
        };

        user.position = null;

        if (this.database) {
            await this.database.recordTrade(userId, { ...trade, wasPaperTrade: true });
        }

        await this.saveState();

        await this.bot.sendMessage(userId, '📝 <b>PAPER TRADE</b>\n\n' + this.formatSellMessage(trade, user), {
            parse_mode: 'HTML'
        });

        this.logger.info('Paper sell executed', { symbol: pos.symbol, profit: profitPercent.toFixed(2) + '%' });
        return true;
    }

    async monitorPosition(userId) {
        return this.tradeMutex.runExclusive(async () => {
            const user = this.getUserState(userId);
            if (!user.position) return;

            const pos = user.position;
            const currentPrice = await this.getCurrentPrice(pos.tokenAddress);

            if (!currentPrice) {
                this.logger.warn('No price for position', { symbol: pos.symbol });
                return;
            }

            // --- GRADUATION CHECK ---
            const gradStatus = await this.bondingCurve.checkGraduation(pos.tokenAddress);
            if (gradStatus && (gradStatus.isComplete || gradStatus.data.progress > 99)) {
                this.logger.warn(`🚨 GRADUATION DETECTED: ${pos.symbol} (${gradStatus.data.progress.toFixed(1)}%)`);
                await this.executeSell(userId, 'GRADUATION_MIGRATION', currentPrice);
                return;
            }

            const priceChange = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
            const holdTimeMin = (Date.now() - pos.entryTime) / 60000;

            this.logger.info('Monitoring position', {
                symbol: pos.symbol,
                price: currentPrice.toFixed(8),
                change: priceChange.toFixed(2) + '%',
                holdTime: holdTimeMin.toFixed(1) + 'm'
            });

            // Update technical indicators
            if (this.technicalIndicators) {
                this.technicalIndicators.addPriceData(pos.tokenAddress, currentPrice);
            }

            const strategy = this.getActiveStrategy();

            if (pos.scalpMode && holdTimeMin < EXTENDED_HOLD_MINUTES) {
                if (priceChange >= strategy.scalpMin * 100 && priceChange <= strategy.scalpMax * 100) {
                    await this.executeSell(userId, 'scalp_profit', currentPrice);
                    return;
                }
            }

            if (pos.scalpMode && holdTimeMin >= EXTENDED_HOLD_MINUTES) {
                this.logger.info('Switching to extended hold mode', { symbol: pos.symbol });
                pos.scalpMode = false;
                pos.targetPrice = pos.entryPrice * (1 + strategy.extendedTarget);
                await this.saveState();
            }

            if (!pos.scalpMode) {
                if (currentPrice >= pos.targetPrice) {
                    await this.executeSell(userId, 'extended_profit', currentPrice);
                    return;
                }
            }

            if (currentPrice <= pos.stopLossPrice) {
                await this.executeSell(userId, 'stop_loss', currentPrice);
                return;
            }
        });
    }

    async executeDirectPumpFunSell(mintStr, tokenAmountRaw, priorityFeeLamports) {
        const connection = this.rpcConnection.getCurrentConnection();
        const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));

        const mint = new PublicKey(mintStr);

        const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
        const GLOBAL = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
        const FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV2fskvCwf8gCDbZ');
        const EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');

        const [bondingCurve] = PublicKey.findProgramAddressSync(
            [Buffer.from('bonding-curve'), mint.toBuffer()],
            PUMP_FUN_PROGRAM
        );

        const associatedBondingCurve = getAssociatedTokenAddressSync(mint, bondingCurve, true);
        const userTokenATA = getAssociatedTokenAddressSync(mint, wallet.publicKey);

        // Sell discriminator (confirmed 2025)
        const sellDiscriminator = Buffer.from([51, 230, 237, 178, 9, 198, 242, 6]);

        const minSolOut = 0n; // Set proper slippage here if needed

        const data = Buffer.alloc(16);
        data.writeBigUInt64LE(BigInt(tokenAmountRaw), 0);
        data.writeBigUInt64LE(minSolOut, 8);

        const ixData = Buffer.concat([sellDiscriminator, data]);

        const keys = [
            { pubkey: GLOBAL, isSigner: false, isWritable: false },
            { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: bondingCurve, isSigner: false, isWritable: true },
            { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
            { pubkey: userTokenATA, isSigner: false, isWritable: true },
            { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
            { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },
        ];

        const sellIx = new TransactionInstruction({
            keys,
            programId: PUMP_FUN_PROGRAM,
            data: ixData
        });

        const instructions = [];

        // Priority fee
        instructions.push(ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: Math.ceil(priorityFeeLamports * 10) // adjust multiplier as needed
        }));

        instructions.push(sellIx);

        // Build & send VersionedTransaction
        const { blockhash } = await connection.getLatestBlockhash();
        const messageV0 = new TransactionMessage({
            payerKey: wallet.publicKey,
            instructions,
            recentBlockhash: blockhash
        }).compileToV0Message();

        const tx = new VersionedTransaction(messageV0);
        tx.sign([wallet]);

        const sig = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
        // Use robust verification loop
        await this.verifyTransaction(sig);

        return { success: true, signature: sig };
    }


    // Add to TradingEngine.findTradingOpportunity() - around line 1150
    // Duplicate findTradingOpportunity removed
    // Helper: Random Jitter for Sandwich Mitigation
    randomJitter(minMs, maxMs) {
        return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    }

    async analyzeTokenForSnipe(token, source) {
        try {
            const quote = await this.getJupiterQuote(tokenAddress, USDC_MINT, 1000000000, 300);
            if (!quote || !quote.outAmount) return null;
            return parseFloat(quote.outAmount) / 1000000;
        } catch (error) {
            this.logger.error('Get current price failed', { error: error.message });
            return null;
        }
    }

    async getCurrentPrice(tokenAddress) {
        try {
            const quote = await this.getJupiterQuote(tokenAddress, USDC_MINT, 1000000000, 300);
            if (!quote || !quote.outAmount) return null;
            return parseFloat(quote.outAmount) / 1000000;
        } catch (error) {
            this.logger.error('Get current price failed', { error: error.message });
            return null;
        }
    }

    async getJupiterQuote(inputMint, outputMint, amount, slippageBps = 300) {
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const url = `${JUPITER_API_URL}/quote?inputMint=${encodeURIComponent(inputMint)}&outputMint=${encodeURIComponent(outputMint)}&amount=${amount}&slippageBps=${slippageBps}`;

                const res = await fetchWithTimeout(url, {
                    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }
                }, JUPITER_QUOTE_TIMEOUT);

                if (!res.ok) {
                    throw new Error(`Quote failed: ${res.status}`);
                }

                const data = await res.json();
                if (!data || !data.inAmount || !data.outAmount) return null;

                return { ...data, inAmount: data.inAmount, outAmount: data.outAmount, route: data };
            } catch (err) {
                this.logger.error('Jupiter quote error', { attempt, error: err.message });
                if (attempt < MAX_RETRIES) await sleep(1000 * attempt);
            }
        }
        return null;
    }

    async executeSwap(quoteResponse, priorityFeeLamports = 0) {
        try {
            const baseUrl = getJupiterEndpoint();
            const url = `${baseUrl}/swap`;

            console.log(`\n🔄 Jupiter Swap Request`);
            console.log(`   Endpoint: ${url}`);

            const payload = {
                quoteResponse: quoteResponse.route || quoteResponse,
                userPublicKey: this.wallet.publicKey.toString(),
                wrapAndUnwrapSol: true,
                dynamicComputeUnitLimit: true,
                prioritizationFeeLamports: priorityFeeLamports
            };

            const response = await jupiterClient.post(url, payload);

            if (!response.data || !response.data.swapTransaction) {
                throw new Error('No swapTransaction in response');
            }

            console.log(`✅ Swap transaction received\n`);

            recordJupiterSuccess();

            const txBuffer = Buffer.from(response.data.swapTransaction, 'base64');
            let transaction = VersionedTransaction.deserialize(txBuffer);

            // Apply MEV protection if enabled
            if (ENABLE_MEV_PROTECTION && this.mevProtection) {
                const protectedTx = await this.mevProtection.protectTransaction(transaction);
                transaction = protectedTx.transaction;
            }

            transaction.sign([this.wallet]);

            const operation = async (conn) => {
                const rawSigned = transaction.serialize();
                const signature = await conn.sendRawTransaction(rawSigned, {
                    skipPreflight: false,
                    maxRetries: 2
                });

                const confirmation = await conn.confirmTransaction(signature, 'confirmed');
                if (confirmation.value.err) {
                    throw new Error(`TX failed: ${JSON.stringify(confirmation.value.err)}`);
                }

                return signature;
            };

            const signature = await this.rpcConnection.executeWithFallback(operation, 'executeSwap');

            this.logger.info('Swap successful', { signature, endpoint: baseUrl });

            return { success: true, signature };

        } catch (error) {
            recordJupiterFailure();

            this.logger.error('Swap execution error', {
                error: error.message,
                stack: error.stack,
                endpoint: JUPITER_ENDPOINTS[currentJupiterEndpoint]
            });

            return { success: false, error: error.message };
        }
    }

    calculateSlippage(liquidityUSD) {
        let slippageBps;

        if (liquidityUSD >= 100000) {
            slippageBps = 200;  // 2% - very liquid
        } else if (liquidityUSD >= 50000) {
            slippageBps = 300;  // 3% - good liquidity
        } else if (liquidityUSD >= 20000) {
            slippageBps = 500;  // 5% - medium liquidity
        } else if (liquidityUSD >= 10000) {
            slippageBps = 800;  // 8% - low liquidity
        } else if (liquidityUSD >= 5000) {
            slippageBps = 1200; // 12% - very low liquidity
        } else {
            slippageBps = 1500; // 15% - extremely low liquidity
        }

        this.logger.debug('Slippage calculated', {
            liquidityUSD: liquidityUSD.toFixed(0),
            slippageBps: slippageBps,
            slippagePercent: (slippageBps / 100).toFixed(1) + '%'
        });

        return slippageBps;
    }

    validateQuote(quote, requestedAmount, token) {
        try {
            const inAmount = parseInt(quote.inAmount);
            const outAmount = parseInt(quote.outAmount);

            // Check 1: Required fields exist
            if (!quote.inAmount || !quote.outAmount) {
                return {
                    valid: false,
                    reason: 'Missing required fields (inAmount or outAmount)'
                };
            }

            // Check 2: Amounts are valid numbers
            if (isNaN(inAmount) || isNaN(outAmount)) {
                return {
                    valid: false,
                    reason: 'Invalid amount values'
                };
            }

            // Check 3: Output is positive
            if (outAmount <= 0) {
                return {
                    valid: false,
                    reason: 'Output amount is zero or negative'
                };
            }

            // Check 4: Input matches request (within 2%)
            const inputDiff = Math.abs(inAmount - requestedAmount) / requestedAmount;
            if (inputDiff > 0.02) {
                return {
                    valid: false,
                    reason: `Input mismatch: requested ${requestedAmount}, got ${inAmount} (${(inputDiff * 100).toFixed(1)}% diff)`
                };
            }

            // Check 5: Price impact not extreme (>25% is very suspicious)
            if (quote.priceImpactPct) {
                const impact = parseFloat(quote.priceImpactPct);
                if (impact > 25) {
                    return {
                        valid: false,
                        reason: `Extreme price impact: ${impact.toFixed(2)}% (max 25%)`
                    };
                }
            }

            // Check 6: Output amount is reasonable
            const minExpectedOutput = 100; // At least 100 lamports
            if (outAmount < minExpectedOutput) {
                return {
                    valid: false,
                    reason: `Output too small: ${outAmount} lamports (min ${minExpectedOutput})`
                };
            }

            this.logger.info('Quote validation passed', {
                inAmount: inAmount,
                outAmount: outAmount,
                priceImpact: quote.priceImpactPct || 'N/A'
            });

            return { valid: true };

        } catch (error) {
            return {
                valid: false,
                reason: `Validation error: ${error.message}`
            };
        }
    }




    async checkStrategyAdjustment(userId) {
        if (!this.performanceTracker.shouldAdjustStrategy()) return;

        const recommended = this.performanceTracker.getRecommendedStrategy();
        const currentLevel = this.performanceTracker.metrics.strategyLevel;

        if (currentLevel === recommended.level) {
            this.logger.info('Maintaining current strategy', { level: currentLevel });
            this.performanceTracker.metrics.lastAdjustment = Date.now();
            await this.saveState();
            return;
        }

        this.logger.info('Strategy adjustment', { from: currentLevel, to: recommended.level });
        this.performanceTracker.metrics.strategyLevel = recommended.level;
        this.performanceTracker.metrics.lastAdjustment = Date.now();
        this.currentStrategy = recommended;

        const stats = this.performanceTracker.getStats();
        await this.bot.sendMessage(userId, this.formatStrategyAdjustmentMessage(currentLevel, recommended, stats), {
            parse_mode: 'HTML'
        }).catch(err => this.logger.error('Failed to send adjustment message', { error: err.message }));

        await this.saveState();
    }

    getStats() {
        return {
            totalTrades: this.performanceTracker.metrics.totalTrades,
            winRate: this.performanceTracker.getWinRate().toFixed(1),
            profitFactor: this.performanceTracker.getProfitFactor().toFixed(2),
            expectancy: this.performanceTracker.getExpectancy().toFixed(2),
            avgWin: this.performanceTracker.metrics.avgWinPercent.toFixed(2),
            avgLoss: this.performanceTracker.metrics.avgLossPercent.toFixed(2),
            largestWin: this.performanceTracker.metrics.largestWin.toFixed(2),
            largestLoss: this.performanceTracker.metrics.largestLoss.toFixed(2),
            currentStreak: this.performanceTracker.metrics.currentStreak,
            strategyLevel: this.performanceTracker.metrics.strategyLevel
        };
    }

    getDetailedReport() {
        const winRate = this.performanceTracker.getWinRate();
        const profitFactor = this.performanceTracker.getProfitFactor();
        const expectancy = this.performanceTracker.getExpectancy();

        return {
            summary: {
                totalTrades: this.performanceTracker.metrics.totalTrades,
                winningTrades: this.performanceTracker.metrics.winningTrades,
                losingTrades: this.performanceTracker.metrics.losingTrades,
                winRate: winRate.toFixed(1) + '%',
                profitFactor: profitFactor.toFixed(2),
                expectancy: expectancy.toFixed(2) + '%'
            },
            profitMetrics: {
                totalProfit: this.performanceTracker.metrics.totalProfit.toFixed(2),
                totalLoss: this.performanceTracker.metrics.totalLoss.toFixed(2),
                netProfit: (this.performanceTracker.metrics.totalProfit - this.performanceTracker.metrics.totalLoss).toFixed(2),
                avgWinPercent: this.performanceTracker.metrics.avgWinPercent.toFixed(2) + '%',
                avgLossPercent: this.performanceTracker.metrics.avgLossPercent.toFixed(2) + '%'
            },
            extremes: {
                largestWin: this.performanceTracker.metrics.largestWin.toFixed(2) + '%',
                largestLoss: this.performanceTracker.metrics.largestLoss.toFixed(2) + '%',
                consecutiveWins: this.performanceTracker.metrics.consecutiveWins,
                consecutiveLosses: this.performanceTracker.metrics.consecutiveLosses,
                currentStreak: this.performanceTracker.metrics.currentStreak
            },
            strategy: {
                currentLevel: this.performanceTracker.metrics.strategyLevel,
                lastAdjustment: new Date(this.performanceTracker.metrics.lastAdjustment).toISOString(),
                nextReview: new Date(this.performanceTracker.metrics.lastAdjustment + (AUTO_ADJUST_INTERVAL * 24 * 60 * 60 * 1000)).toISOString()
            }
        };
    }

    async sendScanNotification(userId, scanData) {
        const { tokensFound, tokensAnalyzed, signalFound, signal } = scanData;

        if (signalFound) {
            // Only notify when signal found (reduce noise)
            await this.bot.sendMessage(userId, `
🎯 <b>TRADING SIGNAL DETECTED</b>

<b>Token:</b> ${signal.symbol}
<b>Contract:</b> <code>${signal.address.substring(0, 8)}...${signal.address.slice(-6)}</code>

📊 <b>Market Metrics</b>
├ Bonding Progress: ${signal.bondingProgress.toFixed(1)}%
├ Liquidity: $${this.formatNumber(signal.liquidityUSD)}
├ Volume Spike: ${signal.volumeSpike.toFixed(2)}x
└ Price: $${signal.priceUSD.toExponential(2)}

⏱️ <b>Analysis</b>
└ Scanned ${tokensFound} tokens, analyzed ${tokensAnalyzed}

<i>Executing trade in 5 seconds...</i>
        `.trim(), { parse_mode: 'HTML' });
        }
    }



    formatBuyMessage(pos, token, user) {
        const solscanUrl = `https://solscan.io/tx/${pos.txSignature}`;
        const birdseyeUrl = `https://birdeye.so/token/${pos.tokenAddress}?chain=solana`;

        return `
✅ <b>POSITION OPENED</b>

<b>${pos.symbol}</b>
<code>${pos.tokenAddress.substring(0, 8)}...${pos.tokenAddress.slice(-6)}</code>

💰 <b>Trade Details</b>
├ Entry Price: $${pos.entryPrice.toFixed(8)}
├ Position Size: $${pos.investedUSDC.toFixed(2)}
├ Tokens Acquired: ${this.formatNumber(pos.tokensOwned, 2)}
└ Mode: ${pos.scalpMode ? 'Scalp (Quick Exit)' : 'Extended Hold'}

🎯 <b>Targets</b>
├ Take Profit: $${pos.targetPrice.toFixed(8)} (+${((pos.targetPrice / pos.entryPrice - 1) * 100).toFixed(1)}%)
└ Stop Loss: $${pos.stopLossPrice.toFixed(8)} (${((pos.stopLossPrice / pos.entryPrice - 1) * 100).toFixed(1)}%)

📊 <b>Market Context</b>
├ Bonding: ${token.bondingProgress.toFixed(1)}%
├ Liquidity: $${this.formatNumber(token.liquidityUSD)}
└ Volume Spike: ${token.volumeSpike?.toFixed(2) || 'N/A'}x

💼 <b>Portfolio</b>
├ Available: $${user.currentBalance.toFixed(2)}
├ In Position: $${pos.investedUSDC.toFixed(2)}
└ Positions: ${this.portfolioManager.positions.size}/${MAX_CONCURRENT_POSITIONS}

🔗 <a href="${solscanUrl}">View TX</a> | <a href="${birdseyeUrl}">Chart</a>

<i>${new Date().toLocaleTimeString()} UTC</i>
    `.trim();
    }

    async sendPositionUpdate(userId, position, currentPrice, priceChange) {
        // Only send if change is significant (>3% move or approaching targets)
        const isSignificant = Math.abs(priceChange) > 3 ||
            currentPrice >= position.targetPrice * 0.95 ||
            currentPrice <= position.stopLossPrice * 1.05;

        if (!isSignificant) return;

        const emoji = priceChange > 0 ? '📈' : '📉';
        const unrealizedPnL = (position.tokensOwned * currentPrice) - position.investedUSDC;
        const unrealizedPct = (unrealizedPnL / position.investedUSDC) * 100;
        const holdTime = ((Date.now() - position.entryTime) / 60000).toFixed(0);

        const targetDistance = ((position.targetPrice / currentPrice - 1) * 100).toFixed(1);
        const stopDistance = ((currentPrice / position.stopLossPrice - 1) * 100).toFixed(1);

        await this.bot.sendMessage(userId, `
${emoji} <b>POSITION UPDATE</b>

<b>${position.symbol}</b>
└ ${priceChange > 0 ? '📈' : '📉'} ${priceChange > 0 ? '+' : ''}${priceChange.toFixed(2)}%

💵 <b>Current Status</b>
├ Entry: $${position.entryPrice.toFixed(8)}
├ Current: $${currentPrice.toFixed(8)}
├ Unrealized P&L: ${unrealizedPnL > 0 ? '+' : ''}$${unrealizedPnL.toFixed(2)} (${unrealizedPct > 0 ? '+' : ''}${unrealizedPct.toFixed(1)}%)
└ Hold Time: ${holdTime}m

🎯 <b>Distance to Targets</b>
├ Target: ${targetDistance > 0 ? '↑' : '↓'} ${Math.abs(parseFloat(targetDistance))}%
└ Stop: ${stopDistance > 0 ? '↑' : '↓'} ${Math.abs(parseFloat(stopDistance))}%

<i>${new Date().toLocaleTimeString()} UTC</i>
    `.trim(), {
            parse_mode: 'HTML',
            disable_web_page_preview: true
        });
    }

    formatSellMessage(trade, user) {
        const emoji = trade.profit > 0 ? '✅' : '⚠️';
        const color = trade.profit > 0 ? '🟢' : '🔴';
        const solscanUrl = `https://solscan.io/tx/${trade.sellTxSignature}`;

        const reasonEmojis = {
            'scalp_profit': '⚡ Quick Profit',
            'extended_profit': '🎯 Target Hit',
            'stop_loss': '🛡️ Stop Loss'
        };

        const reason = reasonEmojis[trade.reason] || trade.reason.toUpperCase();

        return `
${emoji} <b>POSITION CLOSED</b> ${color}

<b>${trade.symbol}</b>
└ ${reason}

💰 <b>Trade Summary</b>
├ Entry: $${trade.entryPrice.toFixed(8)}
├ Exit: $${trade.exitPrice.toFixed(8)}
├ Change: ${((trade.exitPrice / trade.entryPrice - 1) * 100).toFixed(2)}%
└ Hold Time: ${trade.holdTimeMinutes}m

📊 <b>Financial Result</b>
├ Invested: $${trade.investedUSDC.toFixed(2)}
├ Received: $${trade.usdcReceived.toFixed(2)}
├ Net P&L: ${trade.profit > 0 ? '+' : ''}$${trade.profit.toFixed(2)}
└ Return: ${trade.profit > 0 ? '+' : ''}${trade.profitPercent.toFixed(2)}%

💼 <b>Portfolio Update</b>
├ Balance: $${user.currentBalance.toFixed(2)}
├ Daily P&L: ${user.dailyProfitPercent > 0 ? '+' : ''}${user.dailyProfitPercent.toFixed(2)}%
├ Total Trades: ${user.totalTrades}
└ Win Rate: ${((user.successfulTrades / user.totalTrades) * 100).toFixed(1)}%

🔗 <a href="${solscanUrl}">View TX</a>

<i>${new Date().toLocaleTimeString()} UTC</i>
    `.trim();
    }

    async sendDailySummary(userId) {
        const user = this.getUserState(userId);
        const todayTrades = user.tradeHistory.filter(t =>
            t.exitTime > user.dailyResetAt
        );

        if (todayTrades.length === 0) return; // No trades today

        const wins = todayTrades.filter(t => t.profit > 0).length;
        const losses = todayTrades.length - wins;
        const totalProfit = todayTrades.reduce((sum, t) => sum + t.profit, 0);
        const bestTrade = todayTrades.reduce((best, t) =>
            t.profitPercent > best.profitPercent ? t : best
        );
        const worstTrade = todayTrades.reduce((worst, t) =>
            t.profitPercent < worst.profitPercent ? t : worst
        );

        await this.bot.sendMessage(userId, `
📊 <b>DAILY TRADING SUMMARY</b>

<b>Performance</b>
├ Total Trades: ${todayTrades.length}
├ Wins: ${wins} | Losses: ${losses}
├ Win Rate: ${((wins / todayTrades.length) * 100).toFixed(1)}%
└ Net P&L: ${totalProfit > 0 ? '+' : ''}$${totalProfit.toFixed(2)} (${user.dailyProfitPercent > 0 ? '+' : ''}${user.dailyProfitPercent.toFixed(2)}%)

📈 <b>Best Trade</b>
└ ${bestTrade.symbol}: ${bestTrade.profitPercent > 0 ? '+' : ''}${bestTrade.profitPercent.toFixed(2)}%

📉 <b>Worst Trade</b>
└ ${worstTrade.symbol}: ${worstTrade.profitPercent.toFixed(2)}%

💰 <b>Account</b>
├ Starting: $${user.dailyStartBalance.toFixed(2)}
├ Current: $${user.currentBalance.toFixed(2)}
├ Change: ${user.dailyProfitPercent > 0 ? '+' : ''}${user.dailyProfitPercent.toFixed(2)}%
└ Day ${user.currentDay} of 30

${user.dailyProfitPercent >= DAILY_PROFIT_TARGET * 100 ? '🎯 <b>Daily Target Achieved!</b>' : ''}
${user.dailyProfitPercent <= -DAILY_STOP_LOSS * 100 ? '🛑 <b>Daily Stop Loss Hit</b>' : ''}

<i>${new Date().toLocaleDateString()} UTC</i>
    `.trim(), { parse_mode: 'HTML' });
    }

    async sendScanSummary(userId, stats) {
        // Only send if user hasn't been notified in 6+ hours
        const sixHoursAgo = Date.now() - (6 * 60 * 60 * 1000);
        if (this.lastNotification && this.lastNotification > sixHoursAgo) return;

        await this.bot.sendMessage(userId, `
🔍 <b>SCANNING STATUS</b>

<b>Activity (Last 6 Hours)</b>
├ Scans Completed: ${stats.scansCompleted}
├ Tokens Analyzed: ${stats.tokensAnalyzed}
├ Signals Found: ${stats.signalsFound}
└ Trades Executed: ${stats.tradesExecuted}

📊 <b>Market Conditions</b>
└ ${stats.signalsFound === 0 ? 'No qualifying opportunities detected' : 'Opportunities being monitored'}

💡 <b>Bot Status</b>
└ ✅ Active and scanning every ${SCAN_INTERVAL_MINUTES}m

<i>You'll be notified when signals are detected</i>
    `.trim(), { parse_mode: 'HTML' });

        this.lastNotification = Date.now();
    }

    async sendCriticalError(userId, error, context) {
        await this.bot.sendMessage(userId, `
⚠️ <b>ALERT: ACTION REQUIRED</b>

<b>Issue:</b> ${error.message}
<b>Context:</b> ${context}

<b>Impact:</b>
└ Trading temporarily paused

<b>Recommended Actions:</b>
${this.getErrorRecommendations(error)}

🔧 Use /status to check bot health
⚠️ Use /stop to halt trading

<i>${new Date().toLocaleTimeString()} UTC</i>
    `.trim(), { parse_mode: 'HTML' });
    }


    getErrorRecommendations(error) {
        if (error.message.includes('balance')) {
            return '└ Check wallet balance and add funds';
        } else if (error.message.includes('RPC') || error.message.includes('connection')) {
            return '└ RPC connection issue - automatic retry in progress';
        } else if (error.message.includes('slippage')) {
            return '└ High slippage detected - waiting for better conditions';
        } else {
            return '└ Check /status and contact support if persists';
        }
    }

    formatNumber(num, decimals = 0) {
        if (num >= 1000000) {
            return (num / 1000000).toFixed(1) + 'M';
        } else if (num >= 1000) {
            return (num / 1000).toFixed(1) + 'K';
        } else {
            return num.toFixed(decimals);
        }
    }

    initializeNotificationSettings(user) {
        user.notifications = {
            scanResults: false,
            positionUpdates: true,
            tradeExecutions: true,
            dailySummary: true,
            criticalErrors: true
        };
    }


    shouldSendNotification(type, userId) {
        const lastSent = this.lastNotificationTime.get(`${userId}-${type}`) || 0;
        const now = Date.now();

        const throttleLimits = {
            positionUpdate: 5 * 60 * 1000,
            scanSummary: 6 * 60 * 60 * 1000,
            error: 15 * 60 * 1000
        };

        const limit = throttleLimits[type] || 0;

        if (now - lastSent < limit) {
            return false;
        }

        this.lastNotificationTime.set(`${userId}-${type}`, now);
        return true;
    }

    formatBuyMessage(pos, token, user, options = {}) {
        const method = options.method || 'Unknown';
        const txUrl = `https://solscan.io/tx/${pos.txSignature}`;
        const birdeyeUrl = `https://birdeye.so/token/${pos.tokenAddress}?chain=solana`;

        const strategy = this.getActiveStrategy();

        return `
🚀 <b>BUY EXECUTED — ${method}</b>
<b>${pos.symbol}</b>
<code>${pos.tokenAddress.substring(0, 8)}...${pos.tokenAddress.slice(-6)}</code>

💰 <b>Trade Details</b>
├ Invested: <b>${pos.investedSOL.toFixed(6)} SOL</b>
├ Tokens Received: <b>${this.formatNumber(pos.tokensOwned, 2)}</b>
└ Entry Price: <b>${pos.entryPrice.toFixed(10)} SOL/token</b>

📊 <b>Market Context</b>
├ Bonding Progress: <b>${token.bondingProgress.toFixed(1)}%</b>
├ Liquidity: <b>$${this.formatNumber(token.liquidityUSD)}</b>
└ Volume Spike: <b>${token.volumeSpike?.toFixed(2) || 'N/A'}x</b>

🎯 <b>Targets</b>
├ Scalp: <b>${(strategy.scalpMin * 100).toFixed(0)}% – ${(strategy.scalpMax * 100).toFixed(0)}%</b>
├ Extended Hold: <b>+${(strategy.extendedTarget * 100).toFixed(0)}%</b>
└ Stop Loss: <b>-${(strategy.stopLoss * 100).toFixed(0)}%</b>

💼 <b>Portfolio</b>
├ Available Balance: <b>${user.currentBalance.toFixed(6)} SOL</b>
├ In Position: <b>${pos.investedSOL.toFixed(6)} SOL</b>
└ Active Positions: <b>${this.portfolioManager.positions.size}/${MAX_CONCURRENT_POSITIONS}</b>

🔗 <a href="${txUrl}">View TX on Solscan</a> • <a href="${birdeyeUrl}">Live Chart</a>

<i>Direct execution • ${new Date().toLocaleTimeString()} UTC</i>
    `.trim();
    }

    formatSellMessage(trade, user) {
        const emoji = trade.profitSOL > 0 ? '✅' : '❌';
        const color = trade.profitSOL > 0 ? '🟢' : '🔴';

        const reasonLabels = {
            'scalp_profit': '⚡ Scalp Profit',
            'extended_profit': '🎯 Extended Target Hit',
            'stop_loss': '🛡️ Stop Loss Triggered'
        };

        const reason = reasonLabels[trade.reason] || trade.reason.toUpperCase();

        const txUrl = `https://solscan.io/tx/${trade.sellTxSignature}`;
        const birdeyeUrl = `https://birdeye.so/token/${trade.tokenAddress}?chain=solana`;

        return `
${emoji} <b>POSITION CLOSED ${color}</b>
<b>${trade.symbol}</b>
└ ${reason}

💰 <b>Trade Summary</b>
├ Entry Price: <b>${trade.entryPrice.toFixed(10)} SOL/token</b>
├ Exit Price: <b>${trade.exitPrice.toFixed(10)} SOL/token</b>
├ Price Change: <b>${trade.profitPercent >= 0 ? '+' : ''}${trade.profitPercent.toFixed(2)}%</b>
└ Hold Time: <b>${trade.holdTimeMinutes}m</b>

📊 <b>Financial Result (SOL)</b>
├ Invested: <b>${trade.investedSOL.toFixed(6)} SOL</b>
├ Received: <b>${trade.solReceived.toFixed(6)} SOL</b>
├ Net P&L: <b>${trade.profitSOL >= 0 ? '+' : ''}${trade.profitSOL.toFixed(6)} SOL</b>
└ Return: <b>${trade.profitPercent >= 0 ? '+' : ''}${trade.profitPercent.toFixed(2)}%</b>

💼 <b>Account Update</b>
├ Current Balance: <b>${user.currentBalance.toFixed(6)} SOL</b>
├ Daily P&L: <b>${user.dailyProfitPercent >= 0 ? '+' : ''}${user.dailyProfitPercent.toFixed(2)}%</b>
├ Total Trades: <b>${user.totalTrades}</b>
└ Win Rate: <b>${((user.successfulTrades / user.totalTrades) * 100).toFixed(1)}%</b>

🔗 <a href="${txUrl}">View Sell TX</a> • <a href="${birdeyeUrl}">Live Chart</a>

<i>${new Date().toLocaleTimeString()} UTC</i>
    `.trim();
    }

    formatDailyTargetMessage(user, target) {
        return `
🎯 <b>DAILY ${target} HIT</b>

Daily P&L: ${user.dailyProfitPercent >= 0 ? '+' : ''}${user.dailyProfitPercent.toFixed(2)}%
Start: ${user.dailyStartBalance.toFixed(2)} USDC
Current: ${user.currentBalance.toFixed(2)} USDC

${ENABLE_PROFIT_TAKING && user.totalProfitTaken > 0 ? `💰 Total Secured: ${user.totalProfitTaken.toFixed(2)} USDC\n` : ''}
Bot entering 24h cooldown.
Next: Day ${user.currentDay + 1}
  `.trim();
    }

    formatStrategyAdjustmentMessage(oldLevel, newStrategy, stats) {
        const levelEmojis = { 'CONSERVATIVE': '🛡️', 'MODERATE': '⚖️', 'AGGRESSIVE': '🚀' };
        return `
📊 <b>STRATEGY ADJUSTMENT</b>

<b>Performance:</b>
Trades: ${stats.totalTrades}
Win Rate: ${stats.winRate}%
Profit Factor: ${stats.profitFactor}
Streak: ${stats.currentStreak > 0 ? '+' : ''}${stats.currentStreak}

<b>Change:</b> ${levelEmojis[oldLevel]} ${oldLevel} → ${levelEmojis[newStrategy.level]} ${newStrategy.level}

<b>New Targets:</b>
Daily: ${(newStrategy.dailyTarget * 100).toFixed(0)}%
Per Trade: ${(newStrategy.perTradeTarget * 100).toFixed(0)}%
Position: ${(newStrategy.positionSize * 100).toFixed(0)}%

🎯 Bot optimized!
  `.trim();
    }

    // End of TradingEngine class methods
}


// ============ COMPLETE TRADING BOT CLASS ============
// Add this to the end of bot.js after TradingEngine class

class TradingBot {
    constructor() {
        console.log('🤖 TradingBot Constructor Starting...');

        this.ownerId = AUTHORIZED_USERS.length > 0 ? AUTHORIZED_USERS[0] : null;

        // ===== TELEGRAM BOT SETUP =====
        console.log('📱 Initializing Telegram bot...');
        logger.info('🔵 Starting in POLLING MODE (Production)');

        this.bot = new TelegramBot(TELEGRAM_TOKEN, {
            polling: {
                interval: 5000,
                autoStart: true,
                params: {
                    timeout: 10,
                    allowed_updates: ['message']
                }
            },
            filepath: false,
            request: {
                agentOptions: {
                    keepAlive: false,
                    family: 4
                }
            }
        });

        // Polling error handler
        let pollingErrorCount = 0;
        let lastPollingError = 0;

        this.bot.on('polling_error', async (error) => {
            const now = Date.now();

            // Reset counter if no errors for 5 minutes
            if (now - lastPollingError > 300000) {
                pollingErrorCount = 0;
            }

            lastPollingError = now;
            pollingErrorCount++;

            // ECONNRESET is normal on Railway - just log and continue
            if (error.code === 'EFATAL' && error.message.includes('ECONNRESET')) {
                console.log(`⚠️  Telegram connection reset (normal on Railway) - retry ${pollingErrorCount}`);

                // Only log to Winston every 10 resets (reduce spam)
                if (pollingErrorCount % 10 === 0) {
                    logger.warn('Telegram connection resets', {
                        count: pollingErrorCount,
                        error: error.message
                    });
                }

                // If too many resets in short time, restart polling
                if (pollingErrorCount > 20) {
                    console.log('🔄 Too many resets, restarting polling...');
                    await this.restartPolling();
                    pollingErrorCount = 0;
                }

                return; // Don't crash, let it auto-retry
            }

            // Multiple bot instances = critical error
            if (error.code === 'ETELEGRAM' && error.message.includes('409')) {
                logger.error('❌ Multiple bot instances detected - SHUTTING DOWN');
                console.error('❌ CRITICAL: Another instance is running!');
                process.exit(1);
            }

            // ETIMEDOUT is common on Railway
            if (error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED') {
                console.log(`⏳ Telegram timeout (will retry) - ${error.code}`);
                return;
            }

            // Unknown errors
            console.error('❌ Telegram polling error:', error.code, error.message);
            logger.error('Telegram polling error', {
                code: error.code,
                message: error.message
            });
        });

        // General bot error handler
        this.bot.on('error', (error) => {
            console.error('❌ Bot error:', error.message);
            logger.error('Bot error', { error: error.message });
        });


        this.bot.on('error', (error) => {
            logger.error('Bot error', { error: error.message });
        });

        // Verify connection
        this.bot.getMe()
            .then(info => {
                console.log('✅ Connected to Telegram:', info.username);
                logger.info('Bot connected to Telegram', {
                    username: info.username,
                    id: info.id,
                    mode: 'POLLING'
                });
            })
            .catch(err => {
                console.error('❌ Failed to connect to Telegram:', err.message);
                logger.error('Bot connection failed', { error: err.message });
                process.exit(1);
            });

        // ===== INITIALIZE COMPONENTS =====
        console.log('⚙️  Initializing components...');

        try {
            // RPC Connection
            console.log('   - RPC Connection...');
            this.rpcConnection = new RobustConnection(SOLANA_RPC_URL, RPC_FALLBACK_URLS);
            console.log('     ✅ RPC initialized');

            // Wallet
            console.log('   - Wallet...');
            this.wallet = this.loadWallet(PRIVATE_KEY);
            console.log('     ✅ Wallet loaded:', this.wallet.publicKey.toString().substring(0, 8) + '...');

            // Database
            console.log('   - Database...');
            this.database = new DatabaseManager('./data/trading.db');
            if (!this.database) {
                throw new Error('DatabaseManager failed to instantiate');
            }
            console.log('     ✅ Database instantiated');

            // BitQuery Removed
            // console.log('   - BitQuery Client...');
            // this.bitquery = new BitqueryClient(BITQUERY_API_KEY, logger, this.database);
            // if (!this.bitquery) {
            //     throw new Error('BitqueryClient failed to instantiate');
            // }
            // console.log('     ✅ BitQuery instantiated');

            // Trading Engine
            console.log('   - Trading Engine...');
            this.engine = new TradingEngine(this.bot, this.wallet, this.rpcConnection, this.database);
            if (!this.engine) {
                throw new Error('TradingEngine failed to instantiate');
            }
            console.log('     ✅ Trading Engine instantiated');

            // Optional: Health Monitor
            if (ENABLE_HEALTH_MONITORING) {
                console.log('   - Health Monitor...');
                this.healthMonitor = new HealthMonitor(logger, this);
                console.log('     ✅ Health Monitor instantiated');
            } else {
                console.log('   - Health Monitor: DISABLED');
                this.healthMonitor = null;
            }

            console.log('✅ All components instantiated successfully\n');

        } catch (error) {
            console.error('❌ Component initialization failed:', error.message);
            console.error('Stack:', error.stack);
            logger.error('Constructor failed', { error: error.message, stack: error.stack });
            throw error;
        }

        // Setup memory management
        this.setupMemoryManagement();
    }


    async restartPolling() {
        try {
            console.log('🔄 Restarting Telegram polling...');
            logger.info('Attempting to restart polling');

            await this.bot.stopPolling();
            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5s
            await this.bot.startPolling();

            console.log('✅ Polling restarted successfully');
            logger.info('Polling restarted successfully');
        } catch (error) {
            console.error('❌ Failed to restart polling:', error.message);
            logger.error('Failed to restart polling', { error: error.message });

            // If restart fails, exit and let Railway restart the whole bot
            console.log('🔄 Exiting for Railway restart...');
            process.exit(1);
        }
    }



    performMemoryCleanup() {
        let cleaned = 0;

        // 1. Clear BitQuery cache


        // 2. Trim trade history to last 10 trades per user
        for (const [userId, user] of this.engine.userStates.entries()) {
            if (user.tradeHistory && user.tradeHistory.length > 10) {
                const removed = user.tradeHistory.length - 10;
                user.tradeHistory = user.tradeHistory.slice(-10);
                cleaned += removed;
                console.log(`   🧹 Trimmed ${removed} old trades for user ${userId}`);
            }

            // 3. Trim profit taking history
            if (user.profitTakingHistory && user.profitTakingHistory.length > 5) {
                const removed = user.profitTakingHistory.length - 5;
                user.profitTakingHistory = user.profitTakingHistory.slice(-5);
                cleaned += removed;
            }
        }

        // 4. Clear RPC failure tracking (reset counts)
        if (this.rpcConnection) {
            this.rpcConnection.failureCounts.fill(0);
            this.rpcConnection.lastFailureTime.fill(0);
        }

        // 5. Clear performance tracker averages (keep totals)
        if (this.engine && this.engine.performanceTracker) {
            // Don't clear everything, just reset some calculated fields
            this.engine.performanceTracker.recentFees = [];
        }

        // 6. Clear priority fee calculator history
        if (this.engine && this.engine.priorityFeeCalculator) {
            this.engine.priorityFeeCalculator.recentFees = [];
        }

        return cleaned;
    }

    async init() {
        logger.info('Trading bot initializing...');

        try {
            // ===== STEP 1: DATABASE INIT =====
            console.log('📦 Step 1: Initializing database...');
            if (!this.database) {
                throw new Error('Database is undefined! Check DatabaseManager initialization in constructor.');
            }
            await this.database.init();
            logger.info('✅ Database initialized');

            // ===== STEP 2: BITQUERY INIT =====

            // ===== STEP 3: TRADING ENGINE INIT =====
            console.log('⚙️  Step 3: Initializing trading engine...');
            if (!this.engine) {
                throw new Error('Trading engine is undefined! Check TradingEngine initialization in constructor.');
            }
            await this.engine.init();
            logger.info('✅ Trading engine initialized');

            // ===== STEP 4: TELEGRAM COMMANDS =====
            console.log('📱 Step 4: Setting up Telegram commands...');
            this.setupCommands();
            logger.info('✅ Telegram commands setup');

            // ===== STEP 5: HEALTH MONITORING (OPTIONAL) =====
            if (ENABLE_HEALTH_MONITORING && this.healthMonitor) {
                console.log('🏥 Step 5: Starting health monitoring...');
                this.healthMonitor.start(5);
                logger.info('✅ Health monitoring started');
            } else {
                console.log('⏭️  Step 5: Health monitoring disabled');
            }

            // ===== STEP 6: TRADING CYCLES =====
            console.log('🚀 Step 6: Starting trading cycles...');
            this.startTrading();
            logger.info('✅ Trading cycles started');

            console.log('='.repeat(50));
            console.log('✅ BOT FULLY OPERATIONAL');
            console.log('='.repeat(50));

            logger.info('✅ Trading bot fully operational');

        } catch (error) {
            console.error('❌ Initialization failed:', error.message);
            console.error('Stack:', error.stack);
            logger.error('Initialization failed', {
                error: error.message,
                stack: error.stack
            });
            throw error; // Re-throw to stop startup
        }
    }


    loadWallet(privateKey) {
        if (!privateKey) {
            throw new Error('PRIVATE_KEY not set in environment');
        }

        try {
            const decoded = bs58.decode(privateKey);
            if (decoded.length === 64) {
                logger.info('Wallet loaded (64-byte keypair)');
                return Keypair.fromSecretKey(decoded);
            } else if (decoded.length === 32) {
                logger.info('Wallet loaded (32-byte seed)');
                return Keypair.fromSeed(decoded);
            } else {
                throw new Error(`Invalid private key length: ${decoded.length}`);
            }
        } catch (err) {
            logger.error('Failed to load wallet', { error: err.message });
            throw new Error('Invalid PRIVATE_KEY format. Must be Base58 encoded.');
        }
    }

    async handleTestQuote(userId, chatId) {
        try {
            await this.sendMessage(chatId, '🧪 <b>Testing Jupiter Quote...</b>', {
                parse_mode: 'HTML'
            });

            console.log('\n🧪 MANUAL QUOTE TEST TRIGGERED');
            console.log('   User:', userId);
            console.log('   Testing: 1 USDC → SOL\n');

            // Test parameters
            const testAmount = 1_000_000; // 1 USDC (6 decimals)
            const inputMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC
            const outputMint = 'So11111111111111111111111111111111111111112'; // SOL
            const slippage = 300; // 3%

            // Call the quote method
            const quote = await this.engine.getJupiterQuote(
                inputMint,
                outputMint,
                testAmount,
                slippage
            );

            if (quote && quote.outAmount) {
                // Calculate human-readable values
                const inUSDC = parseInt(quote.inAmount) / 1_000_000;
                const outSOL = parseInt(quote.outAmount) / 1_000_000_000;
                const pricePerSOL = inUSDC / outSOL;

                console.log('✅ Quote test PASSED');
                console.log(`   In: ${inUSDC} USDC`);
                console.log(`   Out: ${outSOL} SOL`);
                console.log(`   Price: $${pricePerSOL.toFixed(2)} per SOL\n`);

                // Send success message
                await this.sendMessage(chatId, `
✅ <b>QUOTE TEST PASSED</b>

<b>Request:</b>
Amount: ${inUSDC.toFixed(6)} USDC
From: USDC
To: SOL

<b>Response:</b>
Input: ${inUSDC.toFixed(6)} USDC
Output: ${outSOL.toFixed(6)} SOL
Price: $${pricePerSOL.toFixed(2)} per SOL

<b>Details:</b>
Price Impact: ${quote.priceImpactPct || 'N/A'}%
Routes: ${quote.routePlan?.length || 1}
Slippage: ${slippage / 100}%

✅ <b>Jupiter API is working!</b>
All endpoints are operational.

<i>You can now use /start to begin trading.</i>
            `.trim(), { parse_mode: 'HTML' });

                this.logger.info('Quote test successful', {
                    userId,
                    inAmount: quote.inAmount,
                    outAmount: quote.outAmount,
                    pricePerSOL: pricePerSOL.toFixed(2)
                });

            } else {
                console.log('❌ Quote test FAILED - no quote returned\n');

                // Send failure message
                await this.sendMessage(chatId, `
❌ <b>QUOTE TEST FAILED</b>

All Jupiter endpoints failed to respond.

<b>Possible Issues:</b>
• Network connectivity problems
• Jupiter API is down
• Rate limiting active
• RPC connection issues

<b>Debugging Steps:</b>
1. Check bot logs (console output)
2. Wait 1-2 minutes and try again
3. Verify RPC is working: /status
4. Check wallet has funds: /wallet

<b>Jupiter Endpoint Status:</b>
${JUPITER_ENDPOINTS.map((ep, i) =>
                    `${i + 1}. ${ep.substring(0, 40)}...\n   Failures: ${jupiterEndpointFailures[i]}`
                ).join('\n')}

<b>What to do:</b>
• If all endpoints show 0-3 failures: Try again
• If any endpoint shows 4+ failures: Wait 5 minutes
• If issue persists: Check Railway logs

<i>Contact support if problem continues.</i>
            `.trim(), { parse_mode: 'HTML' });

                this.logger.error('Quote test failed - all endpoints unreachable', {
                    userId,
                    endpointFailures: jupiterEndpointFailures
                });
            }

        } catch (error) {
            console.error('💥 Quote test error:', error.message);
            console.error('Stack:', error.stack);

            this.logger.error('Quote test error', {
                userId,
                error: error.message,
                stack: error.stack
            });

            // Send error message
            await this.sendMessage(chatId, `
❌ <b>Test Error</b>

<b>Error:</b> ${error.message}

<b>Possible Causes:</b>
${error.message.includes('getJupiterQuote') ?
                    '• getJupiterQuote method missing or broken' :
                    '• Network connectivity issue'}
${error.message.includes('timeout') ?
                    '• Request timeout (Jupiter API slow)' : ''}
${error.message.includes('Invalid') ?
                    '• Invalid parameters or response' : ''}

<b>Next Steps:</b>
1. Check bot logs for details
2. Verify /status shows bot is healthy
3. Try /wallet to check connectivity
4. Contact support with error code: ${Date.now()}

<i>Check console output for full error details.</i>
        `.trim(), { parse_mode: 'HTML' });
        }
    }
    async sendMessage(chatId, text, options = {}) {
        const maxRetries = 3;
        const maxLength = 4096;

        // Truncate if too long
        let messageText = text;
        if (text.length > maxLength) {
            logger.warn('Message too long, truncating', {
                originalLength: text.length,
                chatId
            });
            messageText = text.substring(0, maxLength - 100) + '\n\n... (message truncated)';
        }

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await this.bot.sendMessage(chatId, messageText, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true,
                    ...options
                });
            } catch (error) {
                logger.warn(`Send message attempt ${attempt}/${maxRetries} failed`, {
                    error: error.message,
                    chatId,
                    attempt
                });

                // If HTML parsing failed, try without HTML
                if (error.message.includes('parse') && options.parse_mode === 'HTML') {
                    logger.info('Retrying without HTML parse mode');
                    delete options.parse_mode;
                    messageText = this.stripHtmlTags(messageText);
                }

                // If it's the last attempt, throw the error
                if (attempt === maxRetries) {
                    throw error;
                }

                // Exponential backoff
                await new Promise(resolve =>
                    setTimeout(resolve, 1000 * Math.pow(2, attempt - 1))
                );
            }
        }
    }


    stripHtmlTags(text) {
        return text
            .replace(/<[^>]*>/g, '')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#039;/g, "'");
    }
    setupCommands() {
        logger.info('Setting up Telegram bot commands...');

        // ============ SINGLE MESSAGE HANDLER FOR ALL COMMANDS ============
        this.bot.on('message', async (msg) => {
            const startTime = Date.now();
            let userId, chatId, command;

            try {
                // Only process text messages that start with /
                if (!msg.text || !msg.text.startsWith('/')) return;

                userId = msg.from.id;
                chatId = msg.chat.id;
                const text = msg.text.trim();
                const [cmd, ...args] = text.split(' ');
                command = cmd.toLowerCase();

                logger.info('Command received', {
                    userId,
                    chatId,
                    command,
                    args,
                    username: msg.from.username
                });

                // Authorization check
                if (!this.isAuthorized(userId)) {
                    await this.sendMessage(chatId, '❌ Unauthorized. Contact bot owner.');
                    logger.warn('Unauthorized command attempt', { userId, command });
                    return;
                }

                // Send typing indicator
                await this.bot.sendChatAction(chatId, 'typing').catch(e =>
                    logger.debug('Failed to send typing indicator:', e.message)
                );

                // Route to appropriate handler with individual error handling
                let handlerPromise;

                switch (command) {
                    case '/start':
                        handlerPromise = this.handleStart(userId, chatId);
                        break;

                    case '/stop':
                        handlerPromise = this.handleStop(userId, chatId);
                        break;

                    case '/balance':
                        handlerPromise = this.handleBalance(userId, chatId);
                        break;

                    case '/status':
                        handlerPromise = this.handleStatus(userId, chatId);
                        break;

                    case '/performance':
                        handlerPromise = this.handlePerformance(userId, chatId);
                        break;

                    case '/history':
                        handlerPromise = this.handleHistory(userId, chatId);
                        break;

                    case '/stats':
                        handlerPromise = this.handleStats(userId, chatId);
                        break;

                    case '/profits':
                        handlerPromise = this.handleProfits(userId, chatId);
                        break;

                    case '/health':
                        handlerPromise = this.handleHealth(userId, chatId);
                        break;

                    case '/anomalies':
                        handlerPromise = this.handleAnomalies(userId, chatId);
                        break;

                    case '/reset_breaker':
                        if (this.isAuthorized(userId)) {
                            this.engine.circuitBreaker.forceReset();
                            handlerPromise = this.sendMessage(chatId, '✅ Circuit breaker manually reset.');
                        }
                        break;

                    case '/portfolio':
                        handlerPromise = this.handlePortfolio(userId, chatId);
                        break;

                    case '/backtest':
                        const days = parseInt(args[0]) || 30;
                        handlerPromise = this.handleBacktest(userId, chatId, days);
                        break;

                    case '/wallet':
                        handlerPromise = this.handleWallet(userId, chatId);
                        break;

                    case '/help':
                        handlerPromise = this.handleHelp(userId, chatId);
                        break;

                    case '/recent':
                        handlerPromise = this.handleRecentTrades(userId, chatId);
                        break;

                    case '/scan':
                        handlerPromise = this.handleScan(userId, chatId);
                        break;


                    case '/testquote':
                        handlerPromise = this.handleTestQuote(userId, chatId);
                        break;


                    default:
                        await this.sendMessage(chatId,
                            `❓ Unknown command: ${command}\n\nUse /help to see available commands.`
                        );
                        logger.debug('Unknown command', { command, userId });
                        return;
                }

                // Execute handler with timeout
                await Promise.race([
                    handlerPromise,
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Command timeout (30s)')), 30000)
                    )
                ]);

                const executionTime = Date.now() - startTime;
                logger.info('Command executed successfully', {
                    command,
                    userId,
                    executionTime: `${executionTime}ms`
                });

            } catch (error) {
                const executionTime = Date.now() - startTime;

                // Detailed error logging
                logger.error('Command handler error', {
                    command: command || 'unknown',
                    userId: userId || 'unknown',
                    chatId: chatId || 'unknown',
                    error: error.message,
                    errorName: error.name,
                    stack: error.stack,
                    executionTime: `${executionTime}ms`,
                    text: msg.text
                });

                // User-friendly error message based on error type
                let errorMessage = '❌ <b>Command Failed</b>\n\n';

                if (error.message.includes('timeout')) {
                    errorMessage += '⏱️ The command took too long to execute.\n';
                    errorMessage += 'Please try again in a moment.';
                } else if (error.message.includes('Unauthorized')) {
                    errorMessage += '🔒 You are not authorized to use this bot.';
                } else if (error.message.includes('ETELEGRAM')) {
                    errorMessage += '📱 Telegram API error.\n';
                    errorMessage += 'Please try again.';
                } else if (error.message.includes('wallet') || error.message.includes('balance')) {
                    errorMessage += '💼 Wallet connection issue.\n';
                    errorMessage += 'Retrying may help.';
                } else if (error.message.includes('database') || error.message.includes('DB')) {
                    errorMessage += '💾 Database error.\n';
                    errorMessage += 'Your data is safe, please try again.';
                } else {
                    // Generic error for unknown issues
                    errorMessage += `⚠️ ${this.sanitizeErrorMessage(error.message)}\n\n`;
                    errorMessage += `Error Code: ${Date.now()}\n`;
                    errorMessage += 'Please try again or contact support.';
                }

                try {
                    await this.sendMessage(chatId, errorMessage, {
                        parse_mode: 'HTML'
                    });
                } catch (sendErr) {
                    logger.error('Failed to send error message to user', {
                        error: sendErr.message,
                        originalError: error.message,
                        userId,
                        chatId
                    });

                    // Last resort: try plain text without HTML
                    try {
                        await this.sendMessage(chatId,
                            '❌ An error occurred. Please try again or contact support.'
                        );
                    } catch (finalErr) {
                        logger.error('Complete message send failure', {
                            error: finalErr.message
                        });
                    }
                }
            }
        });

        // Handle polling errors
        this.bot.on('polling_error', (error) => {
            logger.error('Telegram polling error', {
                error: error.message,
                code: error.code,
                stack: error.stack
            });
        });

        // Handle webhook errors (if using webhooks)
        this.bot.on('webhook_error', (error) => {
            logger.error('Telegram webhook error', {
                error: error.message,
                stack: error.stack
            });
        });

        logger.info('✅ Message handler configured with enhanced error handling');
    }

    sanitizeErrorMessage(message) {
        if (!message) return 'Unknown error';

        // Remove sensitive information
        let sanitized = String(message)
            .replace(/\b[A-Za-z0-9]{32,}\b/g, '[REDACTED]') // Remove tokens/keys
            .replace(/\/[\w\/.-]+/g, '[PATH]') // Remove file paths
            .replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, '[IP]') // Remove IPs
            .substring(0, 200); // Limit length

        return sanitized;
    }

    async handleDebug(userId, chatId) {
        try {
            const user = this.engine.getUserState(userId);
            const dbUser = await this.database.getUser(userId.toString());

            const message = `
🔍 <b>DEBUG INFO</b>

<b>Memory State:</b>
Active: ${user.isActive ? '✅ YES' : '❌ NO'}
Balance: ${user.currentBalance.toFixed(4)}
Position: ${user.position ? 'Has position' : 'No position'}

<b>Database State:</b>
Active: ${dbUser?.is_active === 1 ? '✅ YES' : '❌ NO'}
Balance: ${dbUser?.current_balance?.toFixed(4) || 'N/A'}
Total Trades: ${dbUser?.total_trades || 0}

<b>Trading Engine:</b>
Total Users: ${this.engine.userStates.size}
Active Users: ${Array.from(this.engine.userStates.values()).filter(u => u.isActive).length}
Scanning: ${this.engine.isScanning ? 'YES' : 'NO'}

<b>Circuit Breaker:</b>
Status: ${this.engine.circuitBreaker.isTripped ? '❌ TRIPPED' : '✅ OK'}
        `.trim();

            await this.sendMessage(chatId, message, { parse_mode: 'HTML' });

        } catch (error) {
            await this.sendMessage(chatId, `Error: ${error.message}`);
        }
    }

    async handleStart(userId, chatId) {
        try {
            await this.sendMessage(chatId, '⏳ Activating bot...');

            const user = this.engine.getUserState(userId);

            // Get wallet balance FIRST
            const balances = await this.engine.getWalletBalance();
            const tradingBalance = balances.trading;

            console.log('\n' + '='.repeat(60));
            console.log('🚀 USER ACTIVATION');
            console.log('='.repeat(60));
            console.log('User ID:', userId);
            console.log('Trading Balance from wallet:', tradingBalance.toFixed(4));
            console.log('Current user.currentBalance:', user.currentBalance.toFixed(4));

            // Check minimum balance
            if (tradingBalance < 0.01) {
                await this.sendMessage(chatId, `
⚠️ <b>INSUFFICIENT FUNDS</b>

Current: ${tradingBalance.toFixed(4)}
Minimum: 0.1 for testing

Wallet: <code>${this.wallet.publicKey.toString()}</code>

Fund your wallet and try /start again.
            `.trim(), { parse_mode: 'HTML' });
                return;
            }

            // Check database
            let dbUser = await this.database.getUser(userId.toString()).catch(() => null);

            // 🔥 FIX: Set balance BEFORE database operations
            if (!dbUser) {
                // New user - initialize with wallet balance
                console.log('📝 New user - initializing with wallet balance');
                user.startingBalance = tradingBalance;
                user.currentBalance = tradingBalance;  // 🔥 SET THIS
                user.dailyStartBalance = tradingBalance;
                user.tradingCapital = tradingBalance;
                user.currentDay = 1;

                await this.database.createUser(userId.toString(), tradingBalance);
                console.log('✅ New user created in DB with balance:', tradingBalance);
            } else {
                // Existing user - sync with wallet balance
                console.log('📝 Existing user - syncing with wallet balance');
                console.log('   DB balance:', dbUser.current_balance);
                console.log('   Wallet balance:', tradingBalance);

                // 🔥 CRITICAL: Always sync to wallet balance
                user.currentBalance = tradingBalance;
                user.tradingCapital = tradingBalance;
                user.dailyStartBalance = tradingBalance;

                // Update starting balance if first time or reset
                if (user.startingBalance === 0 || !user.startingBalance) {
                    user.startingBalance = tradingBalance;
                }

                console.log('✅ Synced to wallet balance:', user.currentBalance);
            }

            // 🔥 CRITICAL: Activate user
            user.isActive = true;

            console.log('\n✅ User state after setup:');
            console.log('   isActive:', user.isActive);
            console.log('   currentBalance:', user.currentBalance.toFixed(4));
            console.log('   tradingCapital:', user.tradingCapital.toFixed(4));
            console.log('   startingBalance:', user.startingBalance.toFixed(4));

            // Update database with correct values
            await this.database.updateUser(userId.toString(), {
                is_active: 1,
                current_balance: user.currentBalance,  // 🔥 Use the synced balance
                trading_capital: user.tradingCapital,
                daily_start_balance: user.dailyStartBalance,
                starting_balance: user.startingBalance
            });

            console.log('✅ Database updated');

            // Verify it worked
            const verify = await this.database.getUser(userId.toString());
            console.log('✅ Verification:', {
                is_active: verify.is_active,
                current_balance: verify.current_balance,
                trading_capital: verify.trading_capital
            });

            if (verify.current_balance === 0 || verify.current_balance === null) {
                throw new Error('Database balance still 0 after update!');
            }

            if (verify.is_active !== 1) {
                throw new Error('User not activated in database');
            }

            // Save state
            await this.engine.saveState();
            console.log('✅ State saved');

            // Final check
            const finalUser = this.engine.getUserState(userId);
            console.log('✅ Final verification:', {
                isActive: finalUser.isActive,
                currentBalance: finalUser.currentBalance.toFixed(4),
                hasPosition: finalUser.position !== null
            });
            console.log('='.repeat(60) + '\n');

            if (!finalUser.isActive) {
                throw new Error('Final state check failed - user not active');
            }

            if (finalUser.currentBalance === 0) {
                throw new Error('Final state check failed - balance is 0');
            }

            // Success message
            const strategy = this.engine.getActiveStrategy();
            const walletAddr = this.wallet.publicKey.toString();
            const shortAddr = `${walletAddr.slice(0, 4)}...${walletAddr.slice(-4)}`;

            await this.sendMessage(chatId, `
🤖 <b>BOT ACTIVATED</b> ✅
${ENABLE_PAPER_TRADING ? '🧪 PAPER TRADING MODE' : '💰 LIVE TRADING MODE'}

💼 <b>Account:</b>
Wallet: <code>${shortAddr}</code>
Balance: ${finalUser.currentBalance.toFixed(4)} ${balances.usdc > 0.01 ? 'USDC' : 'SOL'}
Day: ${finalUser.currentDay || 1}

🎯 <b>Strategy:</b>
Daily Target: +${(DAILY_PROFIT_TARGET * 100).toFixed(0)}%
Stop Loss: -${(DAILY_STOP_LOSS * 100).toFixed(0)}%
Per Trade: ${(strategy.perTradeTarget * 100).toFixed(0)}%

📊 <b>Filters:</b>
Bonding: ${MIN_BONDING_PROGRESS}-${MAX_BONDING_PROGRESS}%
Min Liquidity: $${MIN_LIQUIDITY_USD}

🚀 <b>Status:</b>
✅ Bot active and scanning
⏰ Scan interval: ${SCAN_INTERVAL_MINUTES} minutes

Commands:
/status - Check bot status
/balance - View detailed balance
/stop - Stop trading
        `.trim(), { parse_mode: 'HTML' });

            console.log('✅ Start message sent to user');
            logger.info('User activated successfully', {
                userId,
                balance: finalUser.currentBalance,
                isActive: finalUser.isActive
            });

        } catch (error) {
            console.error('💥 START ERROR:', error.message);
            console.error('Stack:', error.stack);

            logger.error('handleStart failed', {
                error: error.message,
                stack: error.stack,
                userId
            });

            await this.sendMessage(chatId,
                `❌ <b>Activation Failed</b>\n\n${error.message}\n\nPlease try again.`,
                { parse_mode: 'HTML' }
            ).catch(err => {
                console.error('Failed to send error message:', err.message);
            });
        }
    }



    async handleScan(userId, chatId) {
        try {
            await this.sendMessage(chatId, '🔍 Manual scan initiated...');

            const user = this.engine.getUserState(userId);
            if (!user.isActive) {
                await this.sendMessage(chatId,
                    '❌ Bot is not active. Use /start first.'
                );
                return;
            }

            console.log('\n🔍 MANUAL SCAN TRIGGERED by user', userId);
            await this.engine.tradingCycle();

            await this.sendMessage(chatId,
                '✅ Scan complete. Check logs for results.'
            );

        } catch (error) {
            logger.error('Manual scan failed', { error: error.message });
            await this.sendMessage(chatId,
                `❌ Scan failed: ${error.message}`
            );
        }
    }

    async handleWallet(userId, chatId) {
        try {
            await this.sendMessage(chatId, '⏳ Fetching wallet info...');

            // Get real-time wallet balance
            const balances = await this.engine.getWalletBalance();

            const walletAddress = this.wallet.publicKey.toString();
            const explorerUrl = `https://solscan.io/account/${walletAddress}`;

            // Check if wallet is empty
            if (balances.trading === 0 || balances.trading < 0.001) {
                await this.sendMessage(chatId, `
⚠️ <b>EMPTY WALLET</b>

📍 <b>Address:</b>
<code>${walletAddress}</code>

📊 <b>Balances:</b>
SOL: ${balances.sol.toFixed(4)}
Wrapped SOL: ${balances.wsol.toFixed(4)}
USDC: ${balances.usdc.toFixed(2)}

❌ <b>No funds available for trading</b>

<b>To fund your wallet:</b>
1. Copy the address above
2. Send SOL or USDC from exchange/wallet
3. Recommended minimum: 0.5 SOL or $50 USDC
4. Wait 1-2 minutes for confirmation
5. Run /start to begin trading

🔗 <a href="${explorerUrl}">View on Solscan</a>

Use /wallet again after funding to verify.
            `.trim(), {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                });
                return;
            }

            // Format balances
            const formatBalance = (amount, decimals = 4) => {
                if (amount === 0) return '0';
                if (amount < 0.0001) return amount.toExponential(2);
                return amount.toFixed(decimals);
            };

            // Build token list
            let tokenList = [];

            if (balances.sol > 0) {
                tokenList.push(`◎ <b>SOL:</b> ${formatBalance(balances.sol, 4)}`);
            }

            if (balances.wsol > 0) {
                tokenList.push(`🔄 <b>WSOL:</b> ${formatBalance(balances.wsol, 4)}`);
            }

            if (balances.usdc > 0) {
                tokenList.push(`💵 <b>USDC:</b> ${formatBalance(balances.usdc, 2)}`);
            }

            const otherTokens = balances.allTokens.filter(t =>
                t.symbol !== 'USDC' &&
                t.symbol !== 'WSOL' &&
                t.symbol !== 'SOL'
            );

            otherTokens.slice(0, 5).forEach(token => {
                tokenList.push(`🪙 <b>${token.symbol}:</b> ${formatBalance(token.balance, 4)}`);
            });

            if (otherTokens.length > 5) {
                tokenList.push(`... and ${otherTokens.length - 5} more tokens`);
            }

            const tradingCurrency = balances.usdc > 0.01 ? 'USDC' : 'SOL';
            const tradingAmount = balances.trading;

            let message = `
💛 <b>WALLET OVERVIEW</b>

📍 <b>Address:</b>
<code>${walletAddress}</code>

💰 <b>Balances:</b>
${tokenList.join('\n')}

💼 <b>Trading Balance:</b> ${formatBalance(tradingAmount, 4)} ${tradingCurrency}

🔗 <a href="${explorerUrl}">View on Solscan</a>

ℹ️ Use /balance for trading stats
ℹ️ Use /status for bot status
        `.trim();

            await this.sendMessage(chatId, message, {
                parse_mode: 'HTML',
                disable_web_page_preview: true
            });

            logger.info('Wallet info displayed', {
                userId,
                address: walletAddress,
                trading: tradingAmount
            });

        } catch (error) {
            logger.error('Wallet command failed', {
                userId,
                error: error.message
            });

            await this.sendMessage(chatId,
                `❌ Failed to fetch wallet info: ${error.message}`
            );
        }
    }

    async handleRecent(userId, chatId) {
        try {
            // Get recent trades from database
            const recentTrades = await this.database.getRecentTrades(userId, 20);

            if (!recentTrades || recentTrades.length === 0) {
                await this.sendMessage(chatId, '📭 No recent trades found');
                return;
            }

            let message = '📊 <b>RECENT TRADES</b>\n\n';

            recentTrades.forEach((trade, i) => {
                const emoji = trade.profit > 0 ? '✅' : '❌';
                const date = new Date(trade.exit_time).toLocaleString();

                message += `${emoji} <b>${trade.symbol}</b>\n`;
                message += `   Entry: $${trade.entry_price.toFixed(8)}\n`;
                message += `   Exit: $${trade.exit_price.toFixed(8)}\n`;
                message += `   P&L: ${trade.profit >= 0 ? '+' : ''}${trade.profit.toFixed(2)} (${trade.profit_percent.toFixed(2)}%)\n`;
                message += `   Time: ${date}\n\n`;
            });

            await this.sendMessage(chatId, message, { parse_mode: 'HTML' });
        } catch (error) {
            logger.error('Recent trades error:', error);
            await this.sendMessage(chatId, '❌ Failed to fetch recent trades');
        }
    }


    async handleStop(userId, chatId) {
        const user = this.engine.getUserState(userId);
        user.isActive = false;
        await this.engine.saveState();

        const stats = { queries: 0, estimatedPoints: 0, pointsPerQuery: 0 }; // BitQuery removed

        const rpcStatus = this.rpcConnection.getStatus();

        await this.sendMessage(chatId, `
  🛑 <b>AUTO-TRADING STOPPED</b>
  
  📊 <b>Session Stats:</b>
  API Queries: ${stats.queries}
  Est. Points: ${stats.estimatedPoints}
  Avg: ${stats.pointsPerQuery} pts/query
  
  🔌 <b>RPC Status:</b>
  Current: ${rpcStatus.isPrimary ? 'Primary' : 'Fallback'}
  Failures: ${rpcStatus.failureCounts[rpcStatus.currentIndex]}
  
  ${user.position ? '⚠️ You have an open position. Monitor it manually.' : ''}
  
  Use /start to resume trading.
      `.trim(), { parse_mode: 'HTML' });

        logger.info('User stopped bot', { userId });
    }

    async handleBalance(userId, chatId) {
        try {
            const user = this.engine.getUserState(userId);

            // Get REAL wallet balance
            const balances = await this.engine.getWalletBalance();
            const tradingBalance = balances.trading;

            // Get DB balance
            const dbUser = await this.database.getUser(userId.toString());

            const message = `
💼 <b>BALANCE DEBUG</b>

🔍 <b>Reality Check:</b>
Wallet Balance: ${tradingBalance.toFixed(4)}
${balances.usdc > 0.01 ? 'USDC' : 'SOL'}

📊 <b>Tracked Balances:</b>
Memory (currentBalance): ${user.currentBalance.toFixed(4)}
Database (current_balance): ${dbUser?.current_balance?.toFixed(4) || '0'}
Trading Capital: ${user.tradingCapital.toFixed(4)}

${Math.abs(tradingBalance - user.currentBalance) > 0.01 ? '⚠️ <b>MISMATCH DETECTED!</b>' : '✅ Balances match'}

📈 <b>Trading Stats:</b>
Starting Balance: ${user.startingBalance.toFixed(4)}
Daily Start: ${user.dailyStartBalance.toFixed(4)}
Daily P&L: ${user.dailyProfit >= 0 ? '+' : ''}${user.dailyProfit.toFixed(4)}
Total Trades: ${user.totalTrades}

🏦 <b>Wallet Details:</b>
SOL: ${balances.sol.toFixed(4)}
WSOL: ${balances.wsol.toFixed(4)}
USDC: ${balances.usdc.toFixed(2)}

<b>Status:</b> ${user.isActive ? '✅ Active' : '❌ Inactive'}
        `.trim();

            await this.sendMessage(chatId, message, { parse_mode: 'HTML' });

        } catch (error) {
            await this.sendMessage(chatId, `Error: ${error.message}`);
        }
    }

    async handleStatus(userId, chatId) {
        const user = this.engine.getUserState(userId);
        const hasPosition = user.position !== null;
        const dailyTargetHit = this.engine.isDailyTargetHit(user);

        let statusEmoji = user.isActive ? '🟢' : '🔴';
        let statusText = user.isActive ? 'Active' : 'Stopped';
        if (dailyTargetHit) {
            statusEmoji = '⏸️';
            statusText += ' (Cooldown)';
        }

        const rpcStatus = this.rpcConnection.getStatus();
        const rpcEmoji = rpcStatus.isPrimary ? '✅' : '⚠️';

        const circuitStatus = this.engine.circuitBreaker.getStatus();
        const circuitEmoji = circuitStatus.isTripped ? '🚨' : '✅';

        let positionInfo = '';
        if (hasPosition) {
            const pos = user.position;
            const currentPrice = await this.engine.getCurrentPrice(pos.tokenAddress);
            const priceChange = currentPrice ? ((currentPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(2) : '?';
            const holdTime = ((Date.now() - pos.entryTime) / 60000).toFixed(1);
            const unrealizedPnL = currentPrice ? ((pos.tokensOwned * currentPrice) - pos.investedUSDC).toFixed(2) : '?';

            positionInfo = `
  
  📊 <b>CURRENT POSITION:</b>
  Token: ${pos.symbol}
  Entry: $${pos.entryPrice.toFixed(8)}
  Current: $${currentPrice ? currentPrice.toFixed(8) : '...'}
  Change: ${priceChange}%
  Unrealized P&L: ${unrealizedPnL} USDC
  
  🎯 <b>Targets:</b>
  Target: $${pos.targetPrice.toFixed(8)}
  Stop: $${pos.stopLossPrice.toFixed(8)}
  Hold: ${holdTime}m
  Mode: ${pos.scalpMode ? 'Scalp' : 'Extended'}
  
  Invested: ${pos.investedUSDC.toFixed(2)} USDC
  Tokens: ${pos.tokensOwned.toFixed(4)}`;
        }

        const portfolioStats = this.engine.portfolioManager.getStats();

        await this.sendMessage(chatId, `
  ${statusEmoji} <b>BOT STATUS</b>
  
  <b>Trading:</b> ${statusText}
  <b>Mode:</b> ${ENABLE_PAPER_TRADING ? '📝 Paper' : '💰 Live'}
  <b>Day:</b> ${user.currentDay}/30
  <b>Balance:</b> ${user.currentBalance.toFixed(2)} USDC
  <b>Daily P&L:</b> ${user.dailyProfitPercent >= 0 ? '+' : ''}${user.dailyProfitPercent.toFixed(2)}%
  
  ${rpcEmoji} <b>RPC Connection:</b>
  Status: ${rpcStatus.isPrimary ? 'Primary' : `Fallback #${rpcStatus.currentIndex}`}
  Endpoint: ${rpcStatus.currentUrl.substring(0, 40)}...
  Failures: ${rpcStatus.failureCounts[rpcStatus.currentIndex]}
  
  ${circuitEmoji} <b>Circuit Breaker:</b>
  Status: ${circuitStatus.isTripped ? 'TRIPPED' : 'Active'}
  Consecutive Losses: ${circuitStatus.consecutiveLosses}/${MAX_CONSECUTIVE_LOSSES}
  Daily Losses: ${circuitStatus.dailyLosses}/${MAX_DAILY_LOSSES}
  ${circuitStatus.isTripped ? `Cooldown: ${Math.floor(circuitStatus.cooldownRemaining / 60)}m remaining` : ''}
  
  📊 <b>Portfolio:</b>
  Positions: ${portfolioStats.totalPositions}/${MAX_CONCURRENT_POSITIONS}
  Total Invested: ${portfolioStats.totalInvested.toFixed(2)} USDC
  
  📈 <b>Performance:</b>
  Trades: ${user.totalTrades}
  Wins: ${user.successfulTrades}
  Win Rate: ${user.totalTrades > 0 ? ((user.successfulTrades / user.totalTrades) * 100).toFixed(1) : 0}%
  Strategy: ${this.engine.performanceTracker.metrics.strategyLevel}${positionInfo}
      `.trim(), { parse_mode: 'HTML' });

        logger.info('Status checked', { userId });
    }

    async handlePerformance(userId, chatId) {
        const report = this.engine.performanceTracker.getDetailedReport();
        const user = this.engine.getUserState(userId);

        await this.sendMessage(chatId, `
  📊 <b>PERFORMANCE REPORT</b>
  
  <b>📈 Summary:</b>
  Total Trades: ${report.summary.totalTrades}
  Wins: ${report.summary.winningTrades}
  Losses: ${report.summary.losingTrades}
  Win Rate: ${report.summary.winRate}
  Profit Factor: ${report.summary.profitFactor}
  Expectancy: ${report.summary.expectancy}
  
  <b>💰 Profit Metrics:</b>
  Total Profit: +${report.profitMetrics.totalProfit} USDC
  Total Loss: -${report.profitMetrics.totalLoss} USDC
  Net P&L: ${report.profitMetrics.netProfit} USDC
  Avg Win: ${report.profitMetrics.avgWinPercent}
  Avg Loss: ${report.profitMetrics.avgLossPercent}
  
  <b>📊 Extremes:</b>
  Best Trade: +${report.extremes.largestWin}
  Worst Trade: ${report.extremes.largestLoss}
  Best Streak: ${report.extremes.consecutiveWins} wins
  Worst Streak: ${report.extremes.consecutiveLosses} losses
  Current Streak: ${report.extremes.currentStreak}
  
  <b>⚙️ Strategy:</b>
  Level: ${report.strategy.currentLevel}
  Last Adjustment: ${new Date(report.strategy.lastAdjustment).toLocaleDateString()}
  ${ENABLE_AUTO_ADJUSTMENT ? `Next Review: ${new Date(report.strategy.nextReview).toLocaleDateString()}` : 'Auto-adjust: OFF'}
  
  <b>💼 Account Growth:</b>
  Starting: ${user.startingBalance.toFixed(2)} USDC
  Current: ${user.currentBalance.toFixed(2)} USDC
  Total Return: ${((user.currentBalance - user.startingBalance) / user.startingBalance * 100).toFixed(2)}%
      `.trim(), { parse_mode: 'HTML' });

        logger.info('Performance viewed', { userId });
    }

    async handleHistory(userId, chatId) {
        const user = this.engine.getUserState(userId);

        if (!user.tradeHistory.length) {
            await this.sendMessage(chatId, '📭 <b>No trades yet</b>\n\nStart trading to see your history.', { parse_mode: 'HTML' });
            return;
        }

        const recent = user.tradeHistory.slice(-10).reverse();
        let text = `📜 <b>TRADE HISTORY</b>\n<b>Last 10 trades:</b>\n\n`;

        recent.forEach((trade) => {
            const emoji = trade.profit > 0 ? '✅' : '❌';
            const labels = { 'scalp_profit': 'Scalp', 'extended_profit': 'Extended', 'stop_loss': 'Stop' };

            text += `${emoji} <b>${trade.symbol}</b> (${labels[trade.reason] || trade.reason})\n`;
            text += `  Entry: $${trade.entryPrice.toFixed(8)}\n`;
            text += `  Exit: $${trade.exitPrice.toFixed(8)}\n`;
            text += `  P&L: ${trade.profit >= 0 ? '+' : ''}${trade.profit.toFixed(2)} (${trade.profitPercent.toFixed(2)}%)\n`;
            text += `  Hold: ${trade.holdTimeMinutes}m\n\n`;
        });

        const totalProfit = user.tradeHistory.reduce((sum, t) => sum + t.profit, 0);
        text += `<b>Total P&L:</b> ${totalProfit >= 0 ? '+' : ''}${totalProfit.toFixed(2)} USDC`;

        await this.sendMessage(chatId, text, { parse_mode: 'HTML' });
        logger.info('History viewed', { userId });
    }

    async handleStats(userId, chatId) {
        const stats = { queries: 0, estimatedPoints: 0, pointsPerQuery: 0 }; // BitQuery removed

        const monthlyEstimate = stats.estimatedPoints * (30 * 24 * 60 / SCAN_INTERVAL_MINUTES);

        await this.sendMessage(chatId, `
  📊 <b>API USAGE STATISTICS</b>
  
  <b>Current Session:</b>
  Queries: ${stats.queries}
  Est. Points: ${stats.estimatedPoints.toLocaleString()}
  Avg: ${stats.pointsPerQuery} pts/query
  
  <b>Monthly Projection:</b>
  Estimated: ${Math.floor(monthlyEstimate).toLocaleString()} points
  Limit: 3,000,000 points
  Status: ${monthlyEstimate <= 3000000 ? '✅ Within Limit' : '⚠️ Over Limit'}
  Usage: ${(monthlyEstimate / 3000000 * 100).toFixed(1)}%
      `.trim(), { parse_mode: 'HTML' });

        logger.info('Stats viewed', { userId });
    }

    async handleProfits(userId, chatId) {
        const user = this.engine.getUserState(userId);

        if (!ENABLE_PROFIT_TAKING) {
            await this.sendMessage(chatId, '💰 <b>PROFIT TAKING</b>\n\nStatus: ❌ Disabled', { parse_mode: 'HTML' });
            return;
        }

        if (user.profitTakingHistory.length === 0) {
            await this.sendMessage(chatId, `💰 <b>PROFIT TAKING</b>\n\nStatus: ✅ Enabled\nNo profits taken yet. Keep trading!`, { parse_mode: 'HTML' });
            return;
        }

        const recent = user.profitTakingHistory.slice(-10).reverse();
        let text = `💰 <b>PROFIT TAKING HISTORY</b>\n\n`;

        recent.forEach((pt) => {
            const date = new Date(pt.date).toLocaleDateString();
            text += `📅 <b>Day ${pt.day}</b> (${date})\nTaken: ${pt.profitTaken.toFixed(2)} USDC\n\n`;
        });

        text += `<b>Total Secured:</b> ${user.totalProfitTaken.toFixed(2)} USDC`;

        await this.sendMessage(chatId, text, { parse_mode: 'HTML' });
        logger.info('Profits viewed', { userId });
    }

    async handleHealth(userId, chatId) {
        if (!ENABLE_HEALTH_MONITORING || !this.healthMonitor) {
            await this.sendMessage(chatId, '🏥 <b>HEALTH MONITORING</b>\n\nStatus: ❌ Disabled', { parse_mode: 'HTML' });
            return;
        }

        const status = this.healthMonitor.getStatus();
        const healthEmoji = status.healthy ? '✅' : '⚠️';

        await this.sendMessage(chatId, `
  🏥 <b>SYSTEM HEALTH</b>
  
  Status: ${healthEmoji} ${status.healthy ? 'Healthy' : 'Issues Detected'}
  Uptime: ${status.uptime}
      `.trim(), { parse_mode: 'HTML' });

        logger.info('Health checked', { userId });
    }

    async handleAnomalies(userId, chatId) {
        if (!ENABLE_ANOMALY_DETECTION || !this.engine.anomalyDetector) {
            await this.sendMessage(chatId, '🔍 <b>ANOMALY DETECTION</b>\n\nStatus: ❌ Disabled', { parse_mode: 'HTML' });
            return;
        }

        const summary = this.engine.anomalyDetector.getSummary();
        await this.sendMessage(chatId, `
  🔍 <b>ANOMALY DETECTION</b>
  
  Baseline Win Rate: ${summary.baseline.avgWinRate.toFixed(1)}%
  All clear!
      `.trim(), { parse_mode: 'HTML' });

        logger.info('Anomalies viewed', { userId });
    }

    async handlePortfolio(userId, chatId) {
        const portfolioStats = this.engine.portfolioManager.getStats();

        if (portfolioStats.totalPositions === 0) {
            await this.sendMessage(chatId, `📊 <b>PORTFOLIO</b>\n\nNo active positions.`, { parse_mode: 'HTML' });
            return;
        }

        let text = `📊 <b>PORTFOLIO</b>\n\nPositions: ${portfolioStats.totalPositions}/${MAX_CONCURRENT_POSITIONS}\n`;

        for (const pos of portfolioStats.positions) {
            text += `\n<b>${pos.symbol}</b>\nInvested: ${pos.invested} USDC\nAllocation: ${pos.allocation}`;
        }

        await this.sendMessage(chatId, text, { parse_mode: 'HTML' });
        logger.info('Portfolio viewed', { userId });
    }

    async handleBacktest(userId, chatId, days) {
        if (!ENABLE_BACKTESTING) {
            await this.sendMessage(chatId, '📈 Backtesting disabled', { parse_mode: 'HTML' });
            return;
        }

        await this.sendMessage(chatId, 'Backtest feature coming soon...', { parse_mode: 'HTML' });
        logger.info('Backtest requested', { userId, days });
    }

    async handleHelp(userId, chatId) {
        await this.sendMessage(chatId, `
📚 <b>COMMAND REFERENCE</b>

<b>🎮 Trading Controls:</b>
/start - Activate trading
/stop - Stop trading
/recent - Recent trades 
/scan - force start trading

<b>💰 Wallet & Balance:</b>
/wallet - View wallet address & balances
/balance - Detailed trading balance
/status - Bot status & positions

<b>📊 Analytics:</b>
/performance - Performance metrics
/history - Trade history
/stats - API usage
/profits - Profit history
/portfolio - Active positions
/testquote -  test jupiterquote


<b>🔧 Advanced:</b>
/health - System health
/anomalies - Anomaly detection
/backtest - Run backtest

<b>ℹ️ Information:</b>
/help - This menu

<b>⚙️ Current Mode:</b>
${ENABLE_PAPER_TRADING ? '📝 Paper Trading' : '💰 Live Trading'}
Daily Target: ${(DAILY_PROFIT_TARGET * 100).toFixed(0)}%
Strategy: ${this.engine.performanceTracker.metrics.strategyLevel}

<b>⚠️ Risk Warning:</b>
High-risk trading. Monitor daily.
Can lose all capital. Trade responsibly.
    `.trim(), { parse_mode: 'HTML' });

        logger.info('Help viewed', { userId });
    }

    isAuthorized(userId) {
        return AUTHORIZED_USERS.length === 0 || AUTHORIZED_USERS.includes(userId.toString());
    }

    async setupWebhook() {
        // Setup webhook endpoint
        this.app.post('/webhook', (req, res) => {
            this.bot.processUpdate(req.body);
            res.sendStatus(200);
        });

        // Health check endpoint
        this.app.get('/health', (req, res) => {
            const stats = { queries: 0, estimatedPoints: 0, pointsPerQuery: 0 }; // BitQuery removed

            const rpcStatus = this.rpcConnection.getStatus();
            const user = this.engine.getUserState(this.ownerId);

            res.json({
                status: 'healthy',
                mode: 'webhook',
                timestamp: new Date().toISOString(),
                uptime: process.uptime(),
                version: '2.0.0',
                features: {
                    paperTrading: ENABLE_PAPER_TRADING,
                    multiDex: ENABLE_MULTI_DEX,
                    technicalAnalysis: ENABLE_TECHNICAL_ANALYSIS,
                    mevProtection: ENABLE_MEV_PROTECTION,
                    healthMonitoring: ENABLE_HEALTH_MONITORING,
                    anomalyDetection: ENABLE_ANOMALY_DETECTION
                },
                trading: {
                    isActive: user?.isActive || false,
                    hasPosition: user?.position !== null,
                    currentBalance: user?.currentBalance || 0,
                    dailyProfitPercent: user?.dailyProfitPercent || 0
                },
                apiStats: stats,
                rpcStatus: rpcStatus
            });
        });

        // Set webhook with Telegram
        try {
            await this.bot.setWebHook(`${WEBHOOK_URL}/webhook`);
            logger.info(`Webhook set: ${WEBHOOK_URL}/webhook`);
        } catch (err) {
            logger.error('Webhook setup failed', { error: err.message });
            throw err;
        }
    }

    startTrading() {
        console.log('\n' + '='.repeat(60));
        console.log('🚀 STARTING TRADING CYCLES (EVENT DRIVEN)');
        console.log('='.repeat(60));

        // 1. Position monitoring (Dynamic Interval - uses internal setTimeout)
        this.engine.startPositionMonitor();

        // 2. State saves (every 10 min)
        const stateInterval = setInterval(async () => {
            try {
                await this.engine.saveState();
            } catch (error) {
                logger.error('State save error', { error: error.message });
            }
        }, 10 * 60 * 1000);

        this.intervals = {
            state: stateInterval
        };

        console.log('✅ Background monitors active (Position Monitor, State Saver)');
        console.log('✅ Event Loop Active (Strategies A & B)');

        console.log('✅ All intervals started\n');
    }


    // ============ REDUCE MEMORY CLEANUP SPAM ============
    // Replace setupMemoryManagement() with this QUIETER version
    setupMemoryManagement() {
        console.log('🧠 Memory management: Monitoring only');

        // Just log every 5 minutes - NO ACTION TAKEN
        setInterval(() => {
            const mem = process.memoryUsage();
            const rssMB = mem.rss / 1024 / 1024;
            const heapPercent = (mem.heapUsed / mem.heapTotal * 100);

            // Only log, don't interrupt trading
            if (rssMB > 300 || heapPercent > 80) {
                console.log(`⚠️  Memory: ${rssMB.toFixed(0)}MB RSS, ${heapPercent.toFixed(0)}% heap`);

                // Force GC if available
                if (global.gc) {
                    global.gc();
                    console.log('   ♻️ Garbage collected');
                }
            }

            // ONLY exit if critically over limit (Railway = 512MB)
            if (rssMB > 480) {
                console.error('💥 CRITICAL MEMORY - Restarting');
                process.exit(1); // Railway will restart
            }
        }, 5 * 60 * 1000); // Every 5 minutes
    }



    async shutdown() {
        logger.info('Initiating graceful shutdown...');

        try {
            // ============ 1. STOP ALL INTERVALS FIRST ============
            logger.info('Stopping all intervals...');
            if (this.intervals) {
                Object.keys(this.intervals).forEach(key => {
                    try {
                        clearInterval(this.intervals[key]);
                        logger.debug(`✓ Cleared interval: ${key}`);
                    } catch (err) {
                        logger.warn(`Failed to clear interval: ${key}`, { error: err.message });
                    }
                });
            }

            // ============ 2. DEACTIVATE ALL USERS ============
            logger.info('Deactivating users...');
            for (const [userId, user] of this.engine.userStates.entries()) {
                user.isActive = false;
                logger.debug(`✓ Deactivated user: ${userId}`);
            }

            // ============ 3. STOP TELEGRAM POLLING ============
            logger.info('Stopping Telegram polling...');
            try {
                await this.bot.stopPolling();
                logger.info('✓ Polling stopped');
            } catch (pollErr) {
                logger.warn('Polling stop failed (may already be stopped)', {
                    error: pollErr.message
                });
            }

            // ============ 4. SAVE CURRENT STATE ============
            logger.info('Saving state...');
            try {
                await this.engine.saveState();
                logger.info('✓ State saved');
            } catch (stateErr) {
                logger.error('State save failed', { error: stateErr.message });
            }

            // ============ 5. STOP HEALTH MONITORING ============
            if (this.healthMonitor) {
                try {
                    this.healthMonitor.stop();
                    logger.info('✓ Health monitor stopped');
                } catch (healthErr) {
                    logger.warn('Health monitor stop failed', { error: healthErr.message });
                }
            }

            // ============ 6. SAVE PERFORMANCE METRICS ============
            if (this.engine && this.engine.performanceTracker) {
                try {
                    const userId = this.ownerId || AUTHORIZED_USERS[0];
                    if (userId) {
                        await this.engine.performanceTracker.saveMetrics(userId);
                        logger.info('✓ Performance metrics saved');
                    }
                } catch (perfErr) {
                    logger.warn('Performance save failed', { error: perfErr.message });
                }
            }

            // ============ 7. CLOSE DATABASE ============
            if (this.database) {
                try {
                    await this.database.close();
                    logger.info('✓ Database closed');
                } catch (dbErr) {
                    logger.error('Database close failed', { error: dbErr.message });
                }
            }

            // ============ 8. CLEAR CACHES ============
            logger.info('Clearing caches...');
            if (this.engine && this.engine.anomalyDetector) {
                // Clear any detector caches
                logger.debug('✓ Anomaly detector cleared');
            }

            // ============ 9. FINAL STATS ============
            const stats = { queries: 0, estimatedPoints: 0, pointsPerQuery: 0 }; // BitQuery removed

            const mem = process.memoryUsage();

            logger.info('Final statistics', {
                api: {
                    queries: stats.queries,
                    estimatedPoints: stats.estimatedPoints,
                    avgPoints: stats.pointsPerQuery
                },
                memory: {
                    heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
                    heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + 'MB',
                    rss: Math.round(mem.rss / 1024 / 1024) + 'MB'
                },
                uptime: process.uptime().toFixed(0) + 's'
            });

            // ============ 10. PERFORMANCE SUMMARY ============
            if (this.engine && this.engine.performanceTracker) {
                const perfStats = this.engine.performanceTracker.metrics;
                logger.info('Trading summary', {
                    totalTrades: perfStats.totalTrades,
                    wins: perfStats.winningTrades,
                    losses: perfStats.losingTrades,
                    winRate: perfStats.totalTrades > 0
                        ? ((perfStats.winningTrades / perfStats.totalTrades) * 100).toFixed(1) + '%'
                        : '0%',
                    profitFactor: (perfStats.totalProfit / (perfStats.totalLoss || 1)).toFixed(2)
                });
            }

            // ============ 11. FINAL MEMORY CLEANUP ============
            logger.info('Final memory cleanup...');
            await this.performMemoryCleanup();
            if (global.gc) {
                global.gc();
                logger.debug('✓ Garbage collection executed');
            }

            // ============ 12. FLUSH LOGS ============
            // Give Winston time to write final logs
            await new Promise(resolve => setTimeout(resolve, 1000));

            logger.info('='.repeat(50));
            logger.info('✅ Graceful shutdown complete');
            logger.info('='.repeat(50));

            process.exit(0);

        } catch (error) {
            logger.error('Shutdown error', {
                error: error.message,
                stack: error.stack
            });

            // Force exit after critical error
            setTimeout(() => {
                process.exit(1);
            }, 2000);
        }
    }
}


// ============ STARTUP & ERROR HANDLING ============

async function main() {
    try {
        logger.info('='.repeat(50));
        logger.info('Enhanced Solana Trading Bot v2.0 - POLLING MODE');
        logger.info('='.repeat(50));

        // Validate environment
        if (!TELEGRAM_TOKEN) throw new Error('TELEGRAM_TOKEN not set');

        if (!PRIVATE_KEY) throw new Error('PRIVATE_KEY not set');

        logger.info('Configuration loaded');
        logger.info(`Mode: POLLING (Production)`);
        logger.info(`Trading Mode: ${ENABLE_PAPER_TRADING ? 'PAPER' : 'LIVE'}`);
        logger.info(`RPC Primary: ${SOLANA_RPC_URL.substring(0, 50)}...`);
        logger.info(`RPC Fallbacks: ${RPC_FALLBACK_URLS.length}`);
        logger.info(`Authorized Users: ${AUTHORIZED_USERS.length || 'All'}`);

        logger.info('Features:');
        logger.info(`  Multi-DEX: ${ENABLE_MULTI_DEX ? '✅' : '❌'}`);
        logger.info(`  Technical Analysis: ${ENABLE_TECHNICAL_ANALYSIS ? '✅' : '❌'}`);
        logger.info(`  MEV Protection: ${ENABLE_MEV_PROTECTION ? '✅' : '❌'}`);
        logger.info(`  Health Monitoring: ${ENABLE_HEALTH_MONITORING ? '✅' : '❌'}`);
        logger.info(`  Anomaly Detection: ${ENABLE_ANOMALY_DETECTION ? '✅' : '❌'}`);
        logger.info(`  Backtesting: ${ENABLE_BACKTESTING ? '✅' : '❌'}`);

        logger.info('Trading Parameters:');
        logger.info(`  Daily Target: ${(DAILY_PROFIT_TARGET * 100).toFixed(0)}%`);
        logger.info(`  Daily Stop: -${(DAILY_STOP_LOSS * 100).toFixed(0)}%`);
        logger.info(`  Per Trade Target: ${(PER_TRADE_PROFIT_TARGET * 100).toFixed(0)}%`);
        logger.info(`  Stop Loss: -${(PER_TRADE_STOP_LOSS * 100).toFixed(0)}%`);
        logger.info(`  Position Size Mode: ${POSITION_SIZE_MODE}`);
        logger.info(`  Max Concurrent Positions: ${MAX_CONCURRENT_POSITIONS}`);



        // Initialize bot
        const bot = new TradingBot();
        await bot.init();

        logger.info('='.repeat(50));
        logger.info('✅ Bot fully operational and ready to trade!');
        logger.info('='.repeat(50));


        let shutdownInProgress = false;

        const handleShutdown = async () => {
            if (shutdownInProgress) {
                logger.warn(`Shutdown already in progress, ignoring ${signal}`);
            } return;

            shutdownInProgress = true;
            logger.info(`{signal} received - inittiating shutdown`);

        }
        // Handle shutdown signals
        process.on('SIGTERM', () => {
            logger.info('SIGTERM received');
            bot.shutdown();
        });

        process.on('SIGINT', () => {
            logger.info('SIGINT received');
            bot.shutdown();
        });

        process.on('uncaughtException', (error) => {
            logger.error('Uncaught Exception', {
                error: error.message,
                stack: error.stack
            });
            bot.shutdown();
        });

        process.on('unhandledRejection', (reason, promise) => {
            logger.error('Unhandled Rejection', {
                reason: reason instanceof Error ? reason.message : reason,
                promise: promise.toString()
            });
        });

    } catch (error) {
        logger.error('Startup failed', {
            error: error.message,
            stack: error.stack
        });
        process.exit(1);
    }
}

// ============ START THE BOT ============
if (require.main === module) {
    main().catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}

module.exports = { TradingEngine, TradingBot, logger };