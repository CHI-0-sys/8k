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

console.log('ENV CHECK:');
console.log('TELEGRAM_TOKEN:', process.env.TELEGRAM_TOKEN ? 'SET' : 'MISSING');
console.log('BITQUERY_API_KEY:', process.env.BITQUERY_API_KEY ? 'SET' : 'MISSING');
console.log('PRIVATE_KEY:', process.env.PRIVATE_KEY ? 'SET' : 'MISSING');
console.log('USE_WEBHOOK:', process.env.USE_WEBHOOK);



const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const winston = require('winston');
const { Worker } = require('worker_threads');
const { Connection, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL, Keypair, Transaction, SystemProgram } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = require('node-fetch');
const AbortController = require('abort-controller');
const axios = require('axios');
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



// Import our new modules
const DatabaseManager = require('./modules/database');
const TechnicalIndicators = require('./modules/indicators');
const BacktestEngine = require('./modules/backtest');
const DEXAggregator = require('./modules/dex-aggregator');
const MEVProtection = require('./modules/mev-protection');
const HealthMonitor = require('./modules/health-monitor');
const AnomalyDetector = require('./modules/anomaly-detector'); 


// ============ WINSTON LOGGING SETUP ============
const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.json()
  ),
  defaultMeta: { service: 'trading-bot' },
  transports: [
      new winston.transports.File({ 
          filename: path.join(logDir, 'error.log'),    // ⬅
          level: 'error',
          maxsize: 5 * 1024 * 1024,
          maxFiles: 3
      }),
      new winston.transports.File({ 
          filename: path.join(logDir, 'combined.log'),  // ⬅️
          maxsize: 5 * 1024 * 1024,
          maxFiles: 5
      }),
      new winston.transports.File({ 
          filename: path.join(logDir, 'trades.log'),    //
          level: 'info',
          maxsize: 5 * 1024 * 1024,
          maxFiles: 10
      }),
      new winston.transports.Console({
          format: winston.format.combine(
              winston.format.colorize(),
              winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
                  return `${timestamp} [${service}] ${level}: ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
              })
          )
      })
  ],
  exceptionHandlers: [
      new winston.transports.File({ filename: path.join(logDir, 'exceptions.log') })
  ],
  rejectionHandlers: [
      new winston.transports.File({ filename: path.join(logDir, 'rejections.log') })
  ]
});


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
const DAILY_PROFIT_TARGET = parseFloat(process.env.DAILY_PROFIT_TARGET) || 0.32;
const DAILY_STOP_LOSS = parseFloat(process.env.DAILY_STOP_LOSS) || 0.06;
const PER_TRADE_PROFIT_TARGET = parseFloat(process.env.PER_TRADE_PROFIT_TARGET) || 0.13;
const PER_TRADE_STOP_LOSS = parseFloat(process.env.PER_TRADE_STOP_LOSS) || 0.03;
const SCALP_PROFIT_MIN = parseFloat(process.env.SCALP_PROFIT_MIN) || 0.07;
const SCALP_PROFIT_MAX = parseFloat(process.env.SCALP_PROFIT_MAX) || 0.13;
const EXTENDED_HOLD_MINUTES = parseInt(process.env.EXTENDED_HOLD_MINUTES) || 15;
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
const MAX_CONCURRENT_POSITIONS = parseInt(process.env.MAX_CONCURRENT_POSITIONS) || 3;
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

// ============ MUTEX FOR RACE CONDITION PREVENTION ============
class Mutex {
  constructor() {
      this.locked = false;
      this.queue = [];
  }

  async acquire() {
      while (this.locked) {
          await new Promise(resolve => this.queue.push(resolve));
      }
      this.locked = true;
  }

  release() {
      this.locked = false;
      const resolve = this.queue.shift();
      if (resolve) resolve();
  }

  async runExclusive(callback) {
      await this.acquire();
      try {
          return await callback();
      } finally {
          this.release();
      }
  }
}

// ============ CIRCUIT BREAKER ============
class CircuitBreaker {
  constructor() {
      this.consecutiveLosses = 0;
      this.dailyLosses = 0;
      this.isTripped = false;
      this.tripTime = null;
      this.dailyResetTime = Date.now();
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
      this.isTripped = true;
      this.tripTime = Date.now();
      logger.error('Circuit breaker tripped', { reason, consecutiveLosses: this.consecutiveLosses, dailyLosses: this.dailyLosses });
  }

  reset() {
      if (!this.isTripped) return false;

      const cooldownMs = CIRCUIT_BREAKER_COOLDOWN_MINUTES * 60 * 1000;
      if (Date.now() - this.tripTime >= cooldownMs) {
          this.isTripped = false;
          this.consecutiveLosses = 0;
          this.tripTime = null;
          logger.info('Circuit breaker reset');
          return true;
      }
      return false;
  }

  checkDailyReset() {
      if (Date.now() - this.dailyResetTime >= 24 * 60 * 60 * 1000) {
          this.dailyLosses = 0;
          this.dailyResetTime = Date.now();
          logger.info('Circuit breaker daily counters reset');
      }
  }

  canTrade() {
      this.checkDailyReset();
      this.reset();
      return !this.isTripped;
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
      this.connections = this.allUrls.map(url => new Connection(url, {
          commitment: 'confirmed',
          confirmTransactionInitialTimeout: TX_CONFIRMATION_TIMEOUT
      }));
      this.failureCounts = new Array(this.allUrls.length).fill(0);
      this.lastFailureTime = new Array(this.allUrls.length).fill(0);
      
      logger.info('RPC initialized', { 
          primary: primaryUrl, 
          fallbacks: fallbackUrls.length 
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
class BitqueryClient {
  constructor(apiKey, logger, database) {
      this.apiKey = apiKey;
      this.baseURL = "https://streaming.bitquery.io/eap";
      this.headers = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
      };
      this.logger = logger;
      this.database = database;
      this.queryCount = 0;
      this.estimatedPoints = 0;
      this.cache = null;
  }

  async init() {
      if (SHARED_CACHE_ENABLED) {
          // Simplified cache - would use Redis in production
          this.cache = new Map();
          this.logger.info('Bitquery cache initialized');
      }

      console.log('\n🔑 Testing BitQuery API Key...');
      const testQuery = `{
          Solana {
              DEXPools(limit: {count: 1}) {
                  Pool {
                      Market {
                          BaseCurrency {
                              Symbol
                          }
                      }
                  }
              }
          }
      }`;
      
      try {
          const testResult = await this.query(testQuery);
          if (testResult?.Solana?.DEXPools) {
              console.log('✅ API Key Valid - BitQuery Connected');
          } else {
              console.log('⚠️  API Key Valid but Query Failed');
              console.log('   Response:', JSON.stringify(testResult, null, 2));
          }
      } catch (err) {
          console.log('❌ API Key Test Failed:', err.message);
      }
  }
  
 // Add after BitqueryClient.init()
async testBitQueryConnection() {
    console.log('\n' + '='.repeat(60));
    console.log('🧪 TESTING BITQUERY CONNECTION');
    console.log('='.repeat(60));
    
    const simpleQuery = `{
        Solana {
            DEXPools(
                limit: {count: 5}
                where: {
                    Pool: {
                        Dex: {ProgramAddress: {is: "${PUMP_FUN_PROGRAM}"}}
                    }
                }
            ) {
                Pool {
                    Market {
                        BaseCurrency {
                            Symbol
                        }
                    }
                    Quote {
                        PostAmountInUSD
                    }
                }
            }
        }
    }`;
    
    try {
        console.log('Sending test query...');
        const result = await this.query(simpleQuery);
        
        if (!result) {
            console.log('❌ NULL RESULT - API key invalid or rate limited');
            return false;
        }
        
        if (result.Solana?.DEXPools) {
            console.log(`✅ BitQuery Working! Found ${result.Solana.DEXPools.length} pools`);
            result.Solana.DEXPools.forEach((pool, i) => {
                console.log(`   ${i+1}. ${pool.Pool.Market.BaseCurrency.Symbol} - $${pool.Pool.Quote.PostAmountInUSD}`);
            });
            return true;
        } else {
            console.log('❌ Unexpected response structure:', JSON.stringify(result, null, 2));
            return false;
        }
        
    } catch (error) {
        console.log('❌ Test failed:', error.message);
        return false;
    }
} 
  
    

  async query(graphql, variables = {}) {
      try {
          this.queryCount++;
          
          const response = await axios.post(this.baseURL, {
              query: graphql,
              variables: JSON.stringify(variables)
          }, {
              headers: this.headers,
              timeout: 15000
          });

          // Track in database
          if (this.database) {
              await this.database.trackAPIUsage('bitquery', 'graphql', 150, true);
          }

          if (response.data.errors) {
              this.logger.error('Bitquery errors', { errors: response.data.errors });
              return null;
          }

          return response.data.data;
      } catch (error) {
          this.logger.error('Bitquery query failed', { error: error.message });
          
          if (this.database) {
              await this.database.trackAPIUsage('bitquery', 'graphql', 0, false, error.message);
          }
          
          return null;
      }
  }

  async getGraduatingTokens() {
    console.log('\n' + '='.repeat(60));
    console.log('📡 BITQUERY API CALL - getGraduatingTokens()');
    console.log('='.repeat(60));
    
    // Check cache first
    if (this.cache && this.cache.has('graduating_tokens')) {
        const cached = this.cache.get('graduating_tokens');
        const cacheAge = (Date.now() - cached.timestamp) / 1000;
        
        if (Date.now() - cached.timestamp < CACHE_DURATION_MINUTES * 60 * 1000) {
            console.log('✅ Using cached data');
            console.log(`   Cache age: ${cacheAge.toFixed(0)}s / ${CACHE_DURATION_MINUTES * 60}s`);
            console.log(`   Cached tokens: ${cached.data.length}`);
            this.logger.debug('Using cached graduating tokens');
            return cached.data;
        } else {
            console.log('❌ Cache expired');
            console.log(`   Cache age: ${cacheAge.toFixed(0)}s (max: ${CACHE_DURATION_MINUTES * 60}s)`);
        }
    }

    console.log('\n🌐 Making fresh BitQuery API call...');
    console.log('   API Key:', this.apiKey ? this.apiKey.substring(0, 10) + '...' : 'MISSING');
    console.log('   Endpoint:', this.baseURL);

    const query = `{
        Solana {
            DEXPools(
                limitBy: {by: Pool_Market_BaseCurrency_MintAddress, count: 1}
                limit: {count: 50}
                orderBy: {descending: Pool_Quote_PostAmountInUSD}
                where: {
                    Pool: {
                        # WIDER RANGE to see ANY graduating tokens (20-100%)
                        Base: {PostAmount: {gt: "206900000"}}, 
                        Dex: {ProgramAddress: {is: "${PUMP_FUN_PROGRAM}"}}, 
                        Market: {QuoteCurrency: {MintAddress: {in: ["11111111111111111111111111111111", "${SOL_MINT}"]}}}
                    }, 
                    Transaction: {Result: {Success: true}}
                }
            ) {
                # Calculate ACTUAL bonding progress (0-100%)
                Bonding_Curve_Progress_precentage: calculate(
                    expression: "((Pool_Base_Balance - 206900000) * 100) / 793100000"
                )
                Pool {
                    Base {
                        Balance
                    }
                    Market {
                        BaseCurrency {
                            MintAddress
                            Name
                            Symbol
                        }
                    }
                    Quote {
                        PostAmountInUSD
                        PriceInUSD
                    }
                }
            }
        }
    }`;


    console.log('   Query parameters:');
    console.log('   - Limit: 50 tokens');
    console.log('   - Program: Pump.fun');
    console.log('   - Bonding range: 20-98% (raw query)');

    this.estimatedPoints += 150;
    
    try {
        console.log('\n⏳ Sending request...');
        const startTime = Date.now();
        
        const data = await this.query(query);
        
        const duration = Date.now() - startTime;
        console.log(`✅ Response received in ${duration}ms`);
        
        if (!data) {
            console.log('❌ NULL response from BitQuery');
            console.log('   This usually means:');
            console.log('   - API key invalid/expired');
            console.log('   - Rate limit hit');
            console.log('   - Query syntax error');
            return [];
        }
        
        if (!data.Solana) {
            console.log('❌ No Solana data in response');
            console.log('   Response structure:', JSON.stringify(data, null, 2));
            return [];
        }
        
        if (!data.Solana.DEXPools) {
            console.log('❌ No DEXPools in Solana data');
            console.log('   Solana data:', JSON.stringify(data.Solana, null, 2));
            return [];
        }

        const rawTokenCount = data.Solana.DEXPools.length;
        console.log(`\n📊 BitQuery returned: ${rawTokenCount} tokens`);

        if (rawTokenCount === 0) {
            console.log('⚠️  No tokens returned by BitQuery');
            console.log('   Possible reasons:');
            console.log('   - No tokens graduating right now');
            console.log('   - Pump.fun is slow today');
            console.log('   - Query filters too strict');
            console.log('='.repeat(60) + '\n');
            return [];
        }

        // Process tokens
        const allTokens = data.Solana.DEXPools.map(pool => {
            const progress = parseFloat(pool.Bonding_Curve_Progress_precentage || 0);
            return {
                address: pool.Pool.Market.BaseCurrency.MintAddress,
                symbol: pool.Pool.Market.BaseCurrency.Symbol || 'UNKNOWN',
                name: pool.Pool.Market.BaseCurrency.Name,
                bondingProgress: progress,
                liquidityUSD: parseFloat(pool.Pool.Quote.PostAmountInUSD) || 0,
                priceUSD: parseFloat(pool.Pool.Quote.PriceInUSD) || 0,
                lastUpdate: Date.now(),
                isHot: progress >= 96
            };
        });

        console.log('\n📋 Raw tokens (before filtering):');
        allTokens.slice(0, 10).forEach((token, i) => {
            console.log(`   ${i+1}. ${token.symbol.padEnd(15)} - ${token.bondingProgress.toFixed(1)}% bonding, $${token.liquidityUSD.toFixed(0).padStart(6)} liq`);
        });
        if (allTokens.length > 10) {
            console.log(`   ... and ${allTokens.length - 10} more`);
        }

        // Apply filters
        console.log('\n🔍 Applying filters:');
        console.log(`   Bonding: ${MIN_BONDING_PROGRESS}-${MAX_BONDING_PROGRESS}%`);
        console.log(`   Min Liquidity: $${MIN_LIQUIDITY_USD}`);
        
        const filtered = allTokens.filter(t => {
            const passBoinding = t.bondingProgress >= MIN_BONDING_PROGRESS && t.bondingProgress <= MAX_BONDING_PROGRESS;
            const passLiquidity = t.liquidityUSD >= MIN_LIQUIDITY_USD;
            
            if (!passBoinding) {
                console.log(`   ❌ ${t.symbol} - Bonding ${t.bondingProgress.toFixed(1)}% (need ${MIN_BONDING_PROGRESS}-${MAX_BONDING_PROGRESS}%)`);
            } else if (!passLiquidity) {
                console.log(`   ❌ ${t.symbol} - Liquidity $${t.liquidityUSD.toFixed(0)} (need >$${MIN_LIQUIDITY_USD})`);
            } else {
                console.log(`   ✅ ${t.symbol} - PASSED initial filters`);
            }
            
            return passBoinding && passLiquidity;
        });

        console.log(`\n✅ Tokens after filtering: ${filtered.length} / ${rawTokenCount}`);

        if (filtered.length === 0) {
            console.log('\n⚠️  NO TOKENS PASSED FILTERS');
            console.log('   Reasons:');
            console.log(`   - All tokens outside ${MIN_BONDING_PROGRESS}-${MAX_BONDING_PROGRESS}% bonding range`);
            console.log(`   - All tokens below $${MIN_LIQUIDITY_USD} liquidity`);
            console.log('\n💡 Consider adjusting filters if this persists');
        }

        // Sort if enabled
        if (PRIORITIZE_HOT_TOKENS) {
            filtered.sort((a, b) => {
                if (a.isHot && !b.isHot) return -1;
                if (!a.isHot && b.isHot) return 1;
                return b.liquidityUSD - a.liquidityUSD;
            });
            console.log('   Sorted by: Hot tokens first, then liquidity');
        }

        this.logger.info('Graduating tokens found', { 
            raw: rawTokenCount,
            filtered: filtered.length 
        });

        // Cache results
        if (this.cache) {
            this.cache.set('graduating_tokens', { data: filtered, timestamp: Date.now() });
            console.log(`   ✅ Cached for ${CACHE_DURATION_MINUTES} minutes`);
        }

        console.log('='.repeat(60) + '\n');
        return filtered;
        
    } catch (error) {
        console.log('\n❌ BitQuery API ERROR');
        console.log('   Error:', error.message);
        console.log('   Stack:', error.stack);
        console.log('='.repeat(60) + '\n');
        
        this.logger.error('BitQuery API error', { 
            error: error.message,
            stack: error.stack 
        });
        
        return [];
    }
}

  async getVolumeHistory(tokenAddress) {
      // Similar implementation as before but with logging
      if (!ENABLE_VOLUME_CHECK) {
          return { recent: 0, previous: 0, spike: true };
      }

      const now = new Date();
      const tenMinAgo = new Date(now.getTime() - 10 * 60000);
      const twentyMinAgo = new Date(now.getTime() - 20 * 60000);
  
      const query = `{
          Solana {
              recent: DEXPools(
                  where: {
                      Pool: {
                          Market: {BaseCurrency: {MintAddress: {is: "${tokenAddress}"}}}
                          Dex: {ProgramAddress: {is: "${PUMP_FUN_PROGRAM}"}}
                      }
                      Block: {Time: {since: "${tenMinAgo.toISOString()}"}}
                      Transaction: {Result: {Success: true}}
                  }
              ) {
                  Pool { Quote { PostAmountInUSD } }
              }
              previous: DEXPools(
                  where: {
                      Pool: {
                          Market: {BaseCurrency: {MintAddress: {is: "${tokenAddress}"}}}
                          Dex: {ProgramAddress: {is: "${PUMP_FUN_PROGRAM}"}}
                      }
                      Block: {Time: {since: "${twentyMinAgo.toISOString()}", till: "${tenMinAgo.toISOString()}"}}
                      Transaction: {Result: {Success: true}}
                  }
              ) {
                  Pool { Quote { PostAmountInUSD } }
              }
          }
      }`;
  
      this.estimatedPoints += 80;
      const data = await this.query(query);
      if (!data?.Solana) return { recent: 0, previous: 0, spike: false };
  
      const recentVol = (data.Solana.recent || []).reduce((sum, p) => sum + (Number(p?.Pool?.Quote?.PostAmountInUSD) || 0), 0);
      const prevVol = (data.Solana.previous || []).reduce((sum, p) => sum + (Number(p?.Pool?.Quote?.PostAmountInUSD) || 0), 0);
  
      const ABS_SPIKE_THRESHOLD = 100;
      let hasSpike = false;
      if (prevVol > 0) {
          hasSpike = (recentVol / prevVol) >= VOLUME_SPIKE_MULTIPLIER;
      } else {
          hasSpike = recentVol >= ABS_SPIKE_THRESHOLD;
      }

      this.logger.debug('Volume check', { token: tokenAddress.substring(0, 8), recentVol, prevVol, hasSpike });

      return { recent: recentVol, previous: prevVol, spike: hasSpike };
  }

  async detectWhaleDumps(tokenAddress) {
      if (!ENABLE_WHALE_CHECK) {
          return false;
      }

      const timeAgo = new Date(Date.now() - WHALE_DETECTION_WINDOW * 60000);

      const query = `{
          Solana {
              DEXPools(
                  where: {
                      Pool: {
                          Market: {BaseCurrency: {MintAddress: {is: "${tokenAddress}"}}}
                          Dex: {ProgramAddress: {is: "${PUMP_FUN_PROGRAM}"}}
                      }
                      Block: {Time: {since: "${timeAgo.toISOString()}"}}
                      Transaction: {Result: {Success: true}}
                  }
              ) {
                  Pool { Quote { PostAmountInUSD } }
              }
          }
      }`;

      this.estimatedPoints += 40;
      const data = await this.query(query);
      if (!data?.Solana?.DEXPools) return false;

      const largeSells = data.Solana.DEXPools.filter(
          p => (p.Pool?.Quote?.PostAmountInUSD || 0) > LARGE_SELL_THRESHOLD
      );

      const hasWhale = largeSells.length > 0;
      this.logger.debug('Whale check', { token: tokenAddress.substring(0, 8), hasWhale, largeSells: largeSells.length });

      return hasWhale;
  }

  getStats() {
      return {
          queries: this.queryCount,
          estimatedPoints: this.estimatedPoints,
          pointsPerQuery: this.queryCount > 0 ? (this.estimatedPoints / this.queryCount).toFixed(0) : 0
      };
  }
}

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
  constructor(bot, wallet, rpcConnection, bitquery, database) {
      this.bot = bot;
      this.wallet = wallet;
      this.rpcConnection = rpcConnection;
      this.bitquery = bitquery;
      this.database = database;
      this.logger = logger;
      this.userStates = new Map();
      this.isScanning = false;
      this.tradeMutex = new Mutex();
      this.performanceTracker = new PerformanceTracker(logger, database);
      this.currentStrategy = null;
      this.portfolioManager = new PortfolioManager();
      this.circuitBreaker = new CircuitBreaker();
      this.priorityFeeCalculator = new PriorityFeeCalculator(rpcConnection);
      
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
  }
  
  async init() {
    this.logger.info('Trading engine initializing');
    await this.loadState();
    
    // Sync wallet balance for all users on startup
    for (const [userId, user] of this.userStates.entries()) {
        const balances = await this.getWalletBalance();
        
        this.logger.info('Syncing wallet balance on startup', {
            userId,
            trackedBalance: user.currentBalance,
            walletBalance: balances.trading,
            sol: balances.sol,
            wsol: balances.wsol,
            usdc: balances.usdc
        });
        
        // If user has no balance set or it's the default, use wallet balance
        if (user.currentBalance === 0 || user.startingBalance === 20) {
            user.startingBalance = balances.trading;
            user.currentBalance = balances.trading;
            user.dailyStartBalance = balances.trading;
            user.tradingCapital = balances.trading;
            
            this.logger.info('User balance initialized from wallet', {
                userId,
                balance: balances.trading.toFixed(4)
            });
        } else {
            // Always sync to actual wallet (recommended for accuracy)
            user.currentBalance = balances.trading;
            user.tradingCapital = balances.trading;
            
            const difference = balances.trading - user.currentBalance;
            if (Math.abs(difference) > 0.01) {
                this.logger.warn('Balance mismatch detected', {
                    userId,
                    tracked: user.currentBalance.toFixed(4),
                    actual: balances.trading.toFixed(4),
                    difference: difference.toFixed(4)
                });
            }
        }
    }
    
    if (this.anomalyDetector) {
        for (const [userId, user] of this.userStates.entries()) {
            if (user.isActive) {
                await this.anomalyDetector.updateBaseline(userId);
            }
        }
    }
    
    this.logger.info('Trading engine initialized');
}


 
async getWalletBalance() {
    try {
        console.log('\n' + '='.repeat(60));
        console.log('FETCHING WALLET BALANCE');
        console.log('='.repeat(60));
        
        // Get native SOL balance
        const operation = async (conn) => {
            const balance = await conn.getBalance(this.wallet.publicKey);
            return balance / LAMPORTS_PER_SOL;
        };

        const solBalance = await this.rpcConnection.executeWithFallback(operation, 'getWalletBalance');
        
        console.log('\nNative SOL Balance:', solBalance.toFixed(4));
        
        this.logger.info('Native SOL balance fetched', { 
            sol: solBalance.toFixed(4),
            lamports: Math.floor(solBalance * LAMPORTS_PER_SOL)
        });
        
        // Get all token accounts
        const tokenBalances = await this.getAllTokenBalances();
        
        console.log('\nAll Token Balances:');
        tokenBalances.forEach(t => {
            if (t.balance > 0) {
                console.log(`  ${t.symbol}: ${t.balance.toFixed(4)}`);
            }
        });
        
        // Find specific tokens
        const usdcBalance = tokenBalances.find(t => 
            t.mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' ||
            t.symbol === 'USDC'
        )?.balance || 0;
        
        const wsolBalance = tokenBalances.find(t => 
            t.mint === 'So11111111111111111111111111111111111111112' ||
            t.symbol === 'WSOL'
        )?.balance || 0;
        
        console.log('\nDetected Balances:');
        console.log('  Native SOL:', solBalance.toFixed(4));
        console.log('  Wrapped SOL:', wsolBalance.toFixed(4));
        console.log('  USDC:', usdcBalance.toFixed(4));
        console.log('  Total SOL:', (solBalance + wsolBalance).toFixed(4));
        
        const totalSol = solBalance + wsolBalance;
        const tradingBalance = usdcBalance > 0.01 ? usdcBalance : totalSol;
        
        console.log('\nTrading Balance:', tradingBalance.toFixed(4), usdcBalance > 0.01 ? 'USDC' : 'SOL');
        console.log('='.repeat(60) + '\n');
        
        this.logger.info('Token balances fetched', { 
            usdc: usdcBalance.toFixed(2),
            wsol: wsolBalance.toFixed(4),
            totalTokens: tokenBalances.length,
            trading: tradingBalance.toFixed(4)
        });
        
        return {
            sol: solBalance,
            wsol: wsolBalance,
            totalSol: totalSol,
            usdc: usdcBalance,
            trading: tradingBalance,
            allTokens: tokenBalances.filter(t => t.balance > 0)
        };
        
    } catch (error) {
        console.error('BALANCE FETCH ERROR:', error);
        this.logger.error('Failed to get wallet balance', { 
            error: error.message,
            stack: error.stack
        });
        return { 
            sol: 0, 
            wsol: 0,
            totalSol: 0,
            usdc: 0, 
            trading: 0,
            allTokens: []
        };
    }
}

async getAllTokenBalances() {
    try {
        const operation = async (conn) => {
            // Get all token accounts owned by this wallet
            const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');
            const tokenAccounts = await conn.getParsedTokenAccountsByOwner(
                this.wallet.publicKey,
                { programId: TOKEN_PROGRAM_ID }
            );

            const balances = [];
            
            for (const account of tokenAccounts.value) {
                const parsedInfo = account.account.data.parsed.info;
                const mintAddress = parsedInfo.mint;
                const balance = parsedInfo.tokenAmount.uiAmount || 0;
                const decimals = parsedInfo.tokenAmount.decimals;
                
                // Only include non-zero balances
                if (balance > 0) {
                    balances.push({
                        mint: mintAddress,
                        balance: balance,
                        decimals: decimals,
                        symbol: this.getTokenSymbol(mintAddress)
                    });
                }
            }
            
            return balances;
        };

        const balances = await this.rpcConnection.executeWithFallback(operation, 'getAllTokenBalances');
        
        this.logger.info('All token accounts fetched', { 
            count: balances.length,
            tokens: balances.map(b => `${b.symbol}: ${b.balance.toFixed(4)}`)
        });
        
        return balances;
        
    } catch (error) {
        this.logger.error('Failed to get all token balances', { 
            error: error.message
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
      return this.tradeMutex.runExclusive(async () => {
          if (this.isScanning) {
              this.logger.debug('Already scanning, skipping cycle');
              return;
          }

          if (!this.hasActiveUsers()) {
              this.logger.debug('No active users');
              return;
          }

          // Check circuit breaker
          if (!this.circuitBreaker.canTrade()) {
              const status = this.circuitBreaker.getStatus();
              this.logger.warn('Circuit breaker active', status);
              return;
          }

          this.isScanning = true;

          try {
              this.logger.info('=== Trading Cycle Start ===');

              const userId = this.bot.ownerId || (AUTHORIZED_USERS.length > 0 ? AUTHORIZED_USERS[0] : null);
              if (!userId) {
                  this.logger.error('No authorized user configured');
                  return;
              }

              const user = this.getUserState(userId);
              if (!user.isActive) {
                  this.logger.debug('User not active');
                  return;
              }

              await this.checkDailyReset(user, userId);

              if (this.isDailyTargetHit(user)) {
                  this.logger.info('Daily target hit, in cooldown');
                  return;
              }

              // Check if can add more positions
              if (!this.portfolioManager.canAddPosition()) {
                  this.logger.info('Maximum positions reached, monitoring only');
                  return;
              }

              const opportunity = await this.findTradingOpportunity(userId);
              if (opportunity) {
                  this.logger.info('Opportunity found', { symbol: opportunity.symbol });
                  await this.executeBuy(userId, opportunity);
              } else {
                  this.logger.info('No trade opportunity');
              }

              const stats = this.bitquery.getStats();
              this.logger.debug('API stats', stats);

          } catch (err) {
              this.logger.error('Trading cycle error', { error: err.message, stack: err.stack });
          } finally {
              this.isScanning = false;
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

  async findTradingOpportunity(userId) {
      try {
          this.logger.info('=== Token Scan Start ===');
          const candidates = await this.bitquery.getGraduatingTokens();
  
          if (!candidates.length) {
              this.logger.info('No candidates found');
              return null;
          }

          this.logger.info('Analyzing candidates', { count: Math.min(candidates.length, MAX_CANDIDATES_TO_ANALYZE) });
  
          const tokensToAnalyze = candidates.slice(0, MAX_CANDIDATES_TO_ANALYZE);

          for (const token of tokensToAnalyze) {
              this.logger.debug('Checking token', { symbol: token.symbol, bonding: token.bondingProgress.toFixed(1) });
  
              // Volume check
              const volume = await this.bitquery.getVolumeHistory(token.address);
              if (!volume.spike) {
                  this.logger.debug('No volume spike', { symbol: token.symbol });
                  continue;
              }
  
              // Whale check
              const whaleDump = await this.bitquery.detectWhaleDumps(token.address);
              if (whaleDump) {
                  this.logger.debug('Whale dump detected', { symbol: token.symbol });
                  continue;
              }

              // Technical analysis (if enabled)
              if (ENABLE_TECHNICAL_ANALYSIS && this.technicalIndicators) {
                  const analysis = this.technicalIndicators.analyzeToken(token.address);
                  if (analysis && analysis.score < 60) {
                      this.logger.debug('Technical score too low', { symbol: token.symbol, score: analysis.score });
                      continue;
                  }
              }
  
              this.logger.info('🎯 SIGNAL FOUND', { symbol: token.symbol, bonding: token.bondingProgress.toFixed(1) });
  
              return {
                  ...token,
                  volumeRecent: volume.recent,
                  volumePrevious: volume.previous,
                  volumeSpike: volume.previous > 0 ? (volume.recent / volume.previous) : Infinity
              };
          }
  
          this.logger.info('No tokens passed filters');
          return null;
      } catch (err) {
          this.logger.error('Scanner error', { error: err.message });
          return null;
      }
  }

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
  const user = this.getUserState(userId);
  
  try {
      this.logger.info('Executing buy', { token: token.symbol });

      // Check if paper trading
      if (ENABLE_PAPER_TRADING) {
          return await this.executePaperBuy(userId, token);
      }

      const positionSize = this.calculatePositionSize(user, token.liquidityUSD);
      const amountUSDC = Math.floor(positionSize * 1_000_000);
      
      if (amountUSDC <= 0 || positionSize > user.currentBalance) {
          throw new Error('Insufficient balance for buy');
      }

      // Get best quote from multiple DEXes
      let quote;
      if (ENABLE_MULTI_DEX && this.dexAggregator) {
          quote = await this.dexAggregator.getBestQuote(USDC_MINT, token.address, amountUSDC);
      } else {
          const slippageBps = this.calculateSlippage(token.liquidityUSD);
          quote = await this.getJupiterQuote(USDC_MINT, token.address, amountUSDC, slippageBps);
      }

      if (!quote) {
          throw new Error('No quote available');
      }

      const expectedTokens = parseFloat(quote.outAmount) / (10 ** 9);
      const isHotLaunch = token.bondingProgress >= 96;

      // Calculate priority fee
      const priorityFeeLamports = await this.priorityFeeCalculator.calculateOptimalFee(
          isHotLaunch, 
          isHotLaunch ? 'high' : 'normal'
      );

      this.logger.info('Quote received', { 
          inAmount: quote.inAmount, 
          outAmount: quote.outAmount,
          dex: quote.dex || 'Jupiter',
          priorityFee: priorityFeeLamports
      });

      // Execute swap with MEV protection
      const tx = await this.executeSwap(quote, priorityFeeLamports);
      if (!tx.success) {
          throw new Error(`Swap failed: ${tx.error}`);
      }

      const tokensReceived = expectedTokens;
      const usdcSpent = parseFloat(quote.inAmount) / 1000000;
      const entryPrice = usdcSpent / tokensReceived;
      
      const strategy = this.getActiveStrategy();
      
      const position = {
          tokenAddress: token.address,
          symbol: token.symbol,
          entryPrice,
          entryTime: Date.now(),
          tokensOwned: tokensReceived,
          investedUSDC: usdcSpent,
          targetPrice: entryPrice * (1 + strategy.perTradeTarget),
          stopLossPrice: entryPrice * (1 - strategy.stopLoss),
          scalpMode: true,
          txSignature: tx.signature,
          bondingProgress: token.bondingProgress,
          liquidityUSD: token.liquidityUSD,
          tokenDecimals: 9,
          positionSizeMode: POSITION_SIZE_MODE
      };
      
      user.position = position;
      user.currentBalance -= usdcSpent;

      // Add to portfolio
      this.portfolioManager.addPosition(token.address, position);

      // Save to database
      if (this.database) {
          await this.database.createPosition(userId, position);
      }

      await this.saveState();

      await this.bot.sendMessage(userId, this.formatBuyMessage(position, token, user), {
          parse_mode: 'HTML'
      });

      this.logger.info('Buy executed successfully', { 
          symbol: token.symbol, 
          price: entryPrice.toFixed(8),
          amount: usdcSpent.toFixed(2)
      });

      return true;

  } catch (error) {
      this.logger.error('Buy execution failed', { error: error.message, stack: error.stack });
      await this.bot.sendMessage(userId, `❌ <b>Buy Failed</b>\n\n${error.message}`, {
          parse_mode: 'HTML'
      }).catch(err => this.logger.error('Failed to send error message', { error: err.message }));
      return false;
  }
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
    const user = this.getUserState(userId);
    const pos = user.position;

    try {
        this.logger.info('Executing sell', { symbol: pos.symbol, reason, price: currentPrice });

        // Paper trading
        if (ENABLE_PAPER_TRADING || pos.isPaperTrade) {
            return await this.executePaperSell(userId, reason, currentPrice);
        }

        const tokenDecimals = pos.tokenDecimals || 9;
        const amountTokens = Math.floor(pos.tokensOwned * (10 ** tokenDecimals));

        if (amountTokens <= 0) {
            throw new Error('Insufficient token balance for sell');
        }

        // Get best sell quote
        let quote;
        if (ENABLE_MULTI_DEX && this.dexAggregator) {
            quote = await this.dexAggregator.getBestQuote(pos.tokenAddress, USDC_MINT, amountTokens);
        } else {
            const slippageBps = this.calculateSlippage(pos.liquidityUSD || 10000);
            quote = await this.getJupiterQuote(pos.tokenAddress, USDC_MINT, amountTokens, slippageBps);
        }

        if (!quote) throw new Error('No sell quote available');

        const priorityFeeLamports = await this.priorityFeeCalculator.calculateOptimalFee(false, 'normal');

        const tx = await this.executeSwap(quote, priorityFeeLamports);
        if (!tx.success) throw new Error(`Sell swap failed: ${tx.error}`);

        const usdcReceived = parseFloat(quote.outAmount) / 1_000_000;
        const profit = usdcReceived - pos.investedUSDC;
        const profitPercent = (profit / pos.investedUSDC) * 100;

        user.currentBalance += usdcReceived;
        user.dailyProfit += profit;
        user.dailyProfitPercent = ((user.currentBalance - user.dailyStartBalance) / user.dailyStartBalance) * 100;
        user.totalTrades += 1;
        if (profit > 0) user.successfulTrades += 1;
        user.lastTradeAt = Date.now();

        const trade = {
            ...pos,
            exitPrice: currentPrice,
            exitTime: Date.now(),
            usdcReceived,
            profit,
            profitPercent,
            reason,
            sellTxSignature: tx.signature,
            holdTimeMinutes: ((Date.now() - pos.entryTime) / 60000).toFixed(1)
        };

        user.tradeHistory.push(trade);
        user.position = null;

        // Remove from portfolio
        this.portfolioManager.removePosition(pos.tokenAddress);

        // ===== REFRESH WALLET BALANCE AFTER TRADE =====
        const updatedBalances = await this.getWalletBalance();
        this.logger.info('Wallet balance refreshed after sell', {
            beforeTrade: user.currentBalance.toFixed(4),
            actualWallet: updatedBalances.trading.toFixed(4),
            profit: profit.toFixed(4)
        });
        
        // Sync tracked balance with actual wallet balance
        // This ensures we're always using real on-chain data
        user.currentBalance = updatedBalances.trading;
        user.tradingCapital = updatedBalances.trading;

        // Save to database
        if (this.database) {
            await this.database.recordTrade(userId, {
                tokenAddress: trade.tokenAddress,
                symbol: trade.symbol,
                entryPrice: trade.entryPrice,
                exitPrice: trade.exitPrice,
                entryTime: trade.entryTime,
                exitTime: trade.exitTime,
                tokensOwned: trade.tokensOwned,
                investedUSDC: trade.investedUSDC,
                usdcReceived: trade.usdcReceived,
                profit: trade.profit,
                profitPercent: trade.profitPercent,
                reason: trade.reason,
                buyTxSignature: trade.txSignature,
                sellTxSignature: trade.sellTxSignature,
                holdTimeMinutes: parseFloat(trade.holdTimeMinutes),
                bondingProgress: trade.bondingProgress,
                liquidityUSD: trade.liquidityUSD,
                wasPaperTrade: false
            });
        }

        this.performanceTracker.recordTrade(profit, profitPercent);
        this.circuitBreaker.recordTrade(profit > 0);
        
        if (this.anomalyDetector) {
            this.anomalyDetector.addTrade(trade);
            await this.anomalyDetector.detectAllAnomalies(userId, trade);
        }
        
        await this.checkStrategyAdjustment(userId);
        await this.saveState();

        // Enhanced sell message with updated balance
        await this.bot.sendMessage(userId, this.formatSellMessageWithBalance(trade, user, updatedBalances), {
            parse_mode: 'HTML'
        }).catch(err => this.logger.error('Failed to send sell message', { error: err.message }));

        if (this.isDailyTargetHit(user)) {
            const target = user.dailyProfitPercent >= DAILY_PROFIT_TARGET ? 'PROFIT TARGET' : 'STOP LOSS';
            await this.bot.sendMessage(userId, this.formatDailyTargetMessage(user, target), {
                parse_mode: 'HTML'
            }).catch(err => this.logger.error('Failed to send target message', { error: err.message }));
        }

        this.logger.info('Sell executed successfully', { 
            symbol: pos.symbol, 
            profit: profitPercent.toFixed(2) + '%',
            newBalance: user.currentBalance.toFixed(4)
        });

        return true;

    } catch (error) {
        this.logger.error('Sell execution failed', { error: error.message, stack: error.stack });
        await this.bot.sendMessage(userId, `❌ <b>Sell Failed</b>\n\n${error.message}`, {
            parse_mode: 'HTML'
        }).catch(err => this.logger.error('Failed to send error message', { error: err.message }));
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
// Add to TradingEngine.findTradingOpportunity() - around line 1150
async findTradingOpportunity(userId) {
    try {
        console.log('\n' + '='.repeat(60));
        console.log('🔍 SCANNING FOR OPPORTUNITIES');
        console.log('='.repeat(60));
        
        this.logger.info('=== Token Scan Start ===');
        const candidates = await this.bitquery.getGraduatingTokens();

        if (!candidates.length) {
            console.log('❌ No candidates found');
            this.logger.info('No candidates found');
            return null;
        }

        console.log(`✅ Found ${candidates.length} graduating tokens`);
        console.log('\nTop Candidates:');
        candidates.slice(0, 5).forEach((token, i) => {
            console.log(`  ${i+1}. ${token.symbol} - ${token.bondingProgress.toFixed(1)}% bonding, $${token.liquidityUSD.toFixed(0)} liquidity`);
        });
        console.log('');

        this.logger.info('Analyzing candidates', { count: Math.min(candidates.length, MAX_CANDIDATES_TO_ANALYZE) });

        const tokensToAnalyze = candidates.slice(0, MAX_CANDIDATES_TO_ANALYZE);

        for (const token of tokensToAnalyze) {
            console.log(`\n🔍 Analyzing: ${token.symbol}`);
            console.log(`   Bonding: ${token.bondingProgress.toFixed(1)}%`);
            console.log(`   Liquidity: $${token.liquidityUSD.toFixed(0)}`);
            
            this.logger.debug('Checking token', { symbol: token.symbol, bonding: token.bondingProgress.toFixed(1) });

            // Volume check
            console.log(`   Checking volume...`);
            const volume = await this.bitquery.getVolumeHistory(token.address);
            console.log(`   Recent: $${volume.recent.toFixed(0)}, Previous: $${volume.previous.toFixed(0)}`);
            console.log(`   Volume Spike: ${volume.spike ? '✅ YES' : '❌ NO'}`);
            
            if (!volume.spike) {
                console.log(`   ❌ Rejected: No volume spike`);
                this.logger.debug('No volume spike', { symbol: token.symbol });
                continue;
            }

            // Whale check
            console.log(`   Checking for whale dumps...`);
            const whaleDump = await this.bitquery.detectWhaleDumps(token.address);
            console.log(`   Whale Dump: ${whaleDump ? '❌ YES' : '✅ NO'}`);
            
            if (whaleDump) {
                console.log(`   ❌ Rejected: Whale dump detected`);
                this.logger.debug('Whale dump detected', { symbol: token.symbol });
                continue;
            }

            // Technical analysis
            if (ENABLE_TECHNICAL_ANALYSIS && this.technicalIndicators) {
                console.log(`   Running technical analysis...`);
                const analysis = this.technicalIndicators.analyzeToken(token.address);
                if (analysis && analysis.score < 60) {
                    console.log(`   ❌ Rejected: Technical score too low (${analysis.score})`);
                    this.logger.debug('Technical score too low', { symbol: token.symbol, score: analysis.score });
                    continue;
                }
                console.log(`   ✅ Technical score: ${analysis?.score || 'N/A'}`);
            }

            console.log('\n🎯 ✅ TRADE SIGNAL FOUND!');
            console.log(`   Token: ${token.symbol}`);
            console.log(`   Bonding: ${token.bondingProgress.toFixed(1)}%`);
            console.log(`   Liquidity: $${token.liquidityUSD.toFixed(0)}`);
            console.log(`   Volume Spike: ${(volume.recent / volume.previous).toFixed(2)}x`);
            console.log('='.repeat(60) + '\n');

            this.logger.info('🎯 SIGNAL FOUND', { symbol: token.symbol, bonding: token.bondingProgress.toFixed(1) });

            return {
                ...token,
                volumeRecent: volume.recent,
                volumePrevious: volume.previous,
                volumeSpike: volume.previous > 0 ? (volume.recent / volume.previous) : Infinity
            };
        }

        console.log('❌ No tokens passed all filters');
        console.log('='.repeat(60) + '\n');
        this.logger.info('No tokens passed filters');
        return null;
    } catch (err) {
        console.error('❌ Scanner error:', err.message);
        this.logger.error('Scanner error', { error: err.message });
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
      const payload = {
          quoteResponse: quoteResponse.route || quoteResponse,
          userPublicKey: this.wallet.publicKey.toString(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: priorityFeeLamports
      };

      const res = await fetchWithTimeout(`${JUPITER_API_URL}/swap`, {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'Content-Type': 'application/json' }
      }, JUPITER_SWAP_TIMEOUT);

      if (!res.ok) {
          throw new Error(`Swap request failed: ${res.status}`);
      }

      const data = await res.json();
      if (!data || !data.swapTransaction) {
          throw new Error('No swapTransaction in response');
      }

      const txBuffer = Buffer.from(data.swapTransaction, 'base64');
      let transaction = VersionedTransaction.deserialize(txBuffer);
      
      // Apply MEV protection
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
      this.logger.info('Swap successful', { signature });
      return { success: true, signature };

  } catch (err) {
      this.logger.error('Swap execution error', { error: err.message, stack: err.stack });
      return { success: false, error: err.message };
  }
}

calculateSlippage(liquidityUSD) {
  if (liquidityUSD >= 50000) return 300;
  if (liquidityUSD >= 20000) return 500;
  if (liquidityUSD >= 10000) return 800;
  return 1200;
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
├ Take Profit: $${pos.targetPrice.toFixed(8)} (+${((pos.targetPrice/pos.entryPrice - 1) * 100).toFixed(1)}%)
└ Stop Loss: $${pos.stopLossPrice.toFixed(8)} (${((pos.stopLossPrice/pos.entryPrice - 1) * 100).toFixed(1)}%)

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
├ Change: ${((trade.exitPrice/trade.entryPrice - 1) * 100).toFixed(2)}%
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

formatBuyMessage(pos, token, user) {
  return `
🚀 <b>BUY EXECUTED</b>

<b>Token:</b> ${pos.symbol}
<b>Entry Price:</b> $${pos.entryPrice.toFixed(8)}
<b>Position Size:</b> ${pos.investedUSDC.toFixed(2)} USDC
<b>Tokens:</b> ${pos.tokensOwned.toFixed(4)}

📊 <b>Market Data:</b>
Bonding: ${token.bondingProgress.toFixed(1)}%
Liquidity: $${token.liquidityUSD.toFixed(0)}

🎯 <b>Targets:</b>
Scalp: ${(this.getActiveStrategy().scalpMin * 100).toFixed(0)}-${(this.getActiveStrategy().scalpMax * 100).toFixed(0)}%
Extended: ${(this.getActiveStrategy().extendedTarget * 100).toFixed(0)}%
Stop: -${(this.getActiveStrategy().stopLoss * 100).toFixed(0)}%

💼 <b>Balance:</b> ${user.currentBalance.toFixed(2)} USDC

📝 <b>TX:</b> <code>${pos.txSignature}</code>
  `.trim();
}

formatSellMessage(trade, user) {
  const emoji = trade.profit > 0 ? '✅' : '❌';
  const reasonLabels = {
      'scalp_profit': '🎯 Scalp Profit',
      'extended_profit': '💰 Extended Profit',
      'stop_loss': '🛑 Stop Loss'
  };

  return `
${emoji} <b>${reasonLabels[trade.reason] || trade.reason.toUpperCase()}</b>

<b>Token:</b> ${trade.symbol}
<b>Entry:</b> $${trade.entryPrice.toFixed(8)}
<b>Exit:</b> $${trade.exitPrice.toFixed(8)}
<b>Hold:</b> ${trade.holdTimeMinutes}m

💵 <b>Performance:</b>
Invested: ${trade.investedUSDC.toFixed(2)} USDC
Received: ${trade.usdcReceived.toFixed(2)} USDC
P&L: ${emoji} ${trade.profit.toFixed(2)} (${trade.profitPercent.toFixed(2)}%)

💼 <b>Account:</b>
Balance: ${user.currentBalance.toFixed(2)} USDC
Daily: ${user.dailyProfitPercent >= 0 ? '+' : ''}${user.dailyProfitPercent.toFixed(2)}%

📝 <b>TX:</b> <code>${trade.sellTxSignature}</code>
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
      this.ownerId = AUTHORIZED_USERS.length > 0 ? AUTHORIZED_USERS[0] : null;

      // ============ PRODUCTION POLLING MODE SETUP ============
      console.log('🤖 Bot Configuration:', {
          mode: 'POLLING',
          authorizedUsers: AUTHORIZED_USERS.length,
          scanInterval: SCAN_INTERVAL_MINUTES + 'min',
          environment: process.env.NODE_ENV || 'development'
      });

      logger.info('🔵 Starting in POLLING MODE (Production)');

      // Initialize Telegram Bot with optimized polling settings
      this.bot = new TelegramBot(TELEGRAM_TOKEN, {
          polling: {
              interval: 1000,              // Check every 1 second
              autoStart: true,
              params: {
                  timeout: 30,             // Long polling 30s
                  allowed_updates: ['message']  // Only process messages
              }
          },
          filepath: false                  // Disable file downloads for security
      });

      // Polling error handler with auto-recovery
      this.bot.on('polling_error', (error) => {
          if (error.code === 'EFATAL' || error.code === 'ETELEGRAM') {
              logger.error('Fatal polling error, restarting...', { 
                  code: error.code, 
                  message: error.message 
              });
              this.restartPolling();
          } else {
              logger.warn('Polling error (recoverable)', { 
                  code: error.code, 
                  message: error.message 
              });
          }
      });

      // General bot error handler
      this.bot.on('error', (error) => {
          logger.error('Bot error', { error: error.message });
      });

      // Verify connection to Telegram
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

      // Initialize components
      this.rpcConnection = new RobustConnection(SOLANA_RPC_URL, RPC_FALLBACK_URLS);
      this.wallet = this.loadWallet(PRIVATE_KEY);
      this.database = new DatabaseManager('./data/trading.db');
      this.bitquery = new BitqueryClient(BITQUERY_API_KEY, logger, this.database);
      this.engine = new TradingEngine(this.bot, this.wallet, this.rpcConnection, this.bitquery, this.database);
      
      if (ENABLE_HEALTH_MONITORING) {
          this.healthMonitor = new HealthMonitor(logger, this);
      }

      // Setup memory management
      this.setupMemoryManagement();
  }

async restartPolling() {
  try {
      logger.info('Attempting to restart polling...');
      await this.bot.stopPolling();
      await sleep(3000);  // Wait 3 seconds
      await this.bot.startPolling();
      logger.info('Polling restarted successfully');
  } catch (error) {
      logger.error('Failed to restart polling', { error: error.message });
      // If restart fails, exit and let process manager (PM2/Railway) restart the whole bot
      process.exit(1);
  }
} 

setupMemoryManagement() {
  // Aggressive memory cleanup every 3 minutes
  setInterval(() => {
      const mem = process.memoryUsage();
      const heapPercent = (mem.heapUsed / mem.heapTotal * 100);

      if (heapPercent > 70) {
          logger.warn('High memory usage detected', {
              heapPercent: heapPercent.toFixed(1) + '%',
              heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
              rss: Math.round(mem.rss / 1024 / 1024) + 'MB'
          });

          // Force cleanup
          this.performMemoryCleanup();

          // Force GC if available (run with --expose-gc flag)
          if (heapPercent > 80 && global.gc) {
              global.gc();
              logger.info('Garbage collection triggered');
          }
      }
  }, 3 * 60 * 1000);

  // Regular cleanup every 5 minutes
  setInterval(() => {
      this.performMemoryCleanup();
  }, 5 * 60 * 1000); 

  setInterval(async () => {
    try {
        for (const [userId, user] of this.engine.userStates.entries()) {
            if (!user.isActive) continue;
            
            // Don't sync if user has an active position
            if (user.position) continue;
            
            const balances = await this.engine.getWalletBalance();
            const difference = Math.abs(balances.trading - user.currentBalance);
            
            // Only log significant differences
            if (difference > 0.1) {
                logger.info('Hourly balance sync', {
                    userId,
                    tracked: user.currentBalance.toFixed(4),
                    actual: balances.trading.toFixed(4),
                    difference: difference.toFixed(4)
                });
            }
        }
    } catch (error) {
        logger.error('Hourly balance sync failed', { error: error.message });
    }
}, 60 * 60 * 1000);

  // Log file cleanup every 10 minutes
  setInterval(() => {
      const logFiles = [
          path.join(logDir, 'combined.log'),
          path.join(logDir, 'trades.log')
      ];
      
      logFiles.forEach(file => {
          try {
              if (fs.existsSync(file)) {
                  const stats = fs.statSync(file);
                  if (stats.size > 10 * 1024 * 1024) { // 10MB
                      fs.writeFileSync(file, '');
                      logger.info('Log file cleared due to size', { file });
                  }
              }
          } catch (err) {
              // Ignore errors
          }
      });
  }, 10 * 60 * 1000);
}

performMemoryCleanup() {
  let cleaned = 0;

  // Clear Bitquery cache
  if (this.bitquery && this.bitquery.cache) {
      const size = this.bitquery.cache.size;
      this.bitquery.cache.clear();
      cleaned += size;
  }

  // Trim trade history to last 50 trades
  for (const [userId, user] of this.engine.userStates.entries()) {
      if (user.tradeHistory && user.tradeHistory.length > 50) {
          const removed = user.tradeHistory.length - 50;
          user.tradeHistory = user.tradeHistory.slice(-50);
          cleaned += removed;
      }
  }

  if (cleaned > 0) {
      logger.debug('Memory cleanup completed', { itemsCleaned: cleaned });
  }
}

async init() {
  logger.info('='.repeat(50));
  logger.info('Trading bot initializing... (POLLING MODE)');
  logger.info('='.repeat(50));

  try {
      // Initialize database
      await this.database.init();
      logger.info('✅ Database initialized');

      // Initialize Bitquery
      await this.bitquery.init();
      logger.info('✅ Bitquery initialized');

      // Initialize trading engine
      await this.engine.init();
      logger.info('✅ Trading engine initialized');

      // Setup Telegram commands
      this.setupCommands();
      logger.info('✅ Telegram commands setup');

      // Start health monitoring
      if (ENABLE_HEALTH_MONITORING && this.healthMonitor) {
          this.healthMonitor.start(5);
          logger.info('✅ Health monitoring started');
      }

      // Start trading cycles
      this.startTrading();
      logger.info('✅ Trading cycles started');

      console.log('='.repeat(50));
      console.log('✅ BOT FULLY OPERATIONAL');
      console.log('Mode: POLLING (Production)');
      console.log(`Scan Interval: ${SCAN_INTERVAL_MINUTES}min`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log('='.repeat(50));

      logger.info('✅ Trading bot fully operational');

  } catch (error) {
      console.error('❌ Initialization failed:', error.message);
      logger.error('Initialization failed', { error: error.message, stack: error.stack });
      throw error;
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



async handleStart(userId, chatId) {
    // Use global logger as fallback if this.logger is undefined
    const log = this.logger || logger || console;
    
    try {
        // Step 1: Send acknowledgment
        try {
            await this.sendMessage(chatId, '⏳ Starting bot...');
        } catch (e) {
            log.error('Failed to send init message:', e?.message || String(e));
        }

        // Step 2: Validate dependencies
        if (!this.engine) {
            throw new Error('Trading engine not initialized');
        }
        if (!this.wallet || !this.wallet.publicKey) {
            throw new Error('Wallet not connected');
        }
        if (!this.database) {
            throw new Error('Database not initialized');
        }

        // Step 3: Get user state
        let user;
        try {
            user = this.engine.getUserState(userId);
            if (!user) {
                throw new Error('User state is null');
            }
        } catch (err) {
            throw new Error('Failed to get user state: ' + (err?.message || String(err)));
        }
        
        // Step 4: Get wallet balance
        let balances;
        try {
            balances = await Promise.race([
                this.engine.getWalletBalance(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
            ]);
            
            if (!balances || typeof balances !== 'object') {
                throw new Error('Invalid balance structure');
            }
            
            balances = {
                sol: Number(balances.sol) || 0,
                wsol: Number(balances.wsol) || 0,
                usdc: Number(balances.usdc) || 0,
                trading: Number(balances.trading) || 0,
                totalSol: Number(balances.totalSol) || 0,
                allTokens: Array.isArray(balances.allTokens) ? balances.allTokens : []
            };
            
        } catch (err) {
            log.error('Wallet balance fetch failed:', err?.message || String(err));
            balances = {
                sol: 0, wsol: 0, usdc: 0, trading: 0, totalSol: 0, allTokens: []
            };
        }

        const tradingBalance = Number(balances.trading) || 0;
        
        log.info('Wallet balances for start', {
            sol: balances.sol,
            wsol: balances.wsol,
            usdc: balances.usdc,
            trading: balances.trading,
            allTokens: balances.allTokens.length
        });
        
        // Step 5: Database user
        let dbUser = null;
        try {
            dbUser = await Promise.race([
                this.database.getUser(userId.toString()),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
            ]);
        } catch (err) {
            log.error('Database query failed:', err?.message || String(err));
            dbUser = null;
        }

        // Step 6: Initialize user
        if (!dbUser) {
            user.startingBalance = tradingBalance;
            user.currentBalance = tradingBalance;
            user.dailyStartBalance = tradingBalance;
            user.tradingCapital = tradingBalance;
            
            try {
                await this.database.createUser(userId.toString(), tradingBalance);
                log.info('New user created', { userId, balance: tradingBalance });
            } catch (err) {
                log.error('Failed to create user:', err?.message || String(err));
            }
        } else {
            log.info('Existing user activated', { 
                userId,
                trackedBalance: user.currentBalance || 0,
                walletBalance: tradingBalance
            });
        }

        user.isActive = true;

        // Step 7: Save state
        try {
            await this.engine.saveState();
        } catch (err) {
            log.error('Failed to save state:', err?.message || String(err));
        }

        // Step 8: Get strategy
        let strategy;
        try {
            strategy = this.engine.getActiveStrategy();
            if (!strategy || typeof strategy !== 'object') {
                throw new Error('Invalid strategy');
            }
        } catch (err) {
            log.error('Failed to get strategy:', err?.message || String(err));
            strategy = { scalpMin: 0.05, scalpMax: 0.15, extendedTarget: 0.30 };
        }

        // Step 9: Build message
        const modeText = ENABLE_PAPER_TRADING ? '📝 PAPER TRADING MODE' : '💰 LIVE TRADING MODE';
        const balanceLines = [];
        
        if (balances.sol > 0.001) balanceLines.push(`SOL: ${balances.sol.toFixed(4)}`);
        if (balances.wsol > 0.001) balanceLines.push(`Wrapped SOL: ${balances.wsol.toFixed(4)}`);
        if (balances.usdc > 0.01) balanceLines.push(`USDC: ${balances.usdc.toFixed(2)}`);
        
        const otherTokens = balances.allTokens.filter(t => 
            t && t.symbol && t.symbol !== 'USDC' && t.symbol !== 'WSOL' && t.symbol !== 'SOL'
        );
        
        if (otherTokens.length > 0) {
            otherTokens.slice(0, 5).forEach(token => {
                if (token && token.symbol && token.balance) {
                    balanceLines.push(`${token.symbol}: ${Number(token.balance).toFixed(4)}`);
                }
            });
            if (otherTokens.length > 5) {
                balanceLines.push(`... and ${otherTokens.length - 5} more`);
            }
        }
        
        const balanceDisplay = balanceLines.length > 0 ? balanceLines.join('\n') : 'No tokens found';
        const walletAddress = this.wallet.publicKey.toString();
        const shortAddress = `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`;

        const message = `
🤖 <b>AUTO-TRADING ACTIVATED</b>
${modeText}

📊 <b>Strategy:</b>
- Pump.fun ${MIN_BONDING_PROGRESS}-${MAX_BONDING_PROGRESS}% bonding
- Volume spike ${VOLUME_SPIKE_MULTIPLIER}x
- Scalp ${(strategy.scalpMin * 100).toFixed(0)}-${(strategy.scalpMax * 100).toFixed(0)}% (0-${EXTENDED_HOLD_MINUTES}min)
- Extended ${(strategy.extendedTarget * 100).toFixed(0)}% (${EXTENDED_HOLD_MINUTES}min+)

🎯 <b>Daily Targets:</b>
Profit: +${(DAILY_PROFIT_TARGET * 100).toFixed(0)}%
Stop: -${(DAILY_STOP_LOSS * 100).toFixed(0)}%

⚙️ <b>Features:</b>
Multi-DEX: ${ENABLE_MULTI_DEX ? '✅' : '❌'}
MEV Protection: ${ENABLE_MEV_PROTECTION ? '✅' : '❌'}
Technical Analysis: ${ENABLE_TECHNICAL_ANALYSIS ? '✅' : '❌'}
Health Monitor: ${ENABLE_HEALTH_MONITORING ? '✅' : '❌'}
Anomaly Detection: ${ENABLE_ANOMALY_DETECTION ? '✅' : '❌'}

💼 <b>Account:</b>
Wallet: <code>${shortAddress}</code>
${balanceDisplay}
Trading Balance: ${tradingBalance.toFixed(4)}
Day: ${user.currentDay || 1}
Scan Interval: ${SCAN_INTERVAL_MINUTES}min

🚀 Bot is scanning for opportunities...
Use /help for commands
        `.trim();

        await this.sendMessage(chatId, message, { parse_mode: 'HTML' });
        log.info('User activated bot successfully', { userId });

    } catch (error) {
        const safeError = error || new Error('Unknown error occurred');
        const errorMessage = safeError.message || String(safeError);
        const errorStack = safeError.stack || 'No stack trace';
        
        // Use the same log variable for consistency
        const log = this.logger || logger || console;
        
        if (log && typeof log.error === 'function') {
            log.error('Critical error in handleStart:', {
                error: errorMessage,
                stack: errorStack,
                userId: userId || 'unknown',
                chatId: chatId || 'unknown'
            });
        } else {
            console.error('Critical error in handleStart:', {
                error: errorMessage,
                stack: errorStack,
                userId: userId || 'unknown',
                chatId: chatId || 'unknown'
            });
        }

        const errorMsg = `❌ <b>Failed to start bot</b>\n\n${errorMessage}\n\nPlease try again or contact support.`;
        
        try {
            await this.sendMessage(chatId, errorMsg, { parse_mode: 'HTML' });
        } catch (sendError) {
            try {
                await this.sendMessage(chatId, '❌ Failed to start bot. Please try again.');
            } catch (finalError) {
                if (log && typeof log.error === 'function') {
                    log.error('Complete send failure');
                } else {
                    console.error('Complete send failure');
                }
            }
        }
    }
}

async handleWallet(userId, chatId) {
    try {
        // Get real-time wallet balance
        const balances = await this.engine.getWalletBalance();
        
        const walletAddress = this.wallet.publicKey.toString();
        const explorerUrl = `https://solscan.io/account/${walletAddress}`;
        
        // Format balances nicely with 4-5 decimals
        const formatBalance = (amount, decimals = 4) => {
            if (amount === 0) return '0';
            if (amount < 0.0001) return amount.toExponential(2);
            return amount.toFixed(decimals);
        };
        
        // Build token list
        let tokenList = [];
        
        // Native SOL
        if (balances.sol > 0) {
            tokenList.push({
                symbol: 'SOL',
                balance: balances.sol,
                formatted: formatBalance(balances.sol, 4),
                emoji: '◎'
            });
        }
        
        // Wrapped SOL
        if (balances.wsol > 0) {
            tokenList.push({
                symbol: 'WSOL',
                balance: balances.wsol,
                formatted: formatBalance(balances.wsol, 4),
                emoji: '🔄'
            });
        }
        
        // USDC
        if (balances.usdc > 0) {
            tokenList.push({
                symbol: 'USDC',
                balance: balances.usdc,
                formatted: formatBalance(balances.usdc, 2),
                emoji: '💵'
            });
        }
        
        // Other tokens
        const otherTokens = balances.allTokens.filter(t => 
            t.symbol !== 'USDC' && 
            t.symbol !== 'WSOL' && 
            t.symbol !== 'SOL'
        );
        
        otherTokens.forEach(token => {
            tokenList.push({
                symbol: token.symbol,
                balance: token.balance,
                formatted: formatBalance(token.balance, 4),
                emoji: '🪙'
            });
        });
        
        // Build message
        let message = `
👛 <b>WALLET OVERVIEW</b>

📍 <b>Address:</b>
<code>${walletAddress}</code>

💰 <b>Balances:</b>
`;
        
        if (tokenList.length > 0) {
            tokenList.forEach(token => {
                message += `${token.emoji} <b>${token.symbol}:</b> ${token.formatted}\n`;
            });
            
            // Show total in preferred currency
            const tradingCurrency = balances.usdc > 0.01 ? 'USDC' : 'SOL';
            const tradingAmount = balances.trading;
            message += `\n💼 <b>Trading Balance:</b> ${formatBalance(tradingAmount, 4)} ${tradingCurrency}`;
        } else {
            message += `No tokens found in wallet`;
        }
        
        message += `

🔍 <b>Explorer:</b>
<a href="${explorerUrl}">View on Solscan</a>

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
            tokenCount: tokenList.length
        });
        
    } catch (error) {
        logger.error('Wallet command failed', { 
            userId,
            error: error.message 
        });
        
        await this.sendMessage(chatId, 
            `❌ Failed to fetch wallet info: ${error.message}`,
            { parse_mode: 'HTML' }
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
  
      const stats = this.bitquery.getStats();
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
    const user = this.engine.getUserState(userId);
    
    // Get real-time wallet balance
    const balances = await this.engine.getWalletBalance();
    const tradingBalance = balances.trading;
    
    const todayTrades = user.tradeHistory.filter(t => t.exitTime > user.dailyResetAt).length;
    const winningToday = user.tradeHistory.filter(t => t.exitTime > user.dailyResetAt && t.profit > 0).length;
    const profitToday = user.tradeHistory.filter(t => t.exitTime > user.dailyResetAt).reduce((sum, t) => sum + t.profit, 0);

    let profitInfo = '';
    if (ENABLE_PROFIT_TAKING && user.totalProfitTaken > 0) {
        profitInfo = `
💰 <b>Profit Taking:</b>
Secured: ${user.totalProfitTaken.toFixed(2)}
Combined: ${(tradingBalance + user.totalProfitTaken).toFixed(2)}
`;
    }
    
    const walletAddress = this.wallet.publicKey.toString();
    const shortAddress = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-6)}`;
    
    // Build detailed balance display
    let walletBalances = [];
    if (balances.sol > 0.001) {
        walletBalances.push(`Native SOL: ${balances.sol.toFixed(4)}`);
    }
    if (balances.wsol > 0.001) {
        walletBalances.push(`Wrapped SOL: ${balances.wsol.toFixed(4)}`);
    }
    if (balances.totalSol > 0.001) {
        walletBalances.push(`<b>Total SOL: ${balances.totalSol.toFixed(4)}</b>`);
    }
    if (balances.usdc > 0.01) {
        walletBalances.push(`<b>USDC: ${balances.usdc.toFixed(2)}</b>`);
    }
    
    // Show other tokens
    const otherTokens = balances.allTokens.filter(t => 
        t.symbol !== 'USDC' && 
        t.symbol !== 'WSOL' && 
        t.symbol !== 'SOL'
    );
    
    if (otherTokens.length > 0) {
        walletBalances.push('\n<b>Other Tokens:</b>');
        otherTokens.forEach(token => {
            walletBalances.push(`${token.symbol}: ${token.balance.toFixed(4)}`);
        });
    }
    
    await this.sendMessage(chatId, `
💼 <b>BALANCE OVERVIEW</b>

🏦 <b>Wallet:</b>
Address: <code>${shortAddress}</code>
${walletBalances.join('\n')}

📊 <b>Trading:</b>
Trading Balance: ${tradingBalance.toFixed(4)}
Starting: ${user.startingBalance.toFixed(4)}
Current Tracked: ${user.currentBalance.toFixed(4)}
Daily Start: ${user.dailyStartBalance.toFixed(4)}

📈 <b>Daily Performance:</b>
P&L: ${user.dailyProfitPercent >= 0 ? '📈 +' : '📉 '}${user.dailyProfitPercent.toFixed(2)}%
Profit: ${profitToday >= 0 ? '+' : ''}${profitToday.toFixed(4)}
Target: ${(DAILY_PROFIT_TARGET * 100).toFixed(0)}%
${profitInfo}
📊 <b>Trading Stats:</b>
Today: ${todayTrades} trades (${winningToday} wins)
Total: ${user.totalTrades} trades
Win Rate: ${user.totalTrades > 0 ? ((user.successfulTrades / user.totalTrades) * 100).toFixed(1) : 0}%

<b>Day ${user.currentDay}</b> of 30-day challenge
    `.trim(), { parse_mode: 'HTML' });

    logger.info('Balance checked', { 
        userId, 
        sol: balances.sol,
        wsol: balances.wsol,
        usdc: balances.usdc,
        trading: tradingBalance
    });
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
      const stats = this.bitquery.getStats();
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
          const stats = this.bitquery.getStats();
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
      logger.info('Starting trading cycles...');

      // Position monitoring (every 30s)
      setInterval(async () => {
          if (!this.engine.hasActiveUsers()) return;
          
          for (const [userId, user] of this.engine.userStates.entries()) {
              if (user.isActive && user.position) {
                  try {
                      await this.engine.monitorPosition(userId);
                  } catch (error) {
                      logger.error('Monitor error', { error: error.message });
                  }
              }
          }
      }, 30000);
      


      // Scanning cycle (configurable interval)
      const scanIntervalMs = SCAN_INTERVAL_MINUTES * 60 * 1000;
      setInterval(async () => {
          try {
              await this.engine.tradingCycle();
          } catch (error) {
              logger.error('Trading cycle error', { error: error.message });
          }
      }, scanIntervalMs);

      // Periodic state save (every 5 minutes)
      setInterval(async () => {
          try {
              await this.engine.saveState();
          } catch (error) {
              logger.error('State save failed', { error: error.message });
          }
      }, 5 * 60 * 1000);



      // Database cleanup (daily)
      setInterval(async () => {
          try {
              await this.database.cleanupOldData(90);
              logger.info('Database cleanup completed');
          } catch (error) {
              logger.error('Database cleanup failed', { error: error.message });
          }
      }, 24 * 60 * 60 * 1000);

      logger.info(`Trading cycles active - Monitor: 30s, Scan: ${SCAN_INTERVAL_MINUTES}min`);
  }

  async shutdown() {
      logger.info('Initiating graceful shutdown...');
      
      try {
          // Stop polling first
          await this.bot.stopPolling();
          logger.info('Polling stopped');

          // Save current state
          await this.engine.saveState();
          logger.info('State saved');

          // Stop health monitoring
          if (this.healthMonitor) {
              this.healthMonitor.stop();
              logger.info('Health monitor stopped');
          }

          // Close database
          if (this.database) {
              await this.database.close();
              logger.info('Database closed');
          }

          // Final stats
          const stats = this.bitquery.getStats();
          logger.info('Final API stats', {
              queries: stats.queries,
              estimatedPoints: stats.estimatedPoints
          });

          logger.info('✅ Shutdown complete');
          process.exit(0);

      } catch (error) {
          logger.error('Shutdown error', { error: error.message });
          process.exit(1);
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
      if (!BITQUERY_API_KEY) throw new Error('BITQUERY_API_KEY not set');
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

      logger.info('API Configuration:');
      logger.info(`  Scan Interval: ${SCAN_INTERVAL_MINUTES}min`);
      logger.info(`  Max Candidates: ${MAX_CANDIDATES_TO_ANALYZE}`);
      logger.info(`  Cache Duration: ${CACHE_DURATION_MINUTES}min`);

      // Initialize bot
      const bot = new TradingBot();
      await bot.init();

      logger.info('='.repeat(50));
      logger.info('✅ Bot fully operational and ready to trade!');
      logger.info('='.repeat(50));

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