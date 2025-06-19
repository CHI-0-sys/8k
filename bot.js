require('dotenv').config();
console.log("env loaded");
console.log("TELEGRAM_TOKEN:",process.env.TELEGRAM_TOKEN ? "Loaded" : "Missing");
console.log("BITQUERY_API_KEY:",process.env.BITQUERY_API_KEY ? "Loaded" : "Missing");
console.log("AUTHORISED_USERS:",process.env.AUTHORIZED_USERS);

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const { Connection, PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { Token, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const bs58 = require('bs58');

// Configuration
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY;
const AUTHORIZED_USERS = process.env.AUTHORIZED_USERS ? process.env.AUTHORIZED_USERS.split(',') : [];
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PRIVATE_KEY = process.env.PRIVATE_KEY; // Base58 encoded private key

// Hosting Configuration
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // e.g., https://your-app.herokuapp.com/webhook
const USE_WEBHOOK = process.env.USE_WEBHOOK === 'true';

// Trading Configuration
const MAX_SLIPPAGE = 0.05; // 5% maximum slippage
const DEFAULT_STOP_LOSS = 0.15; // 15% stop loss
const JUPITER_API_URL = 'https://quote-api.jup.ag/v6';
const RAYDIUM_API_URL = 'https://api.raydium.io/v2';

// Trading Plan Data (keeping your existing plan)
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

        this.userStates = new Map();
        this.activeTrades = new Map();
        this.priceAlerts = new Map();
        
        // Initialize Solana connection
        this.connection = new Connection(SOLANA_RPC_URL, 'confirmed');
        this.wallet = PRIVATE_KEY ? Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY)) : null;
        
        this.setupCommands();
        this.loadUserStates();
        this.startPriceMonitoring();
        this.setupExpressRoutes();
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
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({ 
                status: 'healthy',
                timestamp: new Date().toISOString(),
                bot_username: this.bot.options?.username || 'unknown'
            });
        });

        // Status endpoint
        this.app.get('/status', (req, res) => {
            res.json({
                users: this.userStates.size,
                activeTrades: this.activeTrades.size,
                priceAlerts: this.priceAlerts.size,
                walletConfigured: !!this.wallet,
                webhookMode: USE_WEBHOOK
            });
        });

        // Webhook endpoint
        this.app.post('/webhook', (req, res) => {
            this.bot.processUpdate(req.body);
            res.sendStatus(200);
        });

        // Start Express server
        this.app.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 Server running on port ${PORT}`);
            if (USE_WEBHOOK) {
                console.log(`📡 Webhook endpoint: ${WEBHOOK_URL}/webhook`);
            }
        });
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
                walletAddress: null,
                autoTrade: false,
                stopLossEnabled: true,
                maxPositionSize: 0.1
            });
        }
        return this.userStates.get(userId);
    }

    setupCommands() {
        // Error handling for bot
        this.bot.on('error', (error) => {
            console.error('❌ Bot error:', error);
        });

        this.bot.on('polling_error', (error) => {
            console.error('❌ Polling error:', error);
        });

        // Start command
        this.bot.onText(/\/start/, async (msg) => {
            try {
                if (!this.isAuthorized(msg.from.id)) {
                    await this.bot.sendMessage(msg.chat.id, '🚫 You are not authorized to use this bot.');
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
/help - Show all commands

⚠️ **WARNING**: Meme token trading is extremely risky. Only trade what you can afford to lose!

Bot is running in ${USE_WEBHOOK ? 'webhook' : 'polling'} mode.
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

        // Help command
        this.bot.onText(/\/help/, async (msg) => {
            if (!this.isAuthorized(msg.from.id)) return;
            await this.showHelp(msg.chat.id);
        });

        // Test command to verify bot is working
        this.bot.onText(/\/test/, async (msg) => {
            try {
                await this.bot.sendMessage(msg.chat.id, '✅ Bot is working correctly!');
            } catch (error) {
                console.error('Test command error:', error);
            }
        });
    }

    async showStatus(chatId, userId) {
        try {
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
📅 **Start Date**: ${userState.startDate || 'Not started'}

**Remaining to complete day**: $${Math.max(0, currentPlan.expected - userState.currentBalance).toFixed(2)}
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
            `;

            await this.bot.sendMessage(chatId, startMessage, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Start trading plan error:', error);
        }
    }

    async searchToken(chatId, tokenSymbol) {
        try {
            await this.bot.sendMessage(chatId, `🔍 Searching for ${tokenSymbol}...`);
            
            // Placeholder search result
            const message = `
🪙 **${tokenSymbol.toUpperCase()}**

⚠️ Token search functionality is under development.
This would normally show:
- Current price
- Market cap
- 24h volume
- Risk assessment

Use this as a demo for now.
            `;
            
            await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Search error:', error);
            await this.bot.sendMessage(chatId, '❌ Error searching for token. Please try again.');
        }
    }

    showHelp(chatId) {
        const helpMessage = `
📚 **Bot Commands Help**

**Basic Commands:**
/start - Welcome message and bot info
/status - View current progress
/start_plan - Begin the 30-day challenge
/search [token] - Get basic token info
/test - Test if bot is responding
/help - Show this help message

**Trading Commands (Coming Soon):**
/trade [token] [amount] - Buy token
/sell [token] [amount] - Sell token
/positions - Show active positions
/wallet - Show wallet info

**Bot Status:**
- Mode: ${USE_WEBHOOK ? 'Webhook' : 'Polling'}
- Wallet: ${this.wallet ? 'Configured' : 'Not configured'}
- Users: ${this.userStates.size}

⚠️ **Risk Warning:** 
Trading meme tokens involves substantial risk of loss.
        `;

        this.bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
    }

    startPriceMonitoring() {
        // Placeholder for price monitoring
        setInterval(() => {
            // Price monitoring logic would go here
            console.log('🔍 Monitoring prices...');
        }, 60000); // Every minute
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

console.log('🤖 Telegram Meme Token Trading Bot Started!');
console.log('💡 Environment variables status:');
console.log(`   - TELEGRAM_TOKEN: ${process.env.TELEGRAM_TOKEN ? '✅' : '❌'}`);
console.log(`   - WEBHOOK_URL: ${WEBHOOK_URL || '❌ Not set'}`);
console.log(`   - USE_WEBHOOK: ${USE_WEBHOOK}`);
console.log(`   - PORT: ${PORT}`);

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