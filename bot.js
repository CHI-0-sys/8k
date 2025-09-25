require('dotenv').config();
console.log("env loaded");
console.log("TELEGRAM_TOKEN:",process.env.TELEGRAM_TOKEN ? "Loaded" : "Missing");
console.log("HELIUS_API_KEY:",process.env.HELIUS_API_KEY ? "Loaded" : "Missing");
console.log("AUTHORISED_USERS:",process.env.AUTHORIZED_USERS);


const TelegramBot = require('node-telegram-bot-api');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const path = require('path');
const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const { Connection, PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL, sendAndConfirmTransaction } = require('@solana/web3.js');
const { Token, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const bs58 = require('bs58');
const crypto = require('crypto');


// Configuration
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const AUTHORIZED_USERS = process.env.AUTHORIZED_USERS ? process.env.AUTHORIZED_USERS.split(',') : [];
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PRIVATE_KEY = process.env.PRIVATE_KEY; // Base58 encoded private key
const LIVE_TRADING = process.env.LIVE_TRADING === 'true'; 
const {createUmi} = require('@metaplex-foundation/umi-bundle-defaults');
const {mplTokenMetadata,fetchDigitalAsset} = require('@metaplex-foundation/mpl-token-metadata');
const {publicKey} = require('@metaplex-foundation/umi');


// Hosting Configuration
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const USE_WEBHOOK = process.env.USE_WEBHOOK === 'true';

// Trading Configuration
const MAX_SLIPPAGE = 0.01; // 1% maximum slippage
const DEFAULT_STOP_LOSS = 0.05; // 5% stop loss
const JUPITER_API_URL = 'https://quote-api.jup.ag/v6';
const RAYDIUM_API_URL = 'https://api.raydium.io/v2';
const COINGECKO_API_URL = 'https://api.coingecko.com/api/v3';
const DEXSCREENER_API_URL = 'https://api.dexscreener.com/latest/dex';

// Common token addresses
const COMMON_TOKENS = {
    'SOL': 'So11111111111111111111111111111111111111112',
    'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    'RAY': '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    'BONK': 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
};

// Trading Plan Data
const TRADING_PLAN = [
    { day: 1, balance: 10.00, profit: 2.50, expected: 12.50 },
    { day: 2, balance: 12.50, profit: 3.13, expected: 15.63 },
    { day: 3, balance: 15.63, profit: 3.90, expected: 19.53 },
    { day: 4, balance: 19.53, profit: 4.88, expected: 24.41 },
    { day: 5, balance: 24.41, profit: 6.10, expected: 30.51 },
    { day: 6, balance: 30.51, profit: 7.63, expected: 38.14 },
    { day: 7, balance: 38.14, profit: 9.54, expected: 47.68 },
    { day: 8, balance: 47.68, profit: 11.92, expected: 59.60 },
    { day: 9, balance: 59.60, profit: 14.90, expected: 74.50 },
    { day: 10, balance: 74.50, profit: 18.63, expected: 93.13 },
    { day: 11, balance: 93.13, profit: 23.28, expected: 116.41 },
    { day: 12, balance: 116.41, profit: 29.10, expected: 145.57 },
    { day: 13, balance: 145.57, profit: 36.39, expected: 181.96 },
    { day: 14, balance: 181.96, profit: 45.49, expected: 227.45 },
    { day: 15, balance: 227.45, profit: 56.86, expected: 284.31 },
    { day: 16, balance: 284.31, profit: 71.08, expected: 355.39 },
    { day: 17, balance: 355.39, profit: 88.85, expected: 444.24 },
    { day: 18, balance: 444.24, profit: 111.06, expected: 555.30 },
    { day: 19, balance: 555.30, profit: 138.83, expected: 694.13 },
    { day: 20, balance: 694.13, profit: 173.53, expected: 867.66 },
    { day: 21, balance: 867.66, profit: 216.93, expected: 1084.54 },
    { day: 22, balance: 1084.54, profit: 271.15, expected: 1355.73 },
    { day: 23, balance: 1355.73, profit: 338.93, expected: 1694.66 },
    { day: 24, balance: 1694.66, profit: 423.67, expected: 2118.33 },
    { day: 25, balance: 2118.33, profit: 529.58, expected: 2647.91 },
    { day: 26, balance: 2647.91, profit: 661.98, expected: 3309.89 },
    { day: 27, balance: 3309.89, profit: 827.47, expected: 4137.36 },
    { day: 28, balance: 4137.36, profit: 1034.34, expected: 5171.70 },
    { day: 29, balance: 5171.70, profit: 1292.93, expected: 6464.63 },
    { day: 30, balance: 6464.63, profit: 1616.16, expected: 8080.79 }
]; 



class RateLimiter {
    constructor() {
        this.limits = new Map();
    }
    
    async checkLimit(key, maxRequests, timeWindow) {
        if (!this.limits.has(key)) {
            this.limits.set(key, { count: 0, resetTime: Date.now() + timeWindow });
        }
        
        const limit = this.limits.get(key);
        
        if (Date.now() > limit.resetTime) {
            limit.count = 0;
            limit.resetTime = Date.now() + timeWindow;
        }
        
        if (limit.count >= maxRequests) {
            const waitTime = limit.resetTime - Date.now();
            console.log(`Rate limit reached for ${key}. Waiting ${waitTime}ms`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            limit.count = 0;
            limit.resetTime = Date.now() + timeWindow;
        }
        
        limit.count++;
        return true;
    }
}    




class TradingBot {
    constructor() {
        // Initialize Express app for webhook
        this.app = express();
        this.app.use(express.json());

        // Initialize bot with appropriate configuration
        if (USE_WEBHOOK && WEBHOOK_URL) {
            this.bot = new TelegramBot(TELEGRAM_TOKEN, { 
                webHook: {
                    port: PORT,
                    host: '0.0.0.0'
                }
            });
            this.setupWebhook();
        } else {
            this.bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
            console.log('🔄 Using polling mode');
        }
        
        this.rateLimiter = new RateLimiter();
        this.userStates = new Map();
        this.activeTrades = new Map();
        this.priceAlerts = new Map();
        this.priceCache = new Map();
        this.tokenCache = new Map();
        this.stopLossOrders = new Map();
        
        // Initialize Solana connection
        this.connection = new Connection(SOLANA_RPC_URL, 'confirmed');
        this.wallet = PRIVATE_KEY ? Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY)) : null;  

        //initialise umi 
        this.umi = createUmi(SOLANA_RPC_URL).use(mplTokenMetadata());
        
        if (this.wallet) {
            console.log('✅ Wallet initialized:', this.wallet.publicKey.toString());
        } else {
            console.log('⚠️ No wallet configured');
        }
        
        this.setupCommands();
        this.loadUserStates();
        this.startPriceMonitoring();
        this.startStopLossMonitoring();
        this.setupExpressRoutes();
        this.startAutoTrading();
        
        this.app.listen(PORT, '0.0.0.0', () => {
            console.log(`Server running on port ${PORT}`);
            if (USE_WEBHOOK) {
                console.log(`Webhook endpoint: ${WEBHOOK_URL}/webhook`);
            }
        });
    } 
  



    async getHeliusTokenCandidates() {
        const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
        if (!HELIUS_API_KEY) {
            console.error('[Helius] HELIUS_API_KEY is not set in environment variables.');
            return [];
        }
        
        const url = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
    
        try {
            console.log('[Helius] Searching for the latest token candidates...');
    
            const response = await axios.post(url, {
                jsonrpc: '2.0',
                id: 'helius-trading-bot',
                method: 'searchAssets',
                params: {
                    ownerAddress: null,
                    tokenType: 'fungible',
                    sortBy: {
                        sortBy: 'created',
                        sortDirection: 'desc',
                    },
                    limit: 100,
                },
            });
    
            // --- FIX IS HERE ---
            // 1. Check if the Helius API returned a specific error message.
            if (response.data.error) {
                console.error(`❌ Helius API returned an error: ${response.data.error.message}`);
                // This will tell us if the API key is wrong or if there's another issue.
                return [];
            }
    
            // 2. Safely access the results only after confirming there was no error.
            const assets = response.data.result?.items;
            
            if (!assets || assets.length === 0) {
                console.log('[Helius] No new token candidates were found.');
                return [];
            }
            // --- END OF FIX ---
    
            const candidates = assets
                .map(asset => ({
                    address: asset.id,
                    symbol: asset.content?.metadata?.symbol,
                }))
                .filter(c => c.symbol && c.address);
    
            console.log(`[Helius] Found ${candidates.length} potential candidates to analyze.`);
            return candidates;
    
        } catch (error) {
            // This catch block will now handle network errors (e.g., can't connect to Helius)
            console.error('❌ Helius token fetch failed with a network or parsing error:', error.message);
            return [];
        }
    }
    
    

   async sendPnLChart(chatId) {
    const width = 800;
    const height = 400;
    const tradesFile = 'live_trades.json';

    try {
        const raw = await fs.readFile(tradesFile, 'utf8');
        const trades = JSON.parse(raw);

        const today = new Date().toISOString().split('T')[0];
        const todayTrades = trades.filter(t => t.tradeTime.startsWith(today));

        if (!todayTrades.length) {
            await this.bot.sendMessage(chatId, `📭 No trades recorded today.`);
            return;
        }

        let balance = 10;
        const labels = [];
        const data = [];

        todayTrades.forEach(t => {
            balance += parseFloat(t.earned);
            labels.push(`${t.symbol} @ ${new Date(t.tradeTime).toLocaleTimeString()}`);
            data.push(balance.toFixed(2));
        });

        const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height });
        const config = {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'PnL Today ($)',
                    data,
                    borderColor: '#0984e3',
                    backgroundColor: 'rgba(9,132,227,0.2)',
                    fill: true,
                    tension: 0.3
                }]
            },
            options: {
                plugins: {
                    legend: { display: false },
                    title: {
                        display: true,
                        text: 'Daily PnL Report - 8K Bot'
                    }
                },
                scales: {
                    y: {
                        title: { display: true, text: 'Balance ($)' },
                        beginAtZero: true
                    },
                    x: {
                        title: { display: true, text: 'Trade Time' }
                    }
                }
            }
        };

        const imageBuffer = await chartJSNodeCanvas.renderToBuffer(config);
        const filePath = path.join(__dirname, 'daily_pnl.png');
        await fs.writeFile(filePath, imageBuffer);

        await this.bot.sendPhoto(chatId, filePath, {
            caption: `📈 8K Bot - PnL Chart for ${today}`
        });

    } catch (err) {
        console.error('❌ Error generating PnL chart:', err.message);
        await this.bot.sendMessage(chatId, '❌ Could not generate PnL chart.');
    }
}


async autoSell(userId, pos, exitPrice, reason) {
    try {
        const user = this.getUserState(userId);
        let earned = 0;
    
        // 🔄 Live Sell Block
        if (LIVE_TRADING) {
            // FIXED: Use actual token amount, not USD amount
            const sellQuote = await this.getJupiterQuote(
                pos.tokenAddress,    // Input: Token
                COMMON_TOKENS.USDC,  // Output: USDC
                Math.floor(pos.tokensOwned) // Actual token amount
            );

            if (sellQuote?.routes?.[0]) {
                const route = sellQuote.routes[0];
                
                // Verify price hasn't moved too much (1% slippage check)
                const expectedUSDC = pos.tokensOwned * exitPrice;
                const actualUSDC = route.outAmount / 1_000_000;
                const slippage = Math.abs(actualUSDC - expectedUSDC) / expectedUSDC;
                
                if (slippage > 0.01) { // 1% slippage limit
                    console.log(`❌ Slippage too high (${(slippage*100).toFixed(1)}%) for ${pos.symbol}`);
                    return;
                }
                
                const tx = await this.executeSwapSafely(route);
                if (tx.success) {
                    earned = actualUSDC;
                    console.log(`✅ Sold ${pos.symbol} | TX: ${tx.signature}`);
                } else {
                    console.log(`❌ Sell failed for ${pos.symbol}: ${tx.error}`);
                    return;
                }
            } else {
                console.log(`❌ No Jupiter sell route for ${pos.symbol}`);
                return;
            }
        } else {
            // Simulation mode
            earned = pos.tokensOwned * exitPrice;
        }
    
        // Update user state
        const profit = earned - pos.amountUSD;
        user.currentBalance += earned;
        user.totalTrades += 1;
        if (reason === 'profit') user.successfulTrades += 1;
    
        pos.status = 'closed';
        pos.exitPrice = exitPrice;
        pos.soldAt = Date.now();
        pos.profit = profit;
        user.tradeHistory.push(pos);
    
        user.positions = user.positions.filter(p => p.status === 'open');
        
        // Only advance day if profitable
        if (reason === 'profit') {
            user.currentDay += 1;
        }
        
        user.isActive = false;
        user.lastTradeAt = Date.now();
    
        await this.saveUserStates();
    
        // Save to trade log
        await this.saveTradeLog({
            userId,
            symbol: pos.symbol,
            type: reason === 'profit' ? 'SELL_PROFIT' : 'SELL_STOPLOSS',
            earned: earned.toFixed(4),
            profit: profit.toFixed(4),
            entryPrice: pos.entryPrice,
            exitPrice,
            tradeTime: new Date().toISOString()
        });
    
        // Notify user
        await this.bot.sendMessage(userId, `
💸 Auto-Sell Triggered (${reason.toUpperCase()})

🪙 Token: ${pos.symbol}
📈 Entry: $${pos.entryPrice.toFixed(8)}
📉 Exit: $${exitPrice.toFixed(8)}
💰 Earned: $${earned.toFixed(2)}
📊 Profit: ${profit >= 0 ? '✅' : '❌'} $${profit.toFixed(2)}
💼 New Balance: $${user.currentBalance.toFixed(2)}
⏱ Cooldown: 24h until next trade
        `);

    } catch (error) {
        console.error(`❌ Auto-sell failed for ${pos.symbol}:`, error.message);
        await this.bot.sendMessage(userId, `❌ Auto-sell failed for ${pos.symbol}: ${error.message}`);
    }
}
async getDexScreenerPrices() {
    try {
        // DexScreener: ~300 requests/minute
        await this.rateLimiter.checkLimit('dexscreener', 200, 60000); // Conservative 200/min
        
        const response = await axios.get(`${DEXSCREENER_API_URL}/search?q=SOL`, {
            timeout: 10000,
            headers: {
                'User-Agent': 'TradingBot/1.0'
            }
        });
        
        const prices = {};
        
        if (response.data.pairs) {
            response.data.pairs.slice(0, 10).forEach(pair => {
                if (pair.baseToken && pair.priceUsd) {
                    const symbol = pair.baseToken.symbol.toUpperCase();
                    prices[symbol] = {
                        price: parseFloat(pair.priceUsd),
                        change24h: parseFloat(pair.priceChange?.h24 || 0),
                        volume24h: parseFloat(pair.volume?.h24 || 0),
                        marketCap: parseFloat(pair.marketCap || 0)
                    };
                }
            });
        }

        return prices;
    } catch (error) {
        console.error('❌ DexScreener API error:', error.message);
        if (error.response?.status === 429) {
            console.log('🚦 DexScreener rate limited, waiting 30 seconds...');
            await new Promise(resolve => setTimeout(resolve, 30000));
        }
        return {};
    }
} 

async getJupiterQuote(inputMint, outputMint, amount) {
    try {
        // Jupiter: ~20-50 requests/second
        await this.rateLimiter.checkLimit('jupiter', 30, 1000); // 30 per second
        
        const response = await axios.get(`${JUPITER_API_URL}/quote`, {
            params: {
                inputMint,
                outputMint,
                amount,
                slippageBps: Math.floor(MAX_SLIPPAGE * 10000)
            },
            timeout: 8000 // 8 second timeout
        });
        
        return response.data;
    } catch (error) {
        console.error('❌ Jupiter quote error:', error.message);
        if (error.response?.status === 429) {
            console.log('🚦 Jupiter rate limited, waiting 10 seconds...');
            await new Promise(resolve => setTimeout(resolve, 10000));
            return null;
        }
        return null;
    }
} 

async getEnhancedJupiterQuote(inputMint, outputMint, amount, volatilityLevel) {
    try {
        await this.rateLimiter.checkLimit('jupiter', 30, 1000);
        
        // Adjust slippage based on volatility
        let slippageBps = Math.floor(MAX_SLIPPAGE * 10000); // Default 1%
        
        if (volatilityLevel > 2.0) {
            slippageBps = 200; // 2% for high volatility
        } else if (volatilityLevel < 1.0) {
            slippageBps = 50; // 0.5% for low volatility
        }
        
        const response = await axios.get(`${JUPITER_API_URL}/quote`, {
            params: {
                inputMint,
                outputMint,
                amount,
                slippageBps,
                onlyDirectRoutes: volatilityLevel > 2.0,
                maxAccounts: volatilityLevel > 2.0 ? 10 : 20
            },
            timeout: 8000
        });
        
        return response.data;
    } catch (error) {
        console.error('Enhanced Jupiter quote error:', error.message);
        if (error.response?.status === 429) {
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
        return null;
    }
} 



    
async executeSwapSafely(route) {
    try {
        // Simulate first
        const simulationResult = await this.simulateSwap(route);
        if (!simulationResult.success) {
            return { success: false, error: `Simulation failed: ${simulationResult.error}` };
        }

        // Execute the actual swap
        const response = await axios.post(`${JUPITER_API_URL}/swap`, {
            quoteResponse: route,
            userPublicKey: this.wallet.publicKey.toString(),
            wrapUnwrapSOL: true,
            dynamicComputeUnitLimit: true,
            prioritizationFeeLamports: 1000 // Small priority fee
        });
        
        const { swapTransaction } = response.data;
        
        // Deserialize and sign transaction
        const transactionBuf = Buffer.from(swapTransaction, 'base64');
        const transaction = Transaction.from(transactionBuf);
        transaction.sign(this.wallet);
        
        // Send transaction with retry
        let signature;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                signature = await this.connection.sendRawTransaction(
                    transaction.serialize(),
                    { 
                        skipPreflight: false, 
                        preflightCommitment: 'confirmed',
                        maxRetries: 3
                    }
                );
                break;
            } catch (error) {
                if (attempt === 2) throw error;
                console.log(`Retry ${attempt + 1}/3 for transaction`);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        // Wait for confirmation
        const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');
        
        if (confirmation.value.err) {
            return { success: false, error: `Transaction failed: ${confirmation.value.err}` };
        }
        
        return { success: true, signature };
        
    } catch (error) {
        console.error('❌ Swap execution error:', error);
        return { success: false, error: error.message };
    }
} 

async getHoursSinceLastTrade() {  // ← Inside class
    let lastTradeTime = 0;
    for (const [userId, user] of this.userStates.entries()) {
        if (user.lastTradeAt && user.lastTradeAt > lastTradeTime) {
            lastTradeTime = user.lastTradeTime;
        }
    }
    return lastTradeTime ? (Date.now() - lastTradeTime) / (1000 * 60 * 60) : 999;
}

async comprehensiveTokenAnalysis(tokenAddress, symbol) {
    try {
        console.log(`Running comprehensive analysis for ${symbol}...`);
        
        const [security, liquidity, whale, sentiment, volatility] = await Promise.all([
            this.analyzeTokenSecurity(tokenAddress),
            this.analyzeLiquidity(tokenAddress),
            this.analyzeWhaleActivity(tokenAddress),
            this.analyzeSentiment(tokenAddress, symbol),
            this.analyzeVolatility(tokenAddress)
        ]);
        
        // Calculate overall score (weighted)
        const overallScore = Math.round(
            security.score * 0.25 +      // 25% weight
            liquidity.score * 0.20 +     // 20% weight
            whale.score * 0.15 +         // 15% weight
            sentiment.score * 0.20 +     // 20% weight
            volatility.score * 0.20      // 20% weight
        );
        
        // Determine recommendation
        let recommendation = 'AVOID';
        if (overallScore >= 70) recommendation = 'BUY';
        else if (overallScore >= 50) recommendation = 'MODERATE';
        
        return {
            overallScore,
            recommendation,
            analysis: {
                security,
                liquidity,
                whale,
                sentiment,
                volatility
            }
        };
        
    } catch (error) {
        console.error(`Comprehensive analysis failed for ${symbol}:`, error.message);
        return {
            overallScore: 0,
            recommendation: 'AVOID',
            analysis: {
                security: { score: 0, reason: 'Analysis failed' },
                liquidity: { score: 0, reason: 'Analysis failed' },
                whale: { score: 0, reason: 'Analysis failed' },
                sentiment: { score: 0, reason: 'Analysis failed' },
                volatility: { score: 0, riskLevel: 'EXTREME' }
            }
        };
    }
}
 
async checkTokenVerification(tokenAddress) {
    try {
        // Check against Jupiter verified token list
        const response = await axios.get('https://token.jup.ag/strict');
        const verifiedTokens = response.data;
        
        return verifiedTokens.some(token => token.address === tokenAddress);
        
    } catch (error) {
        return false;
    }
} 

async getTokenMetadata(tokenAddress) {
    try {
        const mint = publicKey(tokenAddress);
        
        // Fetch the digital asset (includes metadata)
        const digitalAsset = await fetchDigitalAsset(this.umi, mint);
        
        if (digitalAsset && digitalAsset.metadata) {
            return {
                name: digitalAsset.metadata.name,
                symbol: digitalAsset.metadata.symbol,
                description: digitalAsset.metadata.description,
                image: digitalAsset.metadata.image,
                attributes: digitalAsset.metadata.attributes,
                creators: digitalAsset.metadata.creators,
                sellerFeeBasisPoints: digitalAsset.metadata.sellerFeeBasisPoints,
                updateAuthority: digitalAsset.metadata.updateAuthority,
                isMutable: digitalAsset.metadata.isMutable,
                primarySaleHappened: digitalAsset.metadata.primarySaleHappened,
                collection: digitalAsset.metadata.collection,
                uses: digitalAsset.metadata.uses
            };
        }
        
        return null;
    } catch (error) {
        console.error(`Metadata fetch failed for ${tokenAddress}:`, error.message);
        return null;
    }
}


async analyzeTokenSecurity(tokenAddress) {
    try {
        const accountInfo = await this.connection.getParsedAccountInfo(new PublicKey(tokenAddress));
        let score = 60; // Base score
        const positiveFactors = [];
        const negativeFactors = [];
        
        if (!accountInfo.value) {
            return { 
                score: 0, 
                reason: 'Token account not found', 
                positiveFactors: [], 
                negativeFactors: ['Invalid token'] 
            };
        }
        
        // Get Metaplex metadata
        const metadata = await this.getTokenMetadata(tokenAddress);
        
        if (metadata) {
            score += 15;
            positiveFactors.push('Has valid metadata');
            
            // Check for complete metadata
            if (metadata.name && metadata.symbol && metadata.description) {
                score += 10;
                positiveFactors.push('Complete token information');
            }
            
            // Check for image/logo
            if (metadata.image) {
                score += 5;
                positiveFactors.push('Has token logo');
            }
            
            // Check if metadata is mutable (less secure if mutable)
            if (!metadata.isMutable) {
                score += 10;
                positiveFactors.push('Immutable metadata');
            } else {
                negativeFactors.push('Mutable metadata');
            }
            
            // Check for verified collection
            if (metadata.collection && metadata.collection.verified) {
                score += 15;
                positiveFactors.push('Verified collection member');
            }
            
            // Check creators and royalties
            if (metadata.creators && metadata.creators.length > 0) {
                score += 5;
                positiveFactors.push('Has creator information');
                
                // Check if all creators are verified
                const allVerified = metadata.creators.every(creator => creator.verified);
                if (allVerified) {
                    score += 10;
                    positiveFactors.push('All creators verified');
                }
            }
            
        } else {
            score -= 10;
            negativeFactors.push('No metadata found');
        }
        
        // Check mint authority
        const mintInfo = accountInfo.value.data?.parsed?.info;
        if (mintInfo) {
            if (mintInfo.mintAuthority === null) {
                score += 15;
                positiveFactors.push('Mint authority renounced');
            } else {
                score -= 5;
                negativeFactors.push('Mint authority active');
            }
            
            if (mintInfo.freezeAuthority === null) {
                score += 10;
                positiveFactors.push('No freeze authority');
            } else {
                score -= 5;
                negativeFactors.push('Has freeze authority');
            }
            
            // Check token supply
            if (mintInfo.supply) {
                const supply = parseInt(mintInfo.supply);
                if (supply > 0 && supply < 1e15) { // Reasonable supply range
                    score += 5;
                    positiveFactors.push('Reasonable token supply');
                } else if (supply >= 1e15) {
                    score -= 10;
                    negativeFactors.push('Extremely high token supply');
                }
            }
        }
        
        return {
            score: Math.max(0, Math.min(100, score)),
            reason: `Security analysis complete (${positiveFactors.length} positive, ${negativeFactors.length} negative factors)`,
            positiveFactors,
            negativeFactors,
            metadata
        };
        
    } catch (error) {
        return { 
            score: 0, 
            reason: `Security check failed: ${error.message}`, 
            positiveFactors: [], 
            negativeFactors: ['Analysis failed'] 
        };
    }
}


async analyzeTokenSecurity(tokenAddress) {
    try {
        const accountInfo = await this.connection.getParsedAccountInfo(new PublicKey(tokenAddress));
        let score = 60; // Base score
        const positiveFactors = [];
        const negativeFactors = [];
        
        if (!accountInfo.value) {
            return { score: 0, reason: 'Token account not found', positiveFactors: [], negativeFactors: ['Invalid token'] };
        }
        
        // Check if token has metadata
        try {
            const metadataPDA = await this.getTokenMetadata(tokenAddress);
            if (metadataPDA) {
                score += 15;
                positiveFactors.push('Has metadata');
            }
        } catch (e) {
            score -= 10;
            negativeFactors.push('No metadata');
        }
        
        // Check for verified status (simplified check)
        const isVerified = await this.checkTokenVerification(tokenAddress);
        if (isVerified) {
            score += 20;
            positiveFactors.push('Verified token');
        }
        
        // Check freeze authority (tokens without freeze authority are safer)
        if (accountInfo.value.data?.parsed?.info?.freezeAuthority === null) {
            score += 10;
            positiveFactors.push('No freeze authority');
        } else {
            negativeFactors.push('Has freeze authority');
        }
        
        // Check mint authority
        if (accountInfo.value.data?.parsed?.info?.mintAuthority === null) {
            score += 10;
            positiveFactors.push('Mint authority renounced');
        } else {
            negativeFactors.push('Mint authority active');
        }
        
        return {
            score: Math.max(0, Math.min(100, score)),
            reason: `Security analysis complete`,
            positiveFactors,
            negativeFactors
        };
        
    } catch (error) {
        return { score: 0, reason: `Security check failed: ${error.message}`, positiveFactors: [], negativeFactors: [] };
    }
} 

async analyzeWhaleActivity(tokenAddress) {
    try {
        // We'll use our new helper function to get the last 100 transactions
        const transactions = await this.getHeliusTransactions(tokenAddress, 100);

        if (transactions.length < 10) { // Not enough data for analysis
            return { score: 40, reason: 'Low recent transaction volume' };
        }

        let totalVolume = 0;
        const amounts = [];

        for (const tx of transactions) {
            for (const instruction of tx.instructions) {
                if (instruction.programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' && ['transfer', 'transferChecked'].includes(instruction.parsed.type)) {
                    if (instruction.parsed.info.mint === tokenAddress) {
                         const amount = parseFloat(instruction.parsed.info.tokenAmount.uiAmount);
                         amounts.push(amount);
                         totalVolume += amount;
                    }
                }
            }
        }
        
        if (amounts.length === 0) {
            return { score: 30, reason: 'No recent transfers found' };
        }

        const avgAmount = totalVolume / amounts.length;
        const maxAmount = Math.max(...amounts);
        
        let score = 70; // Base score
        
        // Large single transactions are concerning
        if (maxAmount > avgAmount * 10) {
            score -= 20;
        }
        
        // Too many large transactions
        const largeTransfers = amounts.filter(amt => amt > avgAmount * 3).length;
        if (largeTransfers > 5) {
            score -= 15;
        }
        
        return {
            score: Math.max(0, Math.min(100, score)),
            reason: `${amounts.length} transfers analyzed, max transfer: ${this.formatNumber(maxAmount)}`
        };
        
    } catch (error) {
        console.error(`Helius whale analysis failed for ${tokenAddress}:`, error.message);
        return { score: 50, reason: `Whale analysis failed: ${error.message}` };
    }
}
 
async analyzeSentiment(tokenAddress, symbol) {
    try {
        // We will get transactions from the last hour
        const now = new Date();
        const oneHourAgo = new Date(now.getTime() - (60 * 60 * 1000));
        const twoHoursAgo = new Date(now.getTime() - (2 * 60 * 60 * 1000));

        // Get transactions from the last hour
        const recentSignatures = await this.getHeliusSignatures(tokenAddress, 1000, null, oneHourAgo.toISOString());
        
        // Get transactions from the hour before that
        const previousSignatures = await this.getHeliusSignatures(tokenAddress, 1000, oneHourAgo.toISOString(), twoHoursAgo.toISOString());

        const currentCount = recentSignatures.length;
        const previousCount = previousSignatures.length;

        let score = 50; // Neutral base
        
        if (currentCount > previousCount * 1.5) {
            score += 30; // Growing interest
        } else if (currentCount < previousCount * 0.5) {
            score -= 20; // Declining interest
        }
        
        if (currentCount > 100) score += 20;
        else if (currentCount > 50) score += 10;
        else if (currentCount < 10) score -= 15;
        
        return {
            score: Math.max(0, Math.min(100, score)),
            reason: `${currentCount} txs/hour (vs ${previousCount} previous)`
        };

    } catch (error) {
        console.error(`Helius sentiment analysis failed for ${tokenAddress}:`, error.message);
        return { score: 50, reason: `Sentiment analysis failed: ${error.message}` };
    }
}

async analyzeVolatility(tokenAddress) {
    try {
        // Get price data from DexScreener
        const response = await axios.get(`${DEXSCREENER_API_URL}/tokens/${tokenAddress}`);
        
        if (!response.data.pairs || response.data.pairs.length === 0) {
            return { score: 0, volatility: 999, riskLevel: 'EXTREME' };
        }
        
        const pair = response.data.pairs[0];
        const priceChanges = {
            h1: parseFloat(pair.priceChange?.h1 || 0),
            h6: parseFloat(pair.priceChange?.h6 || 0),
            h24: parseFloat(pair.priceChange?.h24 || 0)
        };
        
        // Calculate volatility score (lower volatility = higher score)
        const avgAbsChange = (Math.abs(priceChanges.h1) + Math.abs(priceChanges.h6) + Math.abs(priceChanges.h24)) / 3;
        
        let score = 100;
        let riskLevel = 'LOW';
        let volatility = avgAbsChange;
        
        if (avgAbsChange > 50) {
            score = 10;
            riskLevel = 'EXTREME';
        } else if (avgAbsChange > 25) {
            score = 30;
            riskLevel = 'HIGH';
        } else if (avgAbsChange > 10) {
            score = 60;
            riskLevel = 'MEDIUM';
        } else {
            score = 90;
            riskLevel = 'LOW';
        }
        
        return {
            score,
            volatility: avgAbsChange,
            riskLevel,
            priceChanges
        };
        
    } catch (error) {
        return { score: 0, volatility: 999, riskLevel: 'EXTREME' };
    }
} 

async simulateSwap(route) {
    try {
        // Get simulation transaction
        const response = await axios.post(`${JUPITER_API_URL}/swap`, {
            quoteResponse: route,
            userPublicKey: this.wallet.publicKey.toString(),
            wrapUnwrapSOL: true,
            dynamicComputeUnitLimit: true,
            onlyDirectRoutes: false,
            simulate: true // This tells Jupiter to simulate only
        });
        
        // Check if simulation was successful
        if (response.data.error) {
            return { success: false, error: response.data.error };
        }
        
        return { success: true, data: response.data };
        
    } catch (error) {
        return { success: false, error: error.message };
    }
} 


isKnownExchangeAddress(address) {
    // Known Solana exchange and market maker addresses
    const knownExchanges = [
        // Raydium
        '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
        '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
        
        // Serum/OpenBook
        '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
        '14ivtgssEBoBjuZJtSAPKYgpUK7DmnSwuPMqJoVTSgKJ',
        
        // Orca
        '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP',
        
        // Solana Labs addresses
        '11111111111111111111111111111112',
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        
        // Common program addresses
        'JUP2jxvXaqu7NQY1GmNF4m1vodw12LVXYxbFL2uJvfo',
        'JUP3c2Uh3WA4Ng34tw6kPd2G4C5BB21Xo36Je1s32Ph',
        
        // Market makers and large holders
        'GThUX1Atko4tqhN2NaiTazWSeFWMuiUirestXkAtVyiS',
        '8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC'
    ];
    
    return knownExchanges.includes(address);
} 





async selectBestTokenFromCandidates(tokens) {
    console.log(`[Analysis] Analyzing ${tokens.length} token candidates...`);
    
    const analyzedTokens = [];
    const batchSize = 3;
    for (let i = 0; i < tokens.length; i += batchSize) {
        const batch = tokens.slice(i, i + batchSize);
        
        const batchPromises = batch.map(async (token) => {
            try {
                const analysis = await this.comprehensiveTokenAnalysis(token.address, token.symbol);
                return { ...token, analysis, finalScore: analysis.overallScore };
            } catch (error) {
                console.error(`[Analysis] Analysis failed for ${token.symbol}:`, error.message);
                return { ...token, analysis: { overallScore: 0, recommendation: 'AVOID' }, finalScore: 0 };
            }
        });
        
        const batchResults = await Promise.all(batchPromises);
        analyzedTokens.push(...batchResults);
        
        if (i + batchSize < tokens.length) {
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    // --- FIX IS HERE ---
    // 1. We 'await' the value BEFORE the filter and store it.
    const hoursSinceLastTrade = await this.getHoursSinceLastTrade();

    const viableTokens = analyzedTokens.filter(token => {
        const analysis = token.analysis;
        
        if (analysis.analysis?.security?.score < 25) return false;
        if (analysis.analysis?.liquidity?.score < 15) return false;
        
        let requiredOverallScore = 35;
        let requiredSecurityScore = 35;
        let requiredLiquidityScore = 20;
        
        // 2. We use the stored variable here. No 'await' is needed inside the filter.
        if (hoursSinceLastTrade > 48) {
            requiredOverallScore = 25;
            requiredSecurityScore = 30;
            requiredLiquidityScore = 15;
            console.log('[Analysis] Relaxing filters due to 48+ hours without trades');
        }

        if (analysis.overallScore < requiredOverallScore) return false;
        if (analysis.recommendation === 'AVOID') return false;
        if (analysis.analysis?.security?.score < requiredSecurityScore) return false;
        if (analysis.analysis?.liquidity?.score < requiredLiquidityScore) return false;
        if (analysis.overallScore < 20 && analysis.analysis?.security?.score < 30) return false;
        
        return true;
    }).sort((a, b) => b.finalScore - a.finalScore);
    // --- END OF FIX ---

    if (viableTokens.length > 0) {
        console.log('--- [Analysis] Top Viable Candidates ---');
        viableTokens.slice(0, 3).forEach((token, index) => {
            console.log(`${index + 1}. ${token.symbol} (Score: ${token.finalScore})`);
        });
        console.log('------------------------------------');
    } else {
        console.log('[Analysis] No tokens passed the viability filters.');
    }

    if (viableTokens.length === 0) {
        return null;
    }

    const selected = viableTokens[0];
    return selected;
}

    
// HELPER 1: Gets transaction signatures for a token address
async getHeliusSignatures(tokenAddress, limit = 100, before = null, until = null) {
    const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
    const url = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
    
    try {
        const params = { limit };
        if (before) params.before = before;
        if (until) params.until = until;

        const response = await axios.post(url, {
            jsonrpc: '2.0',
            id: 'helius-trading-bot',
            method: 'getSignaturesForAsset',
            params: {
              id: tokenAddress,
              ...params
            },
        });
        return response.data.result || [];
    } catch (error) {
        console.error(`Helius getSignatures failed for ${tokenAddress}:`, error.message);
        return [];
    }
}

// HELPER 2: Gets full, parsed transaction details from signatures
async getHeliusTransactions(tokenAddress, limit = 100) {
    const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
    const url = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
    
    try {
        const signatures = await this.getHeliusSignatures(tokenAddress, limit);
        if (signatures.length === 0) return [];

        const response = await axios.post(url, {
            jsonrpc: '2.0',
            id: 'helius-trading-bot',
            method: 'getTransactions',
            params: {
                transactions: signatures.map(s => s.signature),
            },
        });
        return response.data.result || [];
    } catch (error) {
        console.error(`Helius getTransactions failed for ${tokenAddress}:`, error.message);
        return [];
    }
}


async checkDailyLimits(userId) {
    const user = this.getUserState(userId);
    
    // Check for consecutive losses
    const recentTrades = user.tradeHistory.slice(-3);
    if (recentTrades.length === 3 && recentTrades.every(t => t.profit < 0)) {
        user.isActive = false;
        await this.bot.sendMessage(userId, '🛑 Circuit breaker: 3 consecutive losses. Trading paused.');
        return false;
    }
    
    return true;
} 
async getHeliusTokenCandidates() {
    // Get your Helius API key from the environment variables
    const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
    if (!HELIUS_API_KEY) {
        console.error('[Helius] HELIUS_API_KEY is not set.');
        return [];
    }
    
    // The Helius API endpoint. We use a special URL that includes our key.
    const url = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

    try {
        console.log('[Helius] Searching for the latest token candidates...');

        // We use the "searchAssets" method from Helius's DAS API
        const response = await axios.post(url, {
            jsonrpc: '2.0',
            id: 'helius-trading-bot',
            method: 'searchAssets',
            params: {
                // We want to find tokens, not NFTs owned by a specific person
                ownerAddress: null,
                tokenType: 'fungible',
                // Sort by when they were created to find the newest ones
                sortBy: {
                    sortBy: 'created',
                    sortDirection: 'desc',
                },
                // Get the top 100 new tokens
                limit: 100,
            },
        });

        const assets = response.data.result.items;
        
        if (!assets || assets.length === 0) {
            console.log('[Helius] No new token candidates found.');
            return [];
        }

        // Convert the Helius data into the format the rest of our bot understands
        const candidates = assets.map(asset => ({
            address: asset.id, // The token's address
            symbol: asset.content.metadata.symbol, // The token's symbol (e.g., "WIF")
        })).filter(c => c.symbol && c.address); // Filter out any that are missing a symbol or address

        console.log(`[Helius] Found ${candidates.length} potential candidates.`);
        return candidates;

    } catch (error) {
        console.error('❌ Helius token fetch failed:', error.response ? error.response.data : error.message);
        return [];
    }
}

async autoBuyTokenIfEligible(userId) {
    try {
        const user = this.getUserState(userId);
        const dayIndex = user.currentDay - 1;
        const tradeAmount = TRADING_PLAN[dayIndex]?.profit;

        console.log(`[AutoBuy] Triggered for user ${userId} on Day ${user.currentDay}.`);

        // BASIC CHECKS FIRST
        if (!this.wallet || !tradeAmount || !this.cooldownPassed(user)) return;
        if (!await this.checkDailyLimits(userId)) return;

        // The market check was MOVED FROM HERE.
        
        console.log(`[AutoBuy] Pre-flight checks passed. Starting token discovery...`);
    
        const candidates = await this.getHeliusTokenCandidates();
        if (!candidates.length) {
            console.log('[AutoBuy] FAILED: No initial candidates found from Helius.');
            return;
        }
        console.log(`[AutoBuy] Discovery complete. Found ${candidates.length} potential candidates. Analyzing...`);

        const selected = await this.selectBestTokenFromCandidates(candidates);
        if (!selected) {
            // The selectBestTokenFromCandidates function will now log the details, so we can keep this simple.
            await this.bot.sendMessage(userId, '🔍 Market scan complete - no suitable tokens found. Will try again later.');
            return;
        }
        
        console.log(`[AutoBuy] Top candidate is ${selected.symbol} (Score: ${selected.finalScore}). Running final checks...`);

        const finalSafetyCheck = await this.performFinalSafetyChecks(selected);
        if (!finalSafetyCheck.passed) {
            console.log(`[AutoBuy] FAILED: Final safety check failed for ${selected.symbol}: ${finalSafetyCheck.reason}`);
            return;
        }
        console.log(`[AutoBuy] Passed final safety checks for ${selected.symbol}.`);

        // --- MARKET CHECK MOVED TO HERE ---
        // This is the final gate before spending money.
        if (!await this.checkMarketConditions()) {
            console.log(`[AutoBuy] SKIPPED: Market conditions are not favorable for trading. Halting trade for ${selected.symbol}.`);
            return;
        }
        // ------------------------------------
        
        const adjustedAmount = this.calculateDynamicPositionSize(
            tradeAmount, 
            selected.analysis.analysis.volatility,
            selected.analysis.overallScore
        );
        console.log(`[AutoBuy] Calculated dynamic position size: $${adjustedAmount.toFixed(2)}.`);
        
        const quote = await this.getEnhancedJupiterQuote(
            COMMON_TOKENS.USDC,
            selected.address,
            Math.floor(adjustedAmount * 1_000_000),
            selected.analysis.analysis.volatility.volatility
        );
        
        // ... the rest of the function remains the same ...

        if (!quote || !quote.routes?.[0]) {
            console.log(`[AutoBuy] FAILED: No enhanced Jupiter route found for ${selected.symbol}.`);
            return;
        }
        console.log(`[AutoBuy] Successfully received a trade quote from Jupiter for ${selected.symbol}.`);

        const route = quote.routes[0];
        const tokensReceived = route.outAmount;
        const usdcSpent = route.inAmount / 1_000_000;
        const entryPrice = usdcSpent / tokensReceived;
        
        if (LIVE_TRADING) {
            console.log(`[AutoBuy] LIVE TRADING IS ON. Attempting to execute swap for ${selected.symbol}...`);
            const tx = await this.executeSwapSafely(route);
            if (!tx.success) {
                console.log(`[AutoBuy] TRANSACTION FAILED for ${selected.symbol}: ${tx.error}`);
                await this.bot.sendMessage(userId, `❌ Trade execution failed for ${selected.symbol}: ${tx.error}`);
                return;
            }
            console.log(`[AutoBuy] ✅✅✅ TRADE EXECUTED for ${selected.symbol} | TX: ${tx.signature}`);
        } else {
            console.log(`[AutoBuy] SIMULATION MODE: Live trading is off. Skipping actual transaction.`);
        }
        
        const position = {
            symbol: selected.symbol,
            tokenAddress: selected.address,
            entryPrice,
            targetPrice: this.calculateDynamicTarget(entryPrice, selected.analysis),
            stopLossPrice: this.calculateDynamicStopLoss(entryPrice, selected.analysis),
            amountUSD: adjustedAmount,
            tokensOwned: tokensReceived,
            boughtAt: Date.now(),
            status: 'open',
            analysis: selected.analysis,
            riskLevel: selected.analysis.analysis.volatility.riskLevel,
            confidence: selected.analysis.overallScore
        };
        
        user.positions.push(position);
        user.lastTradeAt = Date.now();
        user.isActive = true;
        
        await this.saveUserStates();
        
        console.log(`[AutoBuy] Position for ${selected.symbol} saved. Sending notification to user.`);
        await this.sendEnhancedBuyNotification(userId, position, selected.analysis);
        
    } catch (error) {
        console.error(`[AutoBuy] CRITICAL ERROR in auto-buy process for user ${userId}:`, error.message);
        await this.bot.sendMessage(userId, `❌ A critical error occurred during the auto-buy process: ${error.message}`);
    }
}

async checkMarketConditions() {
    try {
        // Check overall market sentiment before trading
        if (!this.marketSentiment) return true; // If no data, proceed
        
        const sentiment = this.marketSentiment.sentiment;
        const volume = this.marketSentiment.volume;
       
        // Don't trade in extremely bearish conditions
        if (sentiment === 'bearish' && this.marketSentiment.losers > this.marketSentiment.gainers * 3) {
            console.log('Market conditions too bearish for trading');
            return false;
        }
        
        // Don't trade in extremely low volume conditions
        if (volume < 1000000) { // Less than $1M total volume
            console.log('Market volume too low for safe trading');
            return false;
        }
        
        return true;
    } catch (error) {
        console.error('Market condition check failed:', error.message);
        return true; // Default to allow trading if check fails
    }
} 
async getEnhancedJupiterQuote(inputMint, outputMint, amount, volatilityLevel) {
    try {
        // Adjust slippage based on volatility
        let slippageBps = Math.floor(MAX_SLIPPAGE * 10000); // Default 1%
        
        if (volatilityLevel > 2.0) {
            slippageBps = 200; // 2% for high volatility
        } else if (volatilityLevel < 1.0) {
            slippageBps = 50; // 0.5% for low volatility
        }
        
        const response = await axios.get(`${JUPITER_API_URL}/quote`, {
            params: {
                inputMint,
                outputMint,
                amount,
                slippageBps,
                onlyDirectRoutes: volatilityLevel > 2.0, // Direct routes only for high volatility
                maxAccounts: volatilityLevel > 2.0 ? 10 : 20
            }
        });
        
        return response.data;
    } catch (error) {
        console.error('Enhanced Jupiter quote error:', error.message);
        return null;
    }
} 


async performFinalSafetyChecks(token) {
    try {
        // Last-minute liquidity check
        const currentLiquidity = await this.getCurrentLiquidity(token.address);
        if (currentLiquidity < 50000) {
            return { passed: false, reason: 'Liquidity dropped below threshold' };
        }
        
        // Check for recent suspicious activity
        const recentActivity = await this.checkRecentSuspiciousActivity(token.address);
        if (recentActivity.suspicious) {
            return { passed: false, reason: recentActivity.reason };
        }
        
        // Verify contract hasn't changed
        const contractVerification = await this.verifyContractIntegrity(token.address);
        if (!contractVerification.valid) {
            return { passed: false, reason: 'Contract verification failed' };
        }
        
        return { passed: true };
    } catch (error) {
        return { passed: false, reason: `Safety check error: ${error.message}` };
    }
} 

calculateDynamicPositionSize(baseAmount, volatilityData, overallScore) {
    let multiplier = 1.0;
    
    // Adjust based on volatility risk
    switch (volatilityData.riskLevel) {
        case 'LOW':
            multiplier = 1.2; // 20% more on low risk
            break;
        case 'MEDIUM':
            multiplier = 1.0; // Base amount
            break;
        case 'HIGH':
            multiplier = 0.7; // 30% less on high risk
            break;
        case 'EXTREME':
            multiplier = 0.5; // 50% less on extreme risk
            break;
    }
    
    // Adjust based on overall confidence
    if (overallScore > 80) multiplier *= 1.1;
    else if (overallScore < 50) multiplier *= 0.8;
    
    return Math.max(baseAmount * multiplier, baseAmount * 0.3); // Minimum 30% of base
}  

calculateDynamicTarget(entryPrice, analysis) {
    let targetMultiplier = 1.25; // Base 25% target
    
    const volatility = analysis.analysis.volatility.volatility;
    const overallScore = analysis.overallScore;
    
    // Higher targets for lower volatility (more predictable)
    if (volatility < 1.0) {
        targetMultiplier = 1.30; // 30% target
    } else if (volatility > 2.0) {
        targetMultiplier = 1.20; // 20% target for high volatility
    }
    
    // Adjust based on confidence
    if (overallScore > 80) {
        targetMultiplier += 0.05; // Extra 5% for high confidence
    }
    
    return entryPrice * targetMultiplier;
} 


calculateDynamicStopLoss(entryPrice, analysis) {
    let stopLossMultiplier = 0.95; // Base 5% stop loss
    
    const volatility = analysis.analysis.volatility.volatility;
    const securityScore = analysis.analysis.security.score;
    
    // Tighter stops for high volatility
    if (volatility > 2.0) {
        stopLossMultiplier = 0.92; // 8% stop loss
    } else if (volatility < 1.0) {
        stopLossMultiplier = 0.97; // 3% stop loss
    }
    
    // Tighter stops for lower security scores
    if (securityScore < 60) {
        stopLossMultiplier -= 0.02; // Additional 2% safety margin
    }
    
    return entryPrice * stopLossMultiplier;
} 

async sendEnhancedBuyNotification(userId, position, analysis) {
    const message = `
🧠 Enhanced Auto-Buy Executed!

🪙 Token: ${position.symbol}
💰 Amount: ${position.amountUSD.toFixed(2)}
📊 Tokens: ${position.tokensOwned.toLocaleString()}
🎯 Entry: ${position.entryPrice.toFixed(8)}
📈 Target: ${position.targetPrice.toFixed(8)}
🛑 Stop-loss: ${position.stopLossPrice.toFixed(8)}

📋 Analysis Summary:
• Overall Score: ${analysis.overallScore}/100 (${analysis.recommendation})
• Security: ${analysis.analysis.security.score}/100
• Liquidity: ${analysis.analysis.liquidity.score}/100
• Whale Activity: ${analysis.analysis.whale.score}/100
• Social Sentiment: ${analysis.analysis.sentiment.score}/100
• Volatility Risk: ${analysis.analysis.volatility.riskLevel}
• Confidence Level: ${position.confidence}/100

🔍 Key Factors:
${analysis.analysis.security.positiveFactors?.join(', ') || 'Security checked'}
${analysis.analysis.liquidity.reason}
${analysis.analysis.whale.reason}

Now monitoring for optimal exit...
    `;
    
    await this.bot.sendMessage(userId, message);
}

async checkRecentSuspiciousActivity(tokenAddress) {
    try {
        // Use our Helius helper to get the last 50 transactions for the token
        const transactions = await this.getHeliusTransactions(tokenAddress, 50);

        if (transactions.length < 10) {
            // Not enough recent activity to make a judgment
            return { suspicious: false };
        }

        let largeSellsToExchange = 0;
        let failedTxCount = 0;

        for (const tx of transactions) {
            // 1. Check if the transaction failed
            if (tx.meta && tx.meta.err !== null) {
                failedTxCount++;
            }

            // 2. Check for large sell-offs by looking at token transfers
            for (const instruction of tx.instructions) {
                // We're looking for standard SPL Token Program transfers
                if (instruction.programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' && 
                    ['transfer', 'transferChecked'].includes(instruction.parsed?.type)) {
                    
                    const info = instruction.parsed.info;
                    
                    // Check if it's the correct token and has all the necessary data
                    if (info && info.mint === tokenAddress && info.destination && info.tokenAmount?.uiAmount) {
                        const amount = parseFloat(info.tokenAmount.uiAmount);
                        
                        // A large amount sent TO a known exchange address is a potential dump
                        if (amount > 100000 && this.isKnownExchangeAddress(info.destination)) {
                            largeSellsToExchange++;
                        }
                    }
                }
            }
        }

        // If we found more than 3 large sells in the last 50 transactions, it's suspicious.
        if (largeSellsToExchange > 3) {
            return { suspicious: true, reason: 'Large sell-offs to exchanges detected' };
        }
        
        // If more than 30% of recent transactions are failing, it's suspicious.
        const failureRate = failedTxCount / transactions.length;
        if (failureRate > 0.3) {
            return { suspicious: true, reason: 'High transaction failure rate detected' };
        }
        
        // If no red flags are found, we're good.
        return { suspicious: false };

    } catch (error) {
        console.error(`[Helius] Suspicious activity check failed for ${tokenAddress}:`, error.message);
        // Default to not suspicious if the check itself fails, to avoid blocking a valid trade.
        return { suspicious: false };
    }
}



async verifyContractIntegrity(tokenAddress) {
    try {
        const accountInfo = await this.connection.getParsedAccountInfo(
            new PublicKey(tokenAddress)
        );
        
        return {
            valid: accountInfo.value !== null,
            reason: accountInfo.value ? 'Contract verified' : 'Contract not found'
        };
    } catch (error) {
        return { valid: false, reason: 'Verification failed' };
    }
} 



async getCurrentLiquidity(tokenAddress) {
    try {
        const response = await axios.get(`${DEXSCREENER_API_URL}/tokens/${tokenAddress}`);
        if (response.data.pairs && response.data.pairs.length > 0) {
            return parseFloat(response.data.pairs[0].liquidity?.usd || 0);
        }
        return 0;
    } catch (error) {
        console.error('Current liquidity check failed:', error.message);
        return 0;
    }
}

    async getLiveJupiterPrice(tokenAddress) {
        try {
            const quote = await this.getJupiterQuote(
                tokenAddress,
                COMMON_TOKENS.USDC,
                1000000 // 1 token worth (assuming 6 decimals)
            );
            
            if (quote?.routes?.[0]) {
                const route = quote.routes[0];
                return route.outAmount / 1_000_000; // Convert to USDC price
            }
            return null;
        } catch (error) {
            console.error(`❌ Price fetch failed for ${tokenAddress}`);
            return null;
        }
    } 

    async saveTradeLog(tradeData){
        try{
            const tradesFile = "live_trades.json";
            let current = [] 

            try{
                const existing = await fs.readFile(tradesFile, 'utf-8');
                current = JSON.parse(existing || '[]');
            } catch(e){
                console.warn('📁 Creating new trade log file...')
            }

            current.push(tradeData);
            await fs.writeFile(tradesFile,JSON.stringify(current,null,2));
            console.log('Trade logged successfully');
        }catch(err){
            console.error('failed to write trade log:', err.message)
        }
    }

    async monitorAndSell() {
        for (const [userId, user] of this.userStates.entries()) {
            for (const pos of user.positions.filter(p => p.status === 'open')) {
                try {
                    const currentPrice = await this.getLiveJupiterPrice(pos.tokenAddress);
    
                    if (!currentPrice) continue;
    
                    if (currentPrice >= pos.targetPrice) {
                        await this.autoSell(userId, pos, currentPrice, 'profit');
                    } else if (currentPrice <= pos.stopLossPrice) {
                        await this.autoSell(userId, pos, currentPrice, 'stop-loss');
                    }
    
                } catch (e) {
                    console.error(`monitorAndSell error for ${pos.symbol}:`, e.message);
                }
            }
        }
    }
    
    async isNotHoneypot(tokenAddress) {
        try {
            // Use our Helius helper to get the last 100 transactions.
            const transactions = await this.getHeliusTransactions(tokenAddress, 100);
    
            if (transactions.length < 20) {
                // Not enough transaction data to be certain, so we'll be cautious.
                // A brand new token might fail this, which is often a good thing.
                return false;
            }
    
            const uniqueSenders = new Set();
    
            for (const tx of transactions) {
                for (const instruction of tx.instructions) {
                    // Look for SPL Token Program transfers
                    if (instruction.programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' &&
                        ['transfer', 'transferChecked'].includes(instruction.parsed?.type)) {
                        
                        const info = instruction.parsed.info;
    
                        // We're interested in who is SENDING the token
                        if (info && info.mint === tokenAddress && info.source) {
                            // We only care about regular wallets, not big exchanges or contracts
                            if (!this.isKnownExchangeAddress(info.source)) {
                                uniqueSenders.add(info.source);
                            }
                        }
                    }
                }
            }
    
            // The logic: If a token is not a honeypot, there should be multiple,
            // independent wallets successfully selling it. A honeypot would have
            // only one or two senders (the deployer, the liquidity pool).
            const hasDiverseSellers = uniqueSenders.size > 5;
    
            if (hasDiverseSellers) {
                console.log(`[Helius] Honeypot check for ${tokenAddress}: PASSED (${uniqueSenders.size} unique sellers found).`);
            } else {
                console.log(`[Helius] Honeypot check for ${tokenAddress}: FAILED (${uniqueSenders.size} unique sellers found). Potential honeypot.`);
            }
    
            return hasDiverseSellers;
    
        } catch (err) {
            console.error(`❌ [Helius] Honeypot check failed for ${tokenAddress}:`, err.message);
            // If the API call fails, it's safer to assume it might be a honeypot.
            return false;
        }
    }
    
    
  
    async isTrendingToken(tokenAddress) {
        try {
            const now = new Date();
            const fiveMinAgo = new Date(now.getTime() - (5 * 60 * 1000)).toISOString();
            const tenMinAgo = new Date(now.getTime() - (10 * 60 * 1000)).toISOString();
    
            // Get transaction signatures from the last 5 minutes
            const currentSignatures = await this.getHeliusSignatures(tokenAddress, 1000, null, fiveMinAgo);
    
            // Get transaction signatures from the 5 minutes before that
            const previousSignatures = await this.getHeliusSignatures(tokenAddress, 1000, fiveMinAgo, tenMinAgo);
    
            const currTxs = currentSignatures.length;
            const prevTxs = previousSignatures.length;
    
            console.log(`[Helius] Trend check for ${tokenAddress}: Last 5 mins=${currTxs} txs, Previous 5 mins=${prevTxs} txs`);
    
            // A token is considered trending if its transaction count has increased by at least 50%
            // in the most recent 5-minute window compared to the previous one.
            // We also add a small threshold (currTxs > 5) to avoid false positives on very new/inactive tokens.
            const isTrending = currTxs > prevTxs * 1.5 && currTxs > 5;
            
            if(isTrending) {
                 console.log(`[Helius] Trend check for ${tokenAddress}: PASSED.`);
            } else {
                 console.log(`[Helius] Trend check for ${tokenAddress}: FAILED.`);
            }
    
            return isTrending;
    
        } catch (err) {
            console.error(`❌ [Helius] Trend check failed for ${tokenAddress}:`, err.message);
            // If the check fails, it's safer to assume it's not trending.
            return false;
        }
    }
    
    

    async setupWebhook() {
        try {
            await this.bot.setWebHook(`${WEBHOOK_URL}/webhook`);
            console.log(`✅ Webhook set to: ${WEBHOOK_URL}/webhook`);
        } catch (error) {
            console.error('❌ Error setting webhook:', error);
            process.exit(1);
        }
    }

    
    setupExpressRoutes() {
        // Webhook endpoint
        this.app.post('/webhook', (req, res) => {
            console.log('Webhook received');
            this.bot.processUpdate(req.body);
            res.sendStatus(200);
        });
    
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({ 
                status: 'healthy',
                timestamp: new Date().toISOString()
            });
        });
    
        // Status endpoint  
        this.app.get('/status', (req, res) => {
            res.json({
                users: this.userStates.size,
                activeTrades: this.activeTrades.size,
                priceAlerts: this.priceAlerts.size,
                walletConfigured: !!this.wallet,
                webhookMode: USE_WEBHOOK,
                priceCache: this.priceCache.size,
                stopLossOrders: this.stopLossOrders.size
            });
        });
    
        // DON'T start server here - remove the app.listen() part
    }

    async loadUserStates() {
        try {
            const data = await fs.readFile('user_states.json', 'utf8');
            const states = JSON.parse(data);
            this.userStates = new Map(Object.entries(states));
            console.log(`📊 Loaded ${this.userStates.size} user states`);
        } catch (error) {
            console.log('📝 No existing user states found, starting fresh');
        }
    }

    async saveUserStates() {
        try {
            const states = Object.fromEntries(this.userStates);
            await fs.writeFile('user_states.json', JSON.stringify(states, null, 2));
        } catch (error) {
            console.error('❌ Error saving user states:', error);
        }
    }

    isAuthorized(userId) {
        return AUTHORIZED_USERS.length === 0 || AUTHORIZED_USERS.includes(userId.toString());
    }

    getUserState(userId) {
        if (!this.userStates.has(userId)) {
            this.userStates.set(userId, {
                currentDay: 1,
                currentBalance: 10.00,
                isActive: false,
                startDate: null,
                totalTrades: 0,
                successfulTrades: 0,
                watchlist: [],
                positions: [],
                tradeHistory: [],
                walletAddress: this.wallet ? this.wallet.publicKey.toString() : null,
                autoTrade: false,
                stopLossEnabled: true,
                maxPositionSize: 0.1,
                riskLevel: 'medium',
                notifications: true
            });
        }
        return this.userStates.get(userId);
    }

    // REAL PRICE MONITORING IMPLEMENTATION
    async startPriceMonitoring() {
        console.log('🔍 Starting conservative price monitoring...');
        
        setInterval(async () => {
            try {
                await this.updatePrices();
                await new Promise(resolve => setTimeout(resolve, 5000)); // 5 sec gap
                await this.checkPriceAlerts();
                await new Promise(resolve => setTimeout(resolve, 5000)); // 5 sec gap
                await this.analyzeMarketConditions();
            } catch (error) {
                console.error('❌ Price monitoring error:', error);
            }
        }, 120000); // Every 2 minutes instead of 30 seconds
    }

    async updatePrices() {
        try {
            console.log('📊 Starting price update...');
            
            // Sequential calls to avoid overwhelming APIs
            const cgPrices = await this.getCoinGeckoPrices();
            await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second gap
            
            const dexPrices = await this.getDexScreenerPrices();
    
            // Merge and update cache
            const allPrices = { ...cgPrices, ...dexPrices };
            
            for (const [token, price] of Object.entries(allPrices)) {
                const prevPrice = this.priceCache.get(token);
                this.priceCache.set(token, {
                    price: price.price,
                    change24h: price.change24h,
                    volume24h: price.volume24h,
                    marketCap: price.marketCap,
                    timestamp: Date.now(),
                    trend: prevPrice ? (price.price > prevPrice.price ? 'up' : 'down') : 'neutral'
                });
            }
    
            console.log(`📊 Updated prices for ${Object.keys(allPrices).length} tokens`);
        } catch (error) {
            console.error('❌ Error updating prices:', error);
        }
    }

    async getCoinGeckoPrices() {
        try {
            const response = await axios.get(`${COINGECKO_API_URL}/simple/price`, {
                params: {
                    ids: 'solana,usd-coin,tether,raydium,bonk',
                    vs_currencies: 'usd',
                    include_24hr_change: true,
                    include_24hr_vol: true,
                    include_market_cap: true
                }
            });

            const prices = {};
            for (const [id, data] of Object.entries(response.data)) {
                const symbol = this.getSymbolFromCoinGeckoId(id);
                prices[symbol] = {
                    price: data.usd,
                    change24h: data.usd_24h_change || 0,
                    volume24h: data.usd_24h_vol || 0,
                    marketCap: data.usd_market_cap || 0
                };
            }

            return prices;
        } catch (error) {
            console.error('❌ CoinGecko API error:', error);
            return {};
        }
    }

    async getDexScreenerPrices() {
        try {
            const response = await axios.get(`${DEXSCREENER_API_URL}/search?q=SOL`);
            const prices = {};
            
            if (response.data.pairs) {
                response.data.pairs.slice(0, 10).forEach(pair => {
                    if (pair.baseToken && pair.priceUsd) {
                        const symbol = pair.baseToken.symbol.toUpperCase();
                        prices[symbol] = {
                            price: parseFloat(pair.priceUsd),
                            change24h: parseFloat(pair.priceChange?.h24 || 0),
                            volume24h: parseFloat(pair.volume?.h24 || 0),
                            marketCap: parseFloat(pair.marketCap || 0)
                        };
                    }
                });
            }

            return prices;
        } catch (error) {
            console.error('❌ DexScreener API error:', error);
            return {};
        }
    }

    getSymbolFromCoinGeckoId(id) {
        const map = {
            'solana': 'SOL',
            'usd-coin': 'USDC',
            'tether': 'USDT',
            'raydium': 'RAY',
            'bonk': 'BONK'
        };
        return map[id] || id.toUpperCase();
    }

    async checkPriceAlerts() {
        for (const [userId, alerts] of this.priceAlerts.entries()) {
            for (const alert of alerts) {
                const priceData = this.priceCache.get(alert.token);
                if (!priceData) continue;

                const triggered = alert.type === 'above' 
                    ? priceData.price >= alert.price
                    : priceData.price <= alert.price;

                if (triggered) {
                    await this.sendPriceAlert(userId, alert, priceData.price);
                    // Remove triggered alert
                    const userAlerts = this.priceAlerts.get(userId) || [];
                    this.priceAlerts.set(userId, userAlerts.filter(a => a.id !== alert.id));
                }
            }
        }
    }

    async sendPriceAlert(userId, alert, currentPrice) {
        try {
            const message = `
🚨 **Price Alert Triggered!**

Token: ${alert.token}
Current Price: $${currentPrice.toFixed(6)}
Alert Price: $${alert.price.toFixed(6)}
Condition: ${alert.type === 'above' ? 'Above' : 'Below'}

Set at: ${new Date(alert.createdAt).toLocaleString()}
            `;

            await this.bot.sendMessage(userId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('❌ Error sending price alert:', error);
        }
    }

    // REAL TOKEN SEARCH IMPLEMENTATION
    async searchToken(chatId, tokenQuery) {
        try {
            await this.bot.sendMessage(chatId, `🔍 Searching for ${tokenQuery}...`);
            
            const tokenData = await this.getTokenData(tokenQuery);
            
            if (!tokenData) {
                await this.bot.sendMessage(chatId, '❌ Token not found. Please check the symbol and try again.');
                return;
            }

            const riskAssessment = await this.assessTokenRisk(tokenData);
            
            const message = `
🪙 **${tokenData.symbol} (${tokenData.name})**

💰 **Price**: $${tokenData.price.toFixed(8)}
📊 **24h Change**: ${tokenData.change24h >= 0 ? '📈' : '📉'} ${tokenData.change24h.toFixed(2)}%
💹 **Market Cap**: $${this.formatNumber(tokenData.marketCap)}
🔄 **24h Volume**: $${this.formatNumber(tokenData.volume24h)}
📍 **Contract**: \`${tokenData.address}\`

🎯 **Risk Assessment**: ${riskAssessment.level}
⚠️ **Risk Score**: ${riskAssessment.score}/100
📝 **Notes**: ${riskAssessment.notes}

**Liquidity**: $${this.formatNumber(tokenData.liquidity || 0)}
**Holders**: ${tokenData.holders || 'N/A'}
**Age**: ${tokenData.age || 'Unknown'}

Use /trade ${tokenData.symbol} [amount] to trade this token.
            `;
            
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '📈 Buy', callback_data: `buy_${tokenData.symbol}` },
                        { text: '📉 Sell', callback_data: `sell_${tokenData.symbol}` }
                    ],
                    [
                        { text: '🔔 Set Alert', callback_data: `alert_${tokenData.symbol}` },
                        { text: '⭐ Add to Watchlist', callback_data: `watch_${tokenData.symbol}` }
                    ]
                ]
            };
            
            await this.bot.sendMessage(chatId, message, { 
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
            
        } catch (error) {
            console.error('❌ Token search error:', error);
            await this.bot.sendMessage(chatId, '❌ Error searching for token. Please try again.');
        }
    }

    async getTokenData(tokenQuery) {
        try {
            // First check if it's a common token
            const tokenAddress = COMMON_TOKENS[tokenQuery.toUpperCase()];
            
            if (tokenAddress) {
                return await this.getTokenDataByAddress(tokenAddress, tokenQuery.toUpperCase());
            }

            // Search by symbol on DexScreener
            const response = await axios.get(`${DEXSCREENER_API_URL}/search?q=${tokenQuery}`);
            
            if (response.data.pairs && response.data.pairs.length > 0) {
                const pair = response.data.pairs[0];
                return {
                    symbol: pair.baseToken.symbol,
                    name: pair.baseToken.name,
                    address: pair.baseToken.address,
                    price: parseFloat(pair.priceUsd),
                    change24h: parseFloat(pair.priceChange?.h24 || 0),
                    volume24h: parseFloat(pair.volume?.h24 || 0),
                    marketCap: parseFloat(pair.marketCap || 0),
                    liquidity: parseFloat(pair.liquidity?.usd || 0),
                    holders: pair.holders || null,
                    age: pair.pairCreatedAt ? this.calculateAge(pair.pairCreatedAt) : null
                };
            }

            return null;
        } catch (error) {
            console.error('❌ Error getting token data:', error);
            return null;
        }
    }
    
    async getTokenDataByAddress(address, symbol) {
        try {
            // Get token metadata from Solana
            const tokenInfo = await this.connection.getParsedAccountInfo(new PublicKey(address));
            
            // Get price data
            const priceData = this.priceCache.get(symbol) || { price: 0, change24h: 0, volume24h: 0, marketCap: 0 };
            
            return {
                symbol: symbol,
                name: symbol,
                address: address,
                price: priceData.price,
                change24h: priceData.change24h,
                volume24h: priceData.volume24h,
                marketCap: priceData.marketCap,
                liquidity: 0,
                holders: null,
                age: null
            };
        } catch (error) {
            console.error('❌ Error getting token data by address:', error);
            return null;
        }
    }

    calculateAge(timestamp) {
        const now = Date.now();
        const age = now - timestamp;
        const days = Math.floor(age / (1000 * 60 * 60 * 24));
        
        if (days > 365) {
            return `${Math.floor(days / 365)} years`;
        } else if (days > 30) {
            return `${Math.floor(days / 30)} months`;
        } else {
            return `${days} days`;
        }
    }

    cooldownPassed(user) {
        const last = user.lastTradeAt || 0;
        const now = Date.now();
        return (now - last) >= 86_400_000; // 24h in ms
    }
    
    async autoSell(userId, pos, exitPrice, reason) {
        const user = this.getUserState(userId);
        const earned = (exitPrice / pos.entryPrice) * pos.amountUSD;
    
        user.currentBalance += earned;
        user.totalTrades += 1;
        if (reason === 'profit') user.successfulTrades += 1;
    
        pos.status = 'closed';
        pos.exitPrice = exitPrice;
        pos.soldAt = Date.now();
        user.tradeHistory.push(pos);
        user.positions = user.positions.filter(p => p.status === 'open');
        user.currentDay += 1;
        user.isActive = false;
        user.lastTradeAt = Date.now();
    
        await this.saveUserStates();
    
        await this.bot.sendMessage(userId, `
    💸 Auto-Sell (${reason.toUpperCase()}) triggered
    
    🪙 ${pos.symbol}
    📈 Entry: $${pos.entryPrice}
    📉 Exit: $${exitPrice}
    📊 Result: $${(earned - pos.amountUSD).toFixed(2)} ${reason === 'profit' ? 'profit' : 'loss'}
    ⏱ Next trade in 24h
        `);
    }
    

    async assessTokenRisk(tokenData) {
        let score = 50; // Base score
        let notes = [];
        
        // Price analysis
        if (tokenData.price < 0.000001) {
            score += 20;
            notes.push('Extremely low price');
        }
        
        // Volume analysis
        if (tokenData.volume24h < 10000) {
            score += 15;
            notes.push('Low trading volume');
        }
        
        // Market cap analysis
        if (tokenData.marketCap < 100000) {
            score += 20;
            notes.push('Very low market cap');
        }
        
        // Liquidity analysis
        if (tokenData.liquidity && tokenData.liquidity < 50000) {
            score += 15;
            notes.push('Low liquidity');
        }
        
        // Age analysis
        if (tokenData.age && tokenData.age.includes('days') && parseInt(tokenData.age) < 7) {
            score += 10;
            notes.push('Very new token');
        }
        
        // Determine risk level
        let level;
        if (score >= 80) level = '🔴 EXTREME RISK';
        else if (score >= 65) level = '🟠 HIGH RISK';
        else if (score >= 45) level = '🟡 MEDIUM RISK';
        else level = '🟢 LOW RISK';
        
        return {
            score: Math.min(score, 100),
            level,
            notes: notes.length > 0 ? notes.join(', ') : 'Standard risk factors'
        };
    }

    // REAL TRADING IMPLEMENTATION
    async executeTrade(userId, tokenSymbol, amount, side) {
        try {
            if (!this.wallet) {
                throw new Error('Wallet not configured');
            }

            const userState = this.getUserState(userId);
            const tokenData = await this.getTokenData(tokenSymbol);
            
            if (!tokenData) {
                throw new Error('Token not found');
            }

            // Validate trade
            const validation = await this.validateTrade(userState, tokenData, amount, side);
            if (!validation.valid) {
                throw new Error(validation.reason);
            }

            // Get quote from Jupiter
            const quote = await this.getJupiterQuote(tokenData.address, amount, side);
            if (!quote) {
                throw new Error('Unable to get quote');
            }

            // Execute swap
            const transaction = await this.executeSwap(quote);
            
            // Update user state
            await this.updateUserStateAfterTrade(userId, tokenData, amount, side, transaction);
            
            return {
                success: true,
                transaction,
                quote,
                tokenData
            };
            
        } catch (error) {
            console.error('❌ Trade execution error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
    

    // 7. Add startAutoTrading method
async startAutoTrading() {
    console.log('🤖 Starting auto-trading monitoring...');
    
    setInterval(async () => {
        try {
            // Monitor existing positions for sell opportunities
            await this.monitorAndSell();
            
            // Check for new buy opportunities
            for (const [userId, user] of this.userStates.entries()) {
                if (user.isActive && this.cooldownPassed(user) && user.positions.length === 0) {
                    await this.autoBuyTokenIfEligible(userId);
                }
            }
        } catch (error) {
            console.error('❌ Auto-trading monitoring error:', error);
        }
    }, 30000); // Every 30 seconds
}

    async validateTrade(userState, tokenData, amount,side ) {
        // Check if user has sufficient balance
        if (side === 'buy' && userState.currentBalance < amount) {
            return { valid: false, reason: 'Insufficient balance' };
        }
        
        // Check position size limits
        if (amount > userState.currentBalance * userState.maxPositionSize) {
            return { valid: false, reason: 'Position size too large' };
        }
        
        // Check if token meets minimum liquidity requirements
        if (tokenData.liquidity && tokenData.liquidity < 10000) {
            return { valid: false, reason: 'Token liquidity too low' };
        }
        
        return { valid: true };
    }

    async getJupiterQuote(tokenAddress, amount, side) {
        try {
            const inputMint = side === 'buy' ? COMMON_TOKENS.USDC : tokenAddress;
            const outputMint = side === 'buy' ? tokenAddress : COMMON_TOKENS.USDC;
            const amountLamports = Math.floor(amount * LAMPORTS_PER_SOL);
            
            const response = await axios.get(`${JUPITER_API_URL}/quote`, {
                params: {
                    inputMint,
                    outputMint,
                    amount: amountLamports,
                    slippageBps: Math.floor(MAX_SLIPPAGE * 10000)
                }
            });
            
            return response.data;
        } catch (error) {
            console.error('❌ Jupiter quote error:', error);
            return null;
        }
    }

    async executeSwap(quote) {
        try {
            // Get swap transaction from Jupiter
            const response = await axios.post(`${JUPITER_API_URL}/swap`, {
                quoteResponse: quote,
                userPublicKey: this.wallet.publicKey.toString(),
                wrapUnwrapSOL: true
            });
            
            const { swapTransaction } = response.data;
            
            // Deserialize and sign transaction
            const transactionBuf = Buffer.from(swapTransaction, 'base64');
            const transaction = Transaction.from(transactionBuf);
            transaction.sign(this.wallet);
            
            // Send transaction
            const signature = await this.connection.sendRawTransaction(
                transaction.serialize(),
                { skipPreflight: false, preflightCommitment: 'confirmed' }
            );
            
            // Wait for confirmation
            await this.connection.confirmTransaction(signature, 'confirmed');
            
            return {
                signature,
                success: true
            };
            
        } catch (error) {
            console.error('❌ Swap execution error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async updateUserStateAfterTrade(userId, tokenData, amount, side, transaction) {
        const userState = this.getUserState(userId);
        
        // Update balance and positions
        if (side === 'buy') {
            userState.currentBalance -= amount;
            userState.positions.push({
                token: tokenData.symbol,
                amount: amount / tokenData.price,
                entryPrice: tokenData.price,
                side: 'long',
                timestamp: Date.now(),
                stopLoss: userState.stopLossEnabled ? tokenData.price * (1 - DEFAULT_STOP_LOSS) : null
            });
        } else {
            userState.currentBalance += amount;
            // Remove or reduce position
            userState.positions = userState.positions.filter(p => p.token !== tokenData.symbol);
        }
        
        // Add to trade history
        userState.tradeHistory.push({
            token: tokenData.symbol,
            side,
            amount,
            price: tokenData.price,
            timestamp: Date.now(),
            signature: transaction.signature,
            success: transaction.success
        });
        
        userState.totalTrades++;
        if (transaction.success) {
            userState.successfulTrades++;
        }
        
        await this.saveUserStates();
    }

    // STOP LOSS IMPLEMENTATION
    async startStopLossMonitoring() {
        console.log('🛡️ Starting stop-loss monitoring...');
        
        setInterval(async () => {
            try {
                await this.checkStopLossOrders();
            } catch (error) {
                console.error('❌ Stop-loss monitoring error:', error);
            }
        }, 15000); // Every 15 seconds
    }

    async checkStopLossOrders() {
        for (const [userId, userState] of this.userStates.entries()) {
            if (!userState.stopLossEnabled || !userState.isActive) continue;
            
            for (const position of userState.positions) {
                if (!position.stopLoss) continue;
                
                const currentPrice = this.priceCache.get(position.token)?.price;
                if (!currentPrice) continue;
                
                const shouldTrigger = position.side === 'long' 
                    ? currentPrice <= position.stopLoss
                    : currentPrice >= position.stopLoss;
                
                if (shouldTrigger) {
                    await this.executeStopLoss(userId, position, currentPrice);
                }
            }
        }
    }

    async executeStopLoss(userId, position, currentPrice) {
        try {
            console.log(`🛡️ Executing stop-loss for ${position.token} at ${currentPrice}`);
            
            const result = await this.executeTrade(
                userId,
                position.token,
                position.amount * currentPrice,
                'sell'
            );
            
            if (result.success) {
                const message = `
🛡️ **Stop-Loss Executed**

Token: ${position.token}
Entry Price: ${position.entryPrice.toFixed(6)}
Stop Price: ${position.stopLoss.toFixed(6)}
Exit Price: ${currentPrice.toFixed(6)}
Loss: ${(((currentPrice - position.entryPrice) / position.entryPrice) * 100).toFixed(2)}%

Position closed to protect your capital.
                `;
                
                await this.bot.sendMessage(userId, message, { parse_mode: 'Markdown' });
            }
        } catch (error) {
            console.error('❌ Stop-loss execution error:', error);
        }
    }

    async analyzeMarketConditions() {
        try {
            // Analyze overall market sentiment
            const marketData = {
                totalVolume: 0,
                gainers: 0,
                losers: 0,
                neutral: 0
            };
            
            for (const [token, data] of this.priceCache.entries()) {
                marketData.totalVolume += data.volume24h || 0;
                
                if (data.change24h > 2) marketData.gainers++;
                else if (data.change24h < -2) marketData.losers++;
                else marketData.neutral++;
            }
            
            const sentiment = marketData.gainers > marketData.losers ? 'bullish' : 'bearish';
            
            // Store market analysis
            this.marketSentiment = {
                sentiment,
                volume: marketData.totalVolume,
                timestamp: Date.now(),
                ...marketData
            };
            
        } catch (error) {
            console.error('❌ Market analysis error:', error);
        }
    }

    formatNumber(num) {
        if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
        if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
        if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
        return num.toFixed(2);
    }

    setupCommands() {
        // Error handling for bot
        this.bot.on('error', (error) => {
            console.error('❌ Bot error:', error);
        });

        this.bot.on('polling_error', (error) => {
            console.error('❌ Polling error:', error);
        });

        // Callback query handler for inline buttons
        this.bot.on('callback_query', async (callbackQuery) => {
            const action = callbackQuery.data;
            const chatId = callbackQuery.message.chat.id;
            const userId = callbackQuery.from.id;
            
            if (!this.isAuthorized(userId)) return;
            
            try {
                if (action.startsWith('buy_')) {
                    const token = action.replace('buy_', '');
                    await this.handleBuyAction(chatId, userId, token);
                } else if (action.startsWith('sell_')) {
                    const token = action.replace('sell_', '');
                    await this.handleSellAction(chatId, userId, token);
                } else if (action.startsWith('alert_')) {
                    const token = action.replace('alert_', '');
                    await this.handleAlertAction(chatId, userId, token);
                } else if (action.startsWith('watch_')) {
                    const token = action.replace('watch_', '');
                    await this.handleWatchlistAction(chatId, userId, token);
                }
                
                await this.bot.answerCallbackQuery(callbackQuery.id);
            } catch (error) {
                console.error('❌ Callback query error:', error);
                await this.bot.answerCallbackQuery(callbackQuery.id, { text: 'Error occurred' });
            }
        });

        // Start command
        this.bot.onText(/\/start/, async (msg) => {
            try {
                if (!this.isAuthorized(msg.from.id)) {
                    await this.bot.sendMessage(msg.chat.id, '🚫 You are not authorized to use this bot.');
                    return;
                }

                const welcomeMessage = `
🚀 **Advanced Meme Token Trading Bot - 30 Day Challenge** 🚀

**Target: $10 → $8,080 in 30 days (25% daily)**

**🔥 NEW FEATURES:**
✅ Real-time price monitoring
✅ Actual Solana blockchain trading
✅ Stop-loss protection
✅ Risk assessment
✅ Market analysis
✅ Price alerts
✅ Portfolio tracking

**Commands:**
/status - View current trading status
/start_plan - Begin the 30-day challenge
/search [token] - Search and analyze tokens
/trade [token] [amount] [buy/sell] - Execute trades
/wallet - View wallet info
/positions - Show active positions
/watchlist - Manage watchlist
/alerts - Manage price alerts
/settings - Configure trading settings
/help - Show all commands

⚠️ **WARNING**: Trading involves substantial risk. Only trade what you can afford to lose!

Bot Status: ${USE_WEBHOOK ? '📡 Webhook' : '🔄 Polling'} | Wallet: ${this.wallet ? '✅' : '❌'}
                `;

                await this.bot.sendMessage(msg.chat.id, welcomeMessage, { 
                    parse_mode: 'Markdown',
                    disable_web_page_preview: true
                });
            } catch (error) {
                console.error('Start command error:', error);
            }
        });

        // Status command
        this.bot.onText(/\/status/, async (msg) => {
            if (!this.isAuthorized(msg.from.id)) return;
            await this.showStatus(msg.chat.id, msg.from.id);
        });

        // Start plan command
        this.bot.onText(/\/start_plan/, async (msg) => {
            if (!this.isAuthorized(msg.from.id)) return;
            await this.startTradingPlan(msg.chat.id, msg.from.id);
        });

        // Search token command
        this.bot.onText(/\/search (.+)/, async (msg, match) => {
            if (!this.isAuthorized(msg.from.id)) return;
            const tokenSymbol = match[1];
            await this.searchToken(msg.chat.id, tokenSymbol);
        });

        // Trade command
        this.bot.onText(/\/trade (\w+) ([\d.]+) (buy|sell)/, async (msg, match) => {
            if (!this.isAuthorized(msg.from.id)) return;
            const [, token, amount, side] = match;
            await this.handleTradeCommand(msg.chat.id, msg.from.id, token, parseFloat(amount), side);
        });  

        // /pause — disables auto-buy
        this.bot.onText(/\/pause/, async (msg) => {
            if (!this.isAuthorized(msg.from.id)) return;

          const user = this.getUserState(msg.from.id);
             user.isActive = false;

            await this.saveUserStates();
            await this.bot.sendMessage(msg.chat.id, `⏸️ Auto-trading has been paused.`);
       });
       this.bot.onText(/\/wallet/, async (msg) => {
        console.log("/wallet command using wallet:", this.wallet?.publicKey.toBase58());
        
        if (!this.wallet || !this.connection) {
            await this.bot.sendMessage(msg.chat.id, `❌ Wallet not configured.`);
            return;
        }
    
        try {
            const lamports = await this.connection.getBalance(this.wallet.publicKey);
            const sol = lamports / LAMPORTS_PER_SOL;
    
            await this.bot.sendMessage(msg.chat.id, `
    🔐 **Wallet Info**
    🧾 Address: \`${this.wallet.publicKey.toBase58()}\`
    💰 Balance: ${sol.toFixed(4)} SOL
            `.trim(), { parse_mode: 'Markdown' });
    
        } catch (err) {
            console.error('❌ Error fetching wallet info:', err.message);
            await this.bot.sendMessage(msg.chat.id, `❌ Failed to fetch wallet info.`);
        }
    });
    

    
    this.bot.onText(/\/positions/, async (msg) => {
        if (!this.isAuthorized(msg.from.id)) return;
    
        const user = this.getUserState(msg.from.id);
        const openPositions = user.positions.filter(p => p.status === 'open');
    
        if (!openPositions.length) {
            await this.bot.sendMessage(msg.chat.id, `📭 No open positions right now.`);
            return;
        }
    
        let text = `📊 *Open Positions (${openPositions.length} total)*\n\n`;
    
        openPositions.forEach((pos, i) => {
            const date = new Date(pos.boughtAt).toLocaleString();
            text += `*${i + 1}. ${pos.symbol}*\n`;
            text += `🟢 Entry: $${pos.entryPrice.toFixed(4)}\n`;
            text += `🎯 Target: $${pos.targetPrice.toFixed(4)}\n`;
            text += `🛑 Stop-Loss: $${pos.stopLossPrice.toFixed(4)}\n`;
            text += `📅 Bought: ${date}\n\n`;
        });
    
        await this.bot.sendMessage(msg.chat.id, text, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        });
    });
    
        // Watchlist command
        this.bot.onText(/\/watchlist/, async (msg) => {
            if (!this.isAuthorized(msg.from.id)) return;
            await this.showWatchlist(msg.chat.id, msg.from.id);
        });

        // Alerts command
        this.bot.onText(/\/alerts/, async (msg) => {
            if (!this.isAuthorized(msg.from.id)) return;
            await this.showAlerts(msg.chat.id, msg.from.id);
        });

        // Settings command
        this.bot.onText(/\/settings/, async (msg) => {
            if (!this.isAuthorized(msg.from.id)) return;
            await this.showSettings(msg.chat.id, msg.from.id);
        });

        // Set alert command
        this.bot.onText(/\/setalert (\w+) (above|below) ([\d.]+)/, async (msg, match) => {
            if (!this.isAuthorized(msg.from.id)) return;
            const [, token, type, price] = match;
            await this.setAlert(msg.chat.id, msg.from.id, token, type, parseFloat(price));
        });

        // Market command
        this.bot.onText(/\/market/, async (msg) => {
            if (!this.isAuthorized(msg.from.id)) return;
            await this.showMarketOverview(msg.chat.id);
        });

        // Help command
        this.bot.onText(/\/help/, async (msg) => {
            if (!this.isAuthorized(msg.from.id)) return;
            await this.showHelp(msg.chat.id);
        }); 
        
        //PNL command
        this.bot.onText(/\/pnl/, async (msg) => {
            if (!this.isAuthorized(msg.from.id)) return;
            await this.sendPnLChart(msg.chat.id);
        }); 

        this.bot.onText(/\/resume/, async (msg) => {
            if (!this.isAuthorized(msg.from.id)) return;
        
            const user = this.getUserState(msg.from.id);
        
            // Enforce cooldown: wait 24h from last trade
            const now = Date.now();
            const last = user.lastTradeAt || 0;
            const hoursSince = (now - last) / (1000 * 60 * 60);
        
            if (hoursSince < 24) {
                await this.bot.sendMessage(msg.chat.id, `⏳ You must wait ${Math.ceil(24 - hoursSince)}h to resume.`);
                return;
            }
        
            user.isActive = true;
            await this.saveUserStates();
        
            await this.bot.sendMessage(msg.chat.id, `▶️ Auto-trading has been resumed.`);
        });
        

        // Test command
        this.bot.onText(/\/test/, async (msg) => {
            try {
                const testInfo = `
✅ **Bot System Test**

🔗 Solana Connection: ${this.connection ? '✅' : '❌'}
💳 Wallet: ${this.wallet ? '✅ ' + this.wallet.publicKey.toString().slice(0, 10) + '...' : '❌'}
📊 Price Cache: ${this.priceCache.size} tokens
🎯 Active Users: ${this.userStates.size}
📡 Mode: ${USE_WEBHOOK ? 'Webhook' : 'Polling'}

All systems operational!
                `;
                
                await this.bot.sendMessage(msg.chat.id, testInfo, { parse_mode: 'Markdown' });
            } catch (error) {
                console.error('Test command error:', error);
            }
        });
    }

    async handleTradeCommand(chatId, userId, token, amount, side) {
        try {
            const userState = this.getUserState(userId);
            
            if (!userState.isActive) {
                await this.bot.sendMessage(chatId, '⚠️ Please start your trading plan first with /start_plan');
                return;
            }

            await this.bot.sendMessage(chatId, `🔄 Executing ${side} order for ${amount} ${token}...`);
            
            const result = await this.executeTrade(userId, token, amount, side);
            
            if (result.success) {
                const message = `
✅ **Trade Executed Successfully**

Token: ${token}
Side: ${side.toUpperCase()}
Amount: ${amount}
Price: ${result.tokenData.price.toFixed(6)}
Total: ${(amount * result.tokenData.price).toFixed(2)}
Signature: \`${result.transaction.signature}\`

New Balance: ${userState.currentBalance.toFixed(2)}
                `;
                
                await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
            } else {
                await this.bot.sendMessage(chatId, `❌ Trade failed: ${result.error}`);
            }
            
        } catch (error) {
            console.error('❌ Trade command error:', error);
            await this.bot.sendMessage(chatId, '❌ Error executing trade. Please try again.');
        }
    }

    async showWalletInfo(chatId, userId) {
        try {
            if (!this.wallet) {
                await this.bot.sendMessage(chatId, '❌ Wallet not configured');
                return;
            }

            const balance = await this.connection.getBalance(this.wallet.publicKey);
            const userState = this.getUserState(userId);
            
            const message = `
💳 **Wallet Information**

📍 Address: \`${this.wallet.publicKey.toString()}\`
💰 SOL Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL
📊 Trading Balance: ${userState.currentBalance.toFixed(2)}

📈 Active Positions: ${userState.positions.length}
🎯 Total Trades: ${userState.totalTrades}
✅ Success Rate: ${userState.totalTrades > 0 ? ((userState.successfulTrades / userState.totalTrades) * 100).toFixed(1) : 0}%
            `;
            
            await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('❌ Wallet info error:', error);
            await this.bot.sendMessage(chatId, '❌ Error getting wallet info');
        }
    }

    async showPositions(chatId, userId) {
        try {
            const userState = this.getUserState(userId);
            
            if (userState.positions.length === 0) {
                await this.bot.sendMessage(chatId, '📊 No active positions');
                return;
            }

            let message = '📊 **Active Positions**\n\n';
            let totalValue = 0;
            let totalPnL = 0;
            
            for (const position of userState.positions) {
                const currentPrice = this.priceCache.get(position.token)?.price || 0;
                const value = position.amount * currentPrice;
                const pnl = value - (position.amount * position.entryPrice);
                const pnlPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
                
                totalValue += value;
                totalPnL += pnl;
                
                message += `
🪙 **${position.token}**
Amount: ${position.amount.toFixed(4)}
Entry: ${position.entryPrice.toFixed(6)}
Current: ${currentPrice.toFixed(6)}
Value: ${value.toFixed(2)}
PnL: ${pnl >= 0 ? '📈' : '📉'} ${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)
${position.stopLoss ? `Stop Loss: ${position.stopLoss.toFixed(6)}` : ''}

`;
            }
            
            message += `
💼 **Portfolio Summary**
Total Value: ${totalValue.toFixed(2)}
Total PnL: ${totalPnL >= 0 ? '📈' : '📉'} ${totalPnL.toFixed(2)}
            `;
            
            await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('❌ Positions error:', error);
            await this.bot.sendMessage(chatId, '❌ Error showing positions');
        }
    }

    async showWatchlist(chatId, userId) {
        try {
            const userState = this.getUserState(userId);
            
            if (userState.watchlist.length === 0) {
                await this.bot.sendMessage(chatId, '⭐ Watchlist is empty. Use /search [token] to add tokens.');
                return;
            }

            let message = '⭐ **Your Watchlist**\n\n';
            
            for (const token of userState.watchlist) {
                const priceData = this.priceCache.get(token);
                if (priceData) {
                    message += `
🪙 **${token}**
Price: ${priceData.price.toFixed(6)}
24h: ${priceData.change24h >= 0 ? '📈' : '📉'} ${priceData.change24h.toFixed(2)}%
Volume: ${this.formatNumber(priceData.volume24h)}

`;
                }
            }
            
            await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('❌ Watchlist error:', error);
            await this.bot.sendMessage(chatId, '❌ Error showing watchlist');
        }
    }

    async showAlerts(chatId, userId) {
        try {
            const alerts = this.priceAlerts.get(userId) || [];
            
            if (alerts.length === 0) {
                await this.bot.sendMessage(chatId, '🔔 No active alerts. Use /setalert [token] [above/below] [price] to set alerts.');
                return;
            }

            let message = '🔔 **Active Price Alerts**\n\n';
            
            for (const alert of alerts) {
                message += `
🚨 **${alert.token}**
Type: ${alert.type === 'above' ? '📈 Above' : '📉 Below'}
Price: ${alert.price.toFixed(6)}
Created: ${new Date(alert.createdAt).toLocaleDateString()}

`;
            }
            
            await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('❌ Alerts error:', error);
            await this.bot.sendMessage(chatId, '❌ Error showing alerts');
        }
    }

    async setAlert(chatId, userId, token, type, price) {
        try {
            const alertId = crypto.randomBytes(16).toString('hex');
            const alert = {
                id: alertId,
                token: token.toUpperCase(),
                type,
                price,
                createdAt: Date.now()
            };
            
            if (!this.priceAlerts.has(userId)) {
                this.priceAlerts.set(userId, []);
            }
            
            this.priceAlerts.get(userId).push(alert);
            
            await this.bot.sendMessage(chatId, 
                `🔔 Alert set for ${token.toUpperCase()} ${type} ${price.toFixed(6)}`
            );
        } catch (error) {
            console.error('❌ Set alert error:', error);
            await this.bot.sendMessage(chatId, '❌ Error setting alert');
        }
    }

    async showMarketOverview(chatId) {
        try {
            const sentiment = this.marketSentiment || { sentiment: 'neutral', gainers: 0, losers: 0 };
            
            let message = `
📊 **Market Overview**

📈 Sentiment: ${sentiment.sentiment === 'bullish' ? '🐂 Bullish' : '🐻 Bearish'}
📊 Gainers: ${sentiment.gainers || 0}
📉 Losers: ${sentiment.losers || 0}
🔄 Total Volume: ${this.formatNumber(sentiment.volume || 0)}

**Top Movers:**
`;
            
            // Show top performers from cache
            const topMovers = Array.from(this.priceCache.entries())
                .sort((a, b) => Math.abs(b[1].change24h) - Math.abs(a[1].change24h))
                .slice(0, 5);
            
            for (const [token, data] of topMovers) {
                message += `
${data.change24h >= 0 ? '📈' : '📉'} **${token}**: ${data.change24h.toFixed(2)}%`;
            }
            
            await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('❌ Market overview error:', error);
            await this.bot.sendMessage(chatId, '❌ Error showing market overview');
        }
    }

    async showSettings(chatId, userId) {
        try {
            const userState = this.getUserState(userId);
            
            const message = `
⚙️ **Trading Settings**

🛡️ Stop Loss: ${userState.stopLossEnabled ? '✅ Enabled' : '❌ Disabled'}
📊 Max Position Size: ${(userState.maxPositionSize * 100).toFixed(1)}%
🎯 Risk Level: ${userState.riskLevel.toUpperCase()}
🔔 Notifications: ${userState.notifications ? '✅ On' : '❌ Off'}
🤖 Auto Trading: ${userState.autoTrade ? '✅ On' : '❌ Off'}

Use inline buttons below to modify settings:
            `;
            
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: userState.stopLossEnabled ? '🛡️ Disable SL' : '🛡️ Enable SL', callback_data: 'toggle_stoploss' },
                        { text: '📊 Position Size', callback_data: 'set_position_size' }
                    ],
                    [
                        { text: '🎯 Risk Level', callback_data: 'set_risk_level' },
                        { text: '🔔 Notifications', callback_data: 'toggle_notifications' }
                    ]
                ]
            };
            
            await this.bot.sendMessage(chatId, message, {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
        } catch (error) {
            console.error('❌ Settings error:', error);
            await this.bot.sendMessage(chatId, '❌ Error showing settings');
        }
    }

    async handleBuyAction(chatId, userId, token) {
        const message = `
💰 **Buy ${token}**

Enter amount to buy:
Format: /trade ${token} [amount] buy

Example: /trade ${token} 10 buy (buys $10 worth)
        `;
        
        await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    async handleSellAction(chatId, userId, token) {
        const message = `
📉 **Sell ${token}**

Enter amount to sell:
Format: /trade ${token} [amount] sell

Example: /trade ${token} 100 sell (sells 100 tokens)
        `;
        
        await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    async handleAlertAction(chatId, userId, token) {
        const message = `
🔔 **Set Alert for ${token}**

Format: /setalert ${token} [above/below] [price]

Examples:
- /setalert ${token} above 0.001
- /setalert ${token} below 0.0005
        `;
        
        await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    async handleWatchlistAction(chatId, userId, token) {
        try {
            const userState = this.getUserState(userId);
            
            if (!userState.watchlist.includes(token)) {
                userState.watchlist.push(token);
                await this.saveUserStates();
                await this.bot.sendMessage(chatId, `⭐ Added ${token} to your watchlist`);
            } else {
                await this.bot.sendMessage(chatId, `⭐ ${token} is already in your watchlist`);
            }
        } catch (error) {
            console.error('❌ Watchlist action error:', error);
            await this.bot.sendMessage(chatId, '❌ Error adding to watchlist');
        }
    }

    async showStatus(chatId, userId) {
        try {
            const userState = this.getUserState(userId);
            const currentPlan = TRADING_PLAN[userState.currentDay - 1];
            
            // Calculate portfolio value
            let portfolioValue = userState.currentBalance;
            for (const position of userState.positions) {
                const currentPrice = this.priceCache.get(position.token)?.price || 0;
                portfolioValue += position.amount * currentPrice;
            }
            
            const statusMessage = `
📊 **Trading Status - Day ${userState.currentDay}/30**

💰 **Current Balance**: ${userState.currentBalance.toFixed(2)}
💼 **Portfolio Value**: ${portfolioValue.toFixed(2)}
🎯 **Target Profit**: ${currentPlan.profit.toFixed(2)} (25%)
🏆 **Expected Balance**: ${currentPlan.expected.toFixed(2)}

📊 **Progress**: ${((userState.currentDay - 1) / 30 * 100).toFixed(1)}%
🎲 **Total Trades**: ${userState.totalTrades}
✅ **Success Rate**: ${userState.totalTrades > 0 ? ((userState.successfulTrades / userState.totalTrades) * 100).toFixed(1) : 0}%
📈 **Active Positions**: ${userState.positions.length}

🔄 **Status**: ${userState.isActive ? '🟢 Active' : '🔴 Paused'}
📅 **Start Date**: ${userState.startDate || 'Not started'}
🛡️ **Stop Loss**: ${userState.stopLossEnabled ? '✅' : '❌'}

**Remaining to complete day**: ${Math.max(0, currentPlan.expected - portfolioValue).toFixed(2)}
            `;

            await this.bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Show status error:', error);
        }
    }

    async startTradingPlan(chatId, userId) {
        try {
            const userState = this.getUserState(userId);
            
            if (userState.isActive) {
                await this.bot.sendMessage(chatId, '⚠️ Trading plan is already active!');
                return;
            }

            if (!this.wallet) {
                await this.bot.sendMessage(chatId, '❌ Wallet not configured. Please contact admin.');
                return;
            }

            userState.isActive = true;
            userState.startDate = new Date().toISOString().split('T')[0];
            userState.currentDay = 1;
            userState.currentBalance = 10.00;
            
            await this.saveUserStates();

            const startMessage = `
🚀 **30-Day Trading Challenge Started!**

📅 Start Date: ${userState.startDate}
💰 Starting Balance: ${userState.currentBalance}
🎯 Day 1 Target: $12.50 (+$2.50)
💳 Wallet: ${this.wallet.publicKey.toString().slice(0, 8)}...

✅ Real trading is now ACTIVE!
🛡️ Stop-loss protection: ${userState.stopLossEnabled ? 'Enabled' : 'Disabled'}
📊 Max position size: ${(userState.maxPositionSize * 100).toFixed(1)}%

Good luck! Remember to manage your risk carefully.
Use /search [token] to find trading opportunities.
            `;

            await this.bot.sendMessage(chatId, startMessage, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Start trading plan error:', error);
        }
    }

    showHelp(chatId) {
        const helpMessage = `
📚 **Advanced Trading Bot Commands**

**🔥 Core Features:**
/start - Welcome & bot info
/status - View trading progress
/start_plan - Begin 30-day challenge
/market - Market overview & sentiment

**💰 Trading Commands:**
/search [token] - Analyze any token
/trade [token] [amount] [buy/sell] - Execute trades
/positions - View active positions
/wallet - Wallet info & balance

**🎯 Management:**
/watchlist - Manage favorite tokens
/alerts - Price alert management
/setalert [token] [above/below] [price] - Set alerts
/settings - Configure trading parameters

**🛡️ Risk Management:**
• Automatic stop-loss protection
• Position size limits
• Risk assessment for all tokens
• Real-time market monitoring

**🔧 Advanced Features:**
• Live Solana blockchain integration
• Jupiter DEX aggregation
• Multi-source price feeds
• Portfolio tracking & PnL

**Bot Status:**
- Mode: ${USE_WEBHOOK ? '📡 Webhook' : '🔄 Polling'}
- Wallet: ${this.wallet ? '✅ Active' : '❌ Inactive'}
- Users: ${this.userStates.size}
- Monitored Tokens: ${this.priceCache.size}

⚠️ **Risk Warning**: 
This bot executes REAL trades with REAL money.
Trading meme tokens involves substantial risk of loss.
Never trade more than you can afford to lose.

🆘 Support: Contact admin if you encounter issues.
        `;

        this.bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
    }

    // Graceful shutdown
    async shutdown() {
        console.log('🛑 Shutting down bot...');
        await this.saveUserStates();
        if (USE_WEBHOOK) {
            await this.bot.deleteWebHook();
        }
        process.exit(0);
    }
}

// Initialize bot
const bot = new TradingBot();

console.log('🤖 Advanced Telegram Trading Bot Started!');
console.log('💡 System Status:');
console.log(`   - TELEGRAM_TOKEN: ${process.env.TELEGRAM_TOKEN ? '✅' : '❌'}`);
console.log(`   - HELIUS_API_KEY: ${process.env.HELIUS_API_KEY? '✅' : '❌'}`);
console.log(`   - WEBHOOK_URL: ${WEBHOOK_URL || '❌ Not set'}`);
console.log(`   - USE_WEBHOOK: ${USE_WEBHOOK}`);
console.log(`   - PORT: ${PORT}`);
console.log(`   - SOLANA_RPC: ${process.env.SOLANA_RPC_URL || 'Default'}`);
console.log(`   - WALLET: ${process.env.PRIVATE_KEY ? '✅' : '❌'}`);
console.log("ENV PRIVATE_KEY length:", process.env.PRIVATE_KEY?.length);
console.log("ENV PRIVATE_KEY preview:", process.env.PRIVATE_KEY?.slice(0, 20));

// Graceful shutdown handlers
process.on('SIGTERM', () => bot.shutdown());
process.on('SIGINT', () => bot.shutdown());

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    bot.shutdown();
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

module.exports = bot;