require('dotenv').config();
console.log("env loaded");
console.log("TELEGRAM_TOKEN:",process.env.TELEGRAM_TOKEN ? "Loaded" : "Missing");
console.log("BITQUERY_API_KEY:",process.env.BITQUERY_API_KEY ? "Loaded" : "Missing");
console.log("AUTHORISED_USERS:",process.env.AUTHORIZED_USERS);
const TelegramBot = require('node-telegram-bot-api');

const axios = require('axios');
const fs = require('fs').promises;
const { Connection, PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { Token, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const bs58 = require('bs58');
// Configuration
const TELEGRAM_TOKEN=process.env.TELEGRAM_TOKEN;
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY;
const AUTHORIZED_USERS = process.env.AUTHORIZED_USERS ? process.env.AUTHORIZED_USERS.split(',') : [];
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PRIVATE_KEY = process.env.PRIVATE_KEY; // Base58 encoded private key

// Trading Configuration
const MAX_SLIPPAGE = 0.05; // 5% maximum slippage
const DEFAULT_STOP_LOSS = 0.15; // 15% stop loss
const JUPITER_API_URL = 'https://quote-api.jup.ag/v6';
const RAYDIUM_API_URL = 'https://api.raydium.io/v2';

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

class TradingBot {
    constructor() {
        this.bot = new TelegramBot(TELEGRAM_TOKEN, { polling: "" });
        this.userStates = new Map();
        this.activeTrades = new Map(); // Track active positions
        this.priceAlerts = new Map(); // Price monitoring for stop-loss
        
        // Initialize Solana connection
        this.connection = new Connection(SOLANA_RPC_URL, 'confirmed');
        this.wallet = PRIVATE_KEY ? Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY)) : null;
        
        this.setupCommands();
        this.loadUserStates();
        this.startPriceMonitoring();
    }

    async loadUserStates() {
        try {
            const data = await fs.readFile('user_states.json', 'utf8');
            const states = JSON.parse(data);
            this.userStates = new Map(Object.entries(states));
        } catch (error) {
            console.log('No existing user states found, starting fresh');
        }
    }

    async saveUserStates() {
        const states = Object.fromEntries(this.userStates);
        await fs.writeFile('user_states.json', JSON.stringify(states, null, 2));
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
                positions: [], // Active trading positions
                tradeHistory: [],
                walletAddress: null,
                autoTrade: false,
                stopLossEnabled: true,
                maxPositionSize: 0.1 // 10% of balance per trade
            });
        }
        return this.userStates.get(userId);
    }

    setupCommands() {
        // Start command
        this.bot.onText(/\/start/, (msg) => {
            if (!this.isAuthorized(msg.from.id)) {
                this.bot.sendMessage(msg.chat.id, '🚫 You are not authorized to use this bot.');
                return;
            }

            const welcomeMessage = `
🚀 **Meme Token Trading Bot - 30 Day Challenge** 🚀

**Target: $10 → $8,080 in 30 days (25% daily)**

**Commands:**
/status - View current trading status
/start_plan - Begin the 30-day challenge
/pause - Pause trading
/resume - Resume trading
/search [token] - Search for token data
/watchlist - Manage your watchlist
/help - Show all commands

⚠️ **WARNING**: Meme token trading is extremely risky. Only trade what you can afford to lose!
            `;

            this.bot.sendMessage(msg.chat.id, welcomeMessage, { parse_mode: 'Markdown' });
        });

        // Status command
        this.bot.onText(/\/status/, (msg) => {
            if (!this.isAuthorized(msg.from.id)) return;
            this.showStatus(msg.chat.id, msg.from.id);
        });

        // Start plan command
        this.bot.onText(/\/start_plan/, (msg) => {
            if (!this.isAuthorized(msg.from.id)) return;
            this.startTradingPlan(msg.chat.id, msg.from.id);
        });

        // Search token command
        this.bot.onText(/\/search (.+)/, (msg, match) => {
            if (!this.isAuthorized(msg.from.id)) return;
            const tokenSymbol = match[1];
            this.searchToken(msg.chat.id, tokenSymbol);
        });

        // Pause/Resume commands
        this.bot.onText(/\/pause/, (msg) => {
            if (!this.isAuthorized(msg.from.id)) return;
            this.pauseTrading(msg.chat.id, msg.from.id);
        });

        this.bot.onText(/\/resume/, (msg) => {
            if (!this.isAuthorized(msg.from.id)) return;
            this.resumeTrading(msg.chat.id, msg.from.id);
        });

        // Add new trading commands
        this.bot.onText(/\/trade (.+) (.+)/, (msg, match) => {
            if (!this.isAuthorized(msg.from.id)) return;
            const tokenSymbol = match[1];
            const amount = parseFloat(match[2]);
            this.executeTrade(msg.chat.id, msg.from.id, tokenSymbol, amount, 'buy');
        });

        this.bot.onText(/\/sell (.+) (.+)/, (msg, match) => {
            if (!this.isAuthorized(msg.from.id)) return;
            const tokenSymbol = match[1];
            const amount = parseFloat(match[2]);
            this.executeTrade(msg.chat.id, msg.from.id, tokenSymbol, amount, 'sell');
        });

        this.bot.onText(/\/positions/, (msg) => {
            if (!this.isAuthorized(msg.from.id)) return;
            this.showPositions(msg.chat.id, msg.from.id);
        });

        this.bot.onText(/\/wallet/, (msg) => {
            if (!this.isAuthorized(msg.from.id)) return;
            this.showWalletInfo(msg.chat.id, msg.from.id);
        });

        this.bot.onText(/\/set_stop_loss (.+) (.+)/, (msg, match) => {
            if (!this.isAuthorized(msg.from.id)) return;
            const tokenSymbol = match[1];
            const stopLossPercent = parseFloat(match[2]);
            this.setStopLoss(msg.chat.id, msg.from.id, tokenSymbol, stopLossPercent);
        });

        this.bot.onText(/\/auto_trade (on|off)/, (msg, match) => {
            if (!this.isAuthorized(msg.from.id)) return;
            const enabled = match[1] === 'on';
            this.toggleAutoTrade(msg.chat.id, msg.from.id, enabled);
        });

        // Help command
        this.bot.onText(/\/help/, (msg) => {
            if (!this.isAuthorized(msg.from.id)) return;
            this.showHelp(msg.chat.id);
        });
    }

    async showStatus(chatId, userId) {
        const userState = this.getUserState(userId);
        const currentPlan = TRADING_PLAN[userState.currentDay - 1];
        
        const statusMessage = `
📊 **Trading Status - Day ${userState.currentDay}/30**

💰 **Current Balance**: $${userState.currentBalance.toFixed(2)}
🎯 **Target Profit**: $${currentPlan.profit.toFixed(2)} (25%)
🏆 **Expected Balance**: $${currentPlan.expected.toFixed(2)}

📊 **Progress**: ${((userState.currentDay - 1) / 30 * 100).toFixed(1)}%
🎲 **Total Trades**: ${userState.totalTrades}
✅ **Success Rate**: ${userState.totalTrades > 0 ? ((userState.successfulTrades / userState.totalTrades) * 100).toFixed(1) : 0}%
📈 **Active Positions**: ${userState.positions.length}

🔄 **Status**: ${userState.isActive ? '🟢 Active' : '🔴 Paused'}
🤖 **Auto Trade**: ${userState.autoTrade ? '🟢 Enabled' : '🔴 Disabled'}
🛡️ **Stop Loss**: ${userState.stopLossEnabled ? '🟢 Enabled' : '🔴 Disabled'}
📅 **Start Date**: ${userState.startDate || 'Not started'}

**Remaining to complete day**: $${Math.max(0, currentPlan.expected - userState.currentBalance).toFixed(2)}
        `;

        await this.bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
    }

    async startTradingPlan(chatId, userId) {
        const userState = this.getUserState(userId);
        
        if (userState.isActive) {
            this.bot.sendMessage(chatId, '⚠️ Trading plan is already active!');
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
💰 Starting Balance: $${userState.currentBalance}
🎯 Day 1 Target: $12.50 (+$2.50)

Good luck! Remember to manage your risk carefully.

Use /search [token] to find tokens to trade.
        `;

        this.bot.sendMessage(chatId, startMessage, { parse_mode: 'Markdown' });
    }

    async searchToken(chatId, tokenSymbol) {
        try {
            this.bot.sendMessage(chatId, `🔍 Searching for ${tokenSymbol}...`);
            
            const tokenData = await this.getPumpFunTokenData(tokenSymbol);
            
            if (tokenData) {
                const message = `
🪙 **${tokenData.symbol}** (${tokenData.name})

💰 **Price**: $${tokenData.price}
📊 **Market Cap**: $${tokenData.marketCap}
🔄 **24h Volume**: $${tokenData.volume24h}
📈 **24h Change**: ${tokenData.change24h}%
💧 **Liquidity**: $${tokenData.liquidity}

⚠️ **Risk Level**: ${this.calculateRiskLevel(tokenData)}

Use /trade ${tokenSymbol} to execute a trade (coming soon)
                `;
                
                this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
            } else {
                this.bot.sendMessage(chatId, `❌ Token ${tokenSymbol} not found or no data available.`);
            }
        } catch (error) {
            console.error('Search error:', error);
            this.bot.sendMessage(chatId, '❌ Error searching for token. Please try again.');
        }
    }

    async getPumpFunTokenData(tokenSymbol) {
        try {
            const query = `
            query {
                Solana {
                    DEXTrades(
                        where: {
                            Trade: {Currency: {Symbol: {is: "${tokenSymbol}"}}}
                            Transaction: {Result: {Success: true}}
                        }
                        orderBy: {descending: Block_Time}
                        limit: 1
                    ) {
                        Trade {
                            Currency {
                                Symbol
                                Name
                                MintAddress
                            }
                            Price
                        }
                        Block {
                            Time
                        }
                    }
                }
            }`;

            const response = await axios.post('https://graphql.bitquery.io/', {
                query: query
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-KEY': BITQUERY_API_KEY
                }
            });

            if (response.data.data.Solana.DEXTrades.length > 0) {
                const trade = response.data.data.Solana.DEXTrades[0];
                return {
                    symbol: trade.Trade.Currency.Symbol,
                    name: trade.Trade.Currency.Name,
                    price: trade.Trade.Price,
                    marketCap: 'N/A', // Would need additional query
                    volume24h: 'N/A', // Would need additional query
                    change24h: 'N/A', // Would need additional query
                    liquidity: 'N/A'  // Would need additional query
                };
            }
            
            return null;
        } catch (error) {
            console.error('Bitquery API error:', error);
            return null;
        }
    }

    calculateRiskLevel(tokenData) {
        // Simple risk assessment logic
        const price = parseFloat(tokenData.price);
        
        if (price < 0.000001) return '🔴 VERY HIGH';
        if (price < 0.0001) return '🟠 HIGH';
        if (price < 0.01) return '🟡 MEDIUM';
        return '🟢 LOW';
    }

    async pauseTrading(chatId, userId) {
        const userState = this.getUserState(userId);
        userState.isActive = false;
        await this.saveUserStates();
        this.bot.sendMessage(chatId, '⏸️ Trading paused.');
    }

    async resumeTrading(chatId, userId) {
        const userState = this.getUserState(userId);
        userState.isActive = true;
        await this.saveUserStates();
        this.bot.sendMessage(chatId, '▶️ Trading resumed.');
    }

    async showWatchlist(chatId, userId) {
        const userState = this.getUserState(userId);
        
        if (userState.watchlist.length === 0) {
            this.bot.sendMessage(chatId, '📝 Your watchlist is empty. Use /search to find tokens first.');
            return;
        }

        let message = '📝 **Your Watchlist:**\n\n';
        userState.watchlist.forEach((token, index) => {
            message += `${index + 1}. ${token.symbol} - $${token.price}\n`;
        });

        this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    showHelp(chatId) {
        const helpMessage = `
📚 **Bot Commands Help**

**Trading Commands:**
/start_plan - Begin the 30-day challenge
/status - View current progress
/pause - Pause automated trading
/resume - Resume trading

**Live Trading:**
/trade [token] [amount] - Buy token (e.g., /trade PEPE 50)
/sell [token] [amount] - Sell token amount or %
/positions - Show active positions
/wallet - Show wallet balance

**Risk Management:**
/set_stop_loss [token] [%] - Set stop loss (e.g., /set_stop_loss PEPE 15)
/auto_trade on/off - Toggle automated trading

**Research Commands:**
/search [token] - Get token information
/watchlist - View saved tokens

**Example Usage:**
/trade PEPE 25 - Buy $25 worth of PEPE
/sell PEPE 50% - Sell 50% of PEPE position
/set_stop_loss PEPE 10 - Set 10% stop loss on PEPE

**Risk Warning:** 
Trading meme tokens involves substantial risk of loss.
        `;

        this.bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
    }

    // ============ TRADING EXECUTION METHODS ============

    async executeTrade(chatId, userId, tokenSymbol, amount, side) {
        try {
            if (!this.wallet) {
                this.bot.sendMessage(chatId, '❌ No wallet configured. Please set PRIVATE_KEY in environment.');
                return;
            }

            const userState = this.getUserState(userId);
            
            if (!userState.isActive) {
                this.bot.sendMessage(chatId, '⚠️ Trading plan is not active. Use /start_plan first.');
                return;
            }

            this.bot.sendMessage(chatId, `🔄 Executing ${side.toUpperCase()} order for ${tokenSymbol}...`);

            // Get token information
            const tokenInfo = await this.getTokenInfo(tokenSymbol);
            if (!tokenInfo) {
                this.bot.sendMessage(chatId, `❌ Token ${tokenSymbol} not found.`);
                return;
            }

            // Calculate trade size
            const tradeSize = side === 'buy' ? amount : this.calculateSellAmount(userState, tokenSymbol, amount);
            
            if (side === 'buy' && tradeSize > userState.currentBalance * userState.maxPositionSize) {
                this.bot.sendMessage(chatId, `❌ Trade size exceeds maximum position size (${userState.maxPositionSize * 100}% of balance)`);
                return;
            }

            // Get quote from Jupiter
            const quote = await this.getJupiterQuote(tokenInfo.mint, side, tradeSize);
            if (!quote) {
                this.bot.sendMessage(chatId, '❌ Unable to get price quote.');
                return;
            }

            // Execute the trade
            const tradeResult = await this.executeJupiterSwap(quote, side);
            
            if (tradeResult.success) {
                // Update user state
                await this.updatePositionAfterTrade(userId, tokenSymbol, tokenInfo, side, tradeSize, tradeResult);
                
                const message = `
✅ **Trade Executed Successfully!**

🔄 **Type**: ${side.toUpperCase()}
🪙 **Token**: ${tokenSymbol}
💰 **Amount**: ${tradeSize.toFixed(2)}
💱 **Price**: ${tradeResult.price}
🧾 **TX**: \`${tradeResult.signature}\`
⛽ **Fee**: ${tradeResult.fee}

💼 **New Balance**: ${userState.currentBalance.toFixed(2)}
                `;
                
                this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
                
                // Set up stop loss if enabled
                if (side === 'buy' && userState.stopLossEnabled) {
                    this.setupStopLoss(userId, tokenSymbol, tradeResult.price);
                }
                
            } else {
                this.bot.sendMessage(chatId, `❌ Trade failed: ${tradeResult.error}`);
            }

        } catch (error) {
            console.error('Trade execution error:', error);
            this.bot.sendMessage(chatId, '❌ Trade execution failed. Please try again.');
        }
    }

    async getTokenInfo(tokenSymbol) {
        try {
            // First try to get from Jupiter token list
            const response = await axios.get('https://token.jup.ag/all');
            const token = response.data.find(t => 
                t.symbol.toLowerCase() === tokenSymbol.toLowerCase()
            );
            
            if (token) {
                return {
                    symbol: token.symbol,
                    name: token.name,
                    mint: token.address,
                    decimals: token.decimals
                };
            }
            
            return null;
        } catch (error) {
            console.error('Token info error:', error);
            return null;
        }
    }

    async getJupiterQuote(tokenMint, side, amount) {
        try {
            const inputMint = side === 'buy' ? 'So11111111111111111111111111111111111111112' : tokenMint; // SOL or token
            const outputMint = side === 'buy' ? tokenMint : 'So11111111111111111111111111111111111111112';
            const amountInSmallestUnit = side === 'buy' ? 
                Math.floor(amount * LAMPORTS_PER_SOL) : 
                Math.floor(amount * Math.pow(10, 6)); // Assuming 6 decimals for most tokens

            const quoteResponse = await axios.get(`${JUPITER_API_URL}/quote`, {
                params: {
                    inputMint,
                    outputMint,
                    amount: amountInSmallestUnit,
                    slippageBps: Math.floor(MAX_SLIPPAGE * 10000) // Convert to basis points
                }
            });

            return quoteResponse.data;
        } catch (error) {
            console.error('Jupiter quote error:', error);
            return null;
        }
    }

    async executeJupiterSwap(quote, side) {
        try {
            // Get swap transaction
            const swapResponse = await axios.post(`${JUPITER_API_URL}/swap`, {
                quoteResponse: quote,
                userPublicKey: this.wallet.publicKey.toString(),
                wrapAndUnwrapSol: true
            });

            const { swapTransaction } = swapResponse.data;
            
            // Deserialize and sign transaction
            const transaction = Transaction.from(Buffer.from(swapTransaction, 'base64'));
            transaction.sign(this.wallet);

            // Send transaction
            const signature = await this.connection.sendRawTransaction(transaction.serialize(), {
                skipPreflight: false,
                preflightCommitment: 'confirmed'
            });

            // Wait for confirmation
            await this.connection.confirmTransaction(signature, 'confirmed');

            // Get transaction details for reporting
            const txInfo = await this.connection.getTransaction(signature);
            
            return {
                success: true,
                signature,
                price: this.calculatePriceFromQuote(quote, side),
                fee: txInfo?.meta?.fee ? txInfo.meta.fee / LAMPORTS_PER_SOL : 0.005 // Estimate if not available
            };

        } catch (error) {
            console.error('Swap execution error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    calculatePriceFromQuote(quote, side) {
        const inputAmount = parseInt(quote.inAmount);
        const outputAmount = parseInt(quote.outAmount);
        
        if (side === 'buy') {
            return (inputAmount / LAMPORTS_PER_SOL) / (outputAmount / Math.pow(10, 6));
        } else {
            return (outputAmount / LAMPORTS_PER_SOL) / (inputAmount / Math.pow(10, 6));
        }
    }

    calculateSellAmount(userState, tokenSymbol, amountInput) {
        const position = userState.positions.find(p => p.symbol === tokenSymbol);
        if (!position) return 0;

        if (typeof amountInput === 'string' && amountInput.includes('%')) {
            const percentage = parseFloat(amountInput.replace('%', '')) / 100;
            return position.amount * percentage;
        }
        
        return Math.min(amountInput, position.amount);
    }

    async updatePositionAfterTrade(userId, tokenSymbol, tokenInfo, side, tradeSize, tradeResult) {
        const userState = this.getUserState(userId);
        
        // Find existing position
        let position = userState.positions.find(p => p.symbol === tokenSymbol);
        
        if (side === 'buy') {
            const tokenAmount = parseInt(tradeResult.quote?.outAmount || 0) / Math.pow(10, tokenInfo.decimals || 6);
            
            if (position) {
                // Update existing position
                const totalValue = (position.amount * position.avgPrice) + tradeSize;
                const totalAmount = position.amount + tokenAmount;
                position.avgPrice = totalValue / totalAmount;
                position.amount = totalAmount;
            } else {
                // Create new position
                position = {
                    symbol: tokenSymbol,
                    mint: tokenInfo.mint,
                    amount: tokenAmount,
                    avgPrice: tradeResult.price,
                    stopLoss: null,
                    entryTime: new Date().toISOString()
                };
                userState.positions.push(position);
            }
            
            userState.currentBalance -= tradeSize;
            
        } else { // sell
            if (position) {
                const sellValue = tradeSize * tradeResult.price;
                position.amount -= tradeSize;
                userState.currentBalance += sellValue;
                
                // Remove position if fully sold
                if (position.amount <= 0.001) {
                    userState.positions = userState.positions.filter(p => p.symbol !== tokenSymbol);
                }
                
                // Check if trade was profitable
                const profit = sellValue - (tradeSize * position.avgPrice);
                if (profit > 0) userState.successfulTrades++;
            }
        }
        
        // Record trade history
        userState.tradeHistory.push({
            symbol: tokenSymbol,
            side,
            amount: tradeSize,
            price: tradeResult.price,
            timestamp: new Date().toISOString(),
            signature: tradeResult.signature
        });
        
        userState.totalTrades++;
        await this.saveUserStates();
    }

    async showPositions(chatId, userId) {
        const userState = this.getUserState(userId);
        
        if (userState.positions.length === 0) {
            this.bot.sendMessage(chatId, '📊 No active positions.');
            return;
        }

        let message = '📊 **Active Positions:**\n\n';
        let totalValue = 0;
        
        for (const position of userState.positions) {
            const currentPrice = await this.getCurrentPrice(position.mint);
            const currentValue = position.amount * currentPrice;
            const pnl = currentValue - (position.amount * position.avgPrice);
            const pnlPercent = (pnl / (position.amount * position.avgPrice)) * 100;
            
            totalValue += currentValue;
            
            message += `🪙 **${position.symbol}**\n`;
            message += `💰 Amount: ${position.amount.toFixed(4)}\n`;
            message += `📈 Avg Price: ${position.avgPrice.toFixed(6)}\n`;
            message += `💱 Current: ${currentPrice.toFixed(6)}\n`;
            message += `💼 Value: ${currentValue.toFixed(2)}\n`;
            message += `${pnl >= 0 ? '🟢' : '🔴'} P&L: ${pnl.toFixed(2)} (${pnlPercent.toFixed(1)}%)\n`;
            if (position.stopLoss) {
                message += `🛡️ Stop Loss: ${position.stopLoss.toFixed(6)}\n`;
            }
            message += '\n';
        }
        
        message += `**Portfolio Value**: ${(userState.currentBalance + totalValue).toFixed(2)}`;
        
        this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    async showWalletInfo(chatId, userId) {
        if (!this.wallet) {
            this.bot.sendMessage(chatId, '❌ No wallet configured.');
            return;
        }

        try {
            const balance = await this.connection.getBalance(this.wallet.publicKey);
            const solBalance = balance / LAMPORTS_PER_SOL;
            
            const message = `
🏦 **Wallet Information**

📍 **Address**: \`${this.wallet.publicKey.toString()}\`
💰 **SOL Balance**: ${solBalance.toFixed(4)} SOL
🔗 **Network**: ${SOLANA_RPC_URL.includes('devnet') ? 'Devnet' : 'Mainnet'}

⚠️ **Never share your private key!**
            `;
            
            this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            this.bot.sendMessage(chatId, '❌ Error fetching wallet information.');
        }
    }

    async getCurrentPrice(tokenMint) {
        try {
            const quote = await this.getJupiterQuote(tokenMint, 'sell', 1);
            return this.calculatePriceFromQuote(quote, 'sell');
        } catch (error) {
            console.error('Price fetch error:', error);
            return 0;
        }
    }

    // ============ STOP LOSS & AUTOMATION ============

    setupStopLoss(userId, tokenSymbol, entryPrice) {
        const userState = this.getUserState(userId);
        const position = userState.positions.find(p => p.symbol === tokenSymbol);
        
        if (position) {
            position.stopLoss = entryPrice * (1 - DEFAULT_STOP_LOSS);
            this.saveUserStates();
        }
    }

    async setStopLoss(chatId, userId, tokenSymbol, stopLossPercent) {
        const userState = this.getUserState(userId);
        const position = userState.positions.find(p => p.symbol === tokenSymbol);
        
        if (!position) {
            this.bot.sendMessage(chatId, `❌ No position found for ${tokenSymbol}`);
            return;
        }
        
        position.stopLoss = position.avgPrice * (1 - stopLossPercent / 100);
        await this.saveUserStates();
        
        this.bot.sendMessage(chatId, 
            `🛡️ Stop loss set for ${tokenSymbol} at ${position.stopLoss.toFixed(6)} (-${stopLossPercent}%)`
        );
    }

    async toggleAutoTrade(chatId, userId, enabled) {
        const userState = this.getUserState(userId);
        userState.autoTrade = enabled;
        await this.saveUserStates();
        
        this.bot.sendMessage(chatId, 
            `🤖 Auto trading ${enabled ? 'enabled' : 'disabled'}`
        );
    }

    startPriceMonitoring() {
        // Monitor prices every 30 seconds
        setInterval(async () => {
            await this.checkStopLosses();
            await this.checkAutoTradeSignals();
        }, 30000);
    }

    async checkStopLosses() {
        for (const [userId, userState] of this.userStates) {
            if (!userState.stopLossEnabled) continue;
            
            for (const position of userState.positions) {
                if (!position.stopLoss) continue;
                
                const currentPrice = await this.getCurrentPrice(position.mint);
                
                if (currentPrice <= position.stopLoss) {
                    // Trigger stop loss
                    await this.executeStopLoss(userId, position, currentPrice);
                }
            }
        }
    }

    async executeStopLoss(userId, position, currentPrice) {
        try {
            // Execute sell order
            const quote = await this.getJupiterQuote(position.mint, 'sell', position.amount);
            const tradeResult = await this.executeJupiterSwap(quote, 'sell');
            
            if (tradeResult.success) {
                // Update position
                await this.updatePositionAfterTrade(userId, position.symbol, 
                    { mint: position.mint }, 'sell', position.amount, tradeResult);
                
                // Notify user
                const userState = this.getUserState(userId);
                const chatId = userId; // Assuming userId is also chatId
                
                const message = `
🛡️ **STOP LOSS TRIGGERED**

🪙 **Token**: ${position.symbol}
💰 **Amount Sold**: ${position.amount.toFixed(4)}
💱 **Price**: ${currentPrice.toFixed(6)}
📉 **Loss**: ${((currentPrice - position.avgPrice) / position.avgPrice * 100).toFixed(1)}%
🧾 **TX**: \`${tradeResult.signature}\`

Position closed automatically.
                `;
                
                this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
            }
        } catch (error) {
            console.error('Stop loss execution error:', error);
        }
    }

    async checkAutoTradeSignals() {
        // Implement your auto-trading logic here
        // This could include technical analysis, momentum trading, etc.
        
        for (const [userId, userState] of this.userStates) {
            if (!userState.autoTrade || !userState.isActive) continue;
            
            // Example: Simple momentum strategy
            await this.executeMomentumStrategy(userId, userState);
        }
    }

    async executeMomentumStrategy(userId, userState) {
        // Example simple momentum strategy
        // This is a placeholder - implement your actual strategy logic
        
        try {
            // Get trending tokens from your watchlist or a predefined list
            const trendingTokens = ['PEPE', 'BONK', 'WIF']; // Example tokens
            
            for (const tokenSymbol of trendingTokens) {
                const tokenInfo = await this.getTokenInfo(tokenSymbol);
                if (!tokenInfo) continue;
                
                // Simple logic: if no position and trend is strong, buy small amount
                const hasPosition = userState.positions.some(p => p.symbol === tokenSymbol);
                
                if (!hasPosition && userState.currentBalance > 10) {
                    const tradeSize = Math.min(userState.currentBalance * 0.05, 25); // 5% or $25 max
                    
                    // This would need actual technical analysis
                    const shouldBuy = Math.random() > 0.8; // Placeholder logic
                    
                    if (shouldBuy) {
                        // Execute auto buy (would call executeTrade method)
                        console.log(`Auto-buying ${tokenSymbol} for user ${userId}`);
                    }
                }
            }
        } catch (error) {
            console.error('Auto trade strategy error:', error);
        }
    }

    // Method to advance to next day (call this when daily target is met)
    async advanceDay(userId) {
        const userState = this.getUserState(userId);
        
        if (userState.currentDay >= 30) {
            // Challenge completed!
            return this.completeChallenge(userId);
        }

        userState.currentDay++;
        userState.currentBalance = TRADING_PLAN[userState.currentDay - 1].balance;
        await this.saveUserStates();
    }

    async completeChallenge(userId) {
        const userState = this.getUserState(userId);
        userState.isActive = false;
        
        // Send completion message
        const completionMessage = `
🎉 **CHALLENGE COMPLETED!** 🎉

🏆 You've successfully completed the 30-day challenge!
💰 Final Balance: $${userState.currentBalance.toFixed(2)}
📈 Total Return: ${((userState.currentBalance - 10) / 10 * 100).toFixed(1)}%
🎯 Trades Executed: ${userState.totalTrades}
✅ Success Rate: ${((userState.successfulTrades / userState.totalTrades) * 100).toFixed(1)}%

Congratulations on your dedication and risk management! 🚀
        `;

        // You would send this to the user's chat
        await this.saveUserStates();
        return completionMessage;
    }
}

// Initialize bot
const bot = new TradingBot();

console.log('🤖 Telegram Meme Token Trading Bot Started!');
console.log('💡 Make sure to set your environment variables:');
console.log('   - TELEGRAM_TOKEN');
console.log('   - BITQUERY_API_KEY');
console.log('   - AUTHORIZED_USERS (optional)');

// Graceful shutdown
process.on('SIGTERM', async () => {
    await bot.saveUserStates();
    process.exit(0);
});

process.on('SIGINT', async () => {
    await bot.saveUserStates();
    process.exit(0);
});