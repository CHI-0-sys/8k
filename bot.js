require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const { Connection, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL, Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = require('node-fetch');

// ============ CONFIGURATION ============
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const AUTHORIZED_USERS = process.env.AUTHORIZED_USERS?.split(',') || [];
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const PORT = process.env.PORT || 3000;
const USE_WEBHOOK = process.env.USE_WEBHOOK === 'true';
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// Trading Parameters
const DAILY_PROFIT_TARGET = 0.25; // 25%
const DAILY_STOP_LOSS = 0.05; // 5%
const PER_TRADE_PROFIT_TARGET = 0.10; // 10% default
const PER_TRADE_STOP_LOSS = 0.02; // 2%
const SCALP_PROFIT_MIN = 0.05; // 5%
const SCALP_PROFIT_MAX = 0.10; // 10%
const EXTENDED_HOLD_MINUTES = 15;
const EXTENDED_HOLD_TARGET = 0.25; // 25%
const COOLDOWN_HOURS = 24;
const MIN_LIQUIDITY_USD = 8000;
const VOLUME_SPIKE_MULTIPLIER = 1.8;
const LARGE_SELL_THRESHOLD = 500;
const WHALE_DETECTION_WINDOW = 3;
const BASE_PRIORITY_FEE_SOL = 0.001;
const HOT_LAUNCH_PRIORITY_FEE_SOL = 0.003;

// DEX Configuration
const JUPITER_API_URL = 'https://quote-api.jup.ag/v6';
const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ============ BITQUERY V2 CLIENT ============
class BitqueryClient {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseURL = "https://streaming.bitquery.io/eap";
        this.headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        };
    }

    async query(graphql, variables = {}) {
        try {
            console.log('[Bitquery] Executing query...');
            const response = await axios.post(this.baseURL, {
                query: graphql,
                variables: JSON.stringify(variables)
            }, {
                headers: this.headers,
                timeout: 15000
            });

            if (response.data.errors) {
                console.error('[Bitquery] Errors:', JSON.stringify(response.data.errors, null, 2));
                return null;
            }

            console.log('[Bitquery] Query successful, processing results...');
            return response.data.data;
        } catch (error) {
            console.error('[Bitquery] Query failed:', error.message);
            return null;
        }
    }

    async getGraduatingTokens() {
        const query = `{
            Solana {
                DEXPools(
                    limitBy: {by: Pool_Market_BaseCurrency_MintAddress, count: 1}
                    limit: {count: 100}
                    orderBy: {descending: Pool_Quote_PostAmountInUSD}
                    where: {
                        Pool: {
                            Base: {PostAmount: {gt: "206900000", lt: "980000000"}}, 
                            Dex: {ProgramAddress: {is: "${PUMP_FUN_PROGRAM}"}}, 
                            Market: {QuoteCurrency: {MintAddress: {in: ["11111111111111111111111111111111", "${SOL_MINT}"]}}}
                        }, 
                        Transaction: {Result: {Success: true}}
                    }
                ) {
                    Bonding_Curve_Progress_precentage: calculate(expression: "100 - ((($Pool_Base_Balance - 206900000) * 100) / 793100000)")
                    Pool {
                        Market {
                            BaseCurrency {
                                MintAddress
                                Name
                                Symbol
                            }
                            MarketAddress
                            QuoteCurrency {
                                MintAddress
                                Name
                                Symbol
                            }
                        }
                        Dex {
                            ProtocolName
                            ProtocolFamily
                        }
                        Base {
                            Balance: PostAmount
                        }
                        Quote {
                            PostAmount
                            PriceInUSD
                            PostAmountInUSD
                        }
                    }
                }
            }
        }`;

        const data = await this.query(query);
        if (!data?.Solana?.DEXPools) {
            console.log('[Bitquery] No pools returned');
            return [];
        }

        const allTokens = data.Solana.DEXPools.map(pool => {
            const progress = parseFloat(pool.Bonding_Curve_Progress_precentage || 0);
            return {
                address: pool.Pool.Market.BaseCurrency.MintAddress,
                symbol: pool.Pool.Market.BaseCurrency.Symbol || 'UNKNOWN',
                name: pool.Pool.Market.BaseCurrency.Name,
                bondingProgress: progress,
                liquidityUSD: parseFloat(pool.Pool.Quote.PostAmountInUSD) || 0,
                priceUSD: parseFloat(pool.Pool.Quote.PriceInUSD) || 0,
                lastUpdate: Date.now()
            };
        });

        console.log(`[Bitquery] Total pools: ${allTokens.length}`);
        if (allTokens.length > 0) {
            console.log(`[Bitquery] Bonding curve range: ${Math.min(...allTokens.map(t => t.bondingProgress)).toFixed(1)}% - ${Math.max(...allTokens.map(t => t.bondingProgress)).toFixed(1)}%`);
            console.log(`[Bitquery] Liquidity range: ${Math.min(...allTokens.map(t => t.liquidityUSD)).toFixed(0)} - ${Math.max(...allTokens.map(t => t.liquidityUSD)).toFixed(0)}`);
        }

        const filtered = allTokens.filter(t => 
            t.bondingProgress >= 90 && 
            t.bondingProgress <= 98 &&
            t.liquidityUSD >= MIN_LIQUIDITY_USD
        );

        console.log(`[Bitquery] After filtering (90-98% curve, >${MIN_LIQUIDITY_USD} liq): ${filtered.length} tokens`);
        
        if (filtered.length > 0) {
            filtered.forEach(t => {
                console.log(`  - ${t.symbol}: ${t.bondingProgress.toFixed(1)}% curve, ${t.liquidityUSD.toFixed(0)} liq`);
            });
        }

        return filtered;
    }

    async getVolumeHistory(tokenAddress) {
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
    
        const data = await this.query(query);
        if (!data?.Solana) return { recent: 0, previous: 0, spike: false };
    
        const recentVol = (data.Solana.recent || []).reduce((sum, p) => {
            const v = Number(p?.Pool?.Quote?.PostAmountInUSD) || 0;
            return sum + v;
        }, 0);
    
        const prevVol = (data.Solana.previous || []).reduce((sum, p) => {
            const v = Number(p?.Pool?.Quote?.PostAmountInUSD) || 0;
            return sum + v;
        }, 0);
    
        const ABS_SPIKE_THRESHOLD = 100;
        let spikeRatio = 0;
        let hasSpike = false;
        if (prevVol > 0) {
            spikeRatio = recentVol / prevVol;
            hasSpike = spikeRatio >= VOLUME_SPIKE_MULTIPLIER;
        } else {
            spikeRatio = prevVol === 0 && recentVol > 0 ? Infinity : 0;
            hasSpike = recentVol >= ABS_SPIKE_THRESHOLD;
        }
    
        console.log(`[Volume] Recent: $${Number(recentVol).toFixed(0)}, Previous: $${Number(prevVol).toFixed(0)}, Ratio: ${isFinite(spikeRatio) ? spikeRatio.toFixed(2) + 'x' : (spikeRatio === Infinity ? '∞' : '0.00x')} ${hasSpike ? '✓' : '✗'}`);
    
        return {
            recent: recentVol,
            previous: prevVol,
            spike: hasSpike
        };
    }

    async detectWhaleDumps(tokenAddress) {
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

        const data = await this.query(query);
        if (!data?.Solana?.DEXPools) return false;

        const largeSells = data.Solana.DEXPools.filter(
            p => (p.Pool?.Quote?.PostAmountInUSD || 0) > LARGE_SELL_THRESHOLD
        );

        const hasWhale = largeSells.length > 0;
        console.log(`[Whale] Large sells (>${LARGE_SELL_THRESHOLD}): ${largeSells.length} ${hasWhale ? '✗ DUMP DETECTED' : '✓'}`);

        return hasWhale;
    }
}

// ============ TRADING ENGINE ============
class TradingEngine {
    constructor(bot, wallet, connection, bitquery) {
        this.bot = bot;
        this.wallet = wallet;
        this.connection = connection;
        this.bitquery = bitquery;
        this.userStates = new Map();
        this.isScanning = false;
        this.isRunning = false;
        this.JUPITER_QUOTE = `${JUPITER_API_URL}/quote`;
        this.JUPITER_SWAP = `${JUPITER_API_URL}/swap`;
    }

    getUserState(userId) {
        if (!this.userStates.has(userId)) {
            this.userStates.set(userId, {
                isActive: false,
                startingBalance: 20,
                currentBalance: 20,
                dailyStartBalance: 20,
                dailyProfit: 0,
                dailyProfitPercent: 0,
                currentDay: 1,
                totalTrades: 0,
                successfulTrades: 0,
                position: null,
                tradeHistory: [],
                lastTradeAt: 0,
                dailyResetAt: Date.now()
            });
        }
        return this.userStates.get(userId);
    }
    
    async tradingCycle() {
        if (this.isRunning) return;
        this.isRunning = true;

        try {
            console.log("\n=== Trading Cycle Start ===");

            // Get first authorized user or bot owner
            const userId = this.bot.ownerId || (AUTHORIZED_USERS.length > 0 ? AUTHORIZED_USERS[0] : null);
            if (!userId) {
                console.log("[Engine] No authorized user configured");
                return;
            }

            const opportunity = await this.findTradingOpportunity(userId);
            if (opportunity) {
                console.log(`[Engine] Opportunity: ${opportunity.symbol}`);
                await this.executeBuy(userId, opportunity);
            } else {
                console.log("[Engine] No trade opportunity this cycle.");
            }

        } catch (err) {
            console.error("[Engine] Error in trading cycle:", err.message);
        } finally {
            this.isRunning = false;
        }
    }

    async saveState() {
        try {
            const data = Object.fromEntries(this.userStates);
            await fs.writeFile('trading_state.json', JSON.stringify(data, null, 2));
        } catch (error) {
            console.error('[State] Save failed:', error.message);
        }
    }

    async loadState() {
        try {
            const data = await fs.readFile('trading_state.json', 'utf8');
            this.userStates = new Map(Object.entries(JSON.parse(data)));
            console.log(`[State] Loaded ${this.userStates.size} users`);
        } catch (error) {
            console.log('[State] No existing state, starting fresh');
        }
    }

    checkDailyReset(user) {
        const now = Date.now();
        const hoursSinceReset = (now - user.dailyResetAt) / 3600000;

        if (hoursSinceReset >= COOLDOWN_HOURS) {
            console.log('[Daily] Resetting daily counters');
            user.dailyStartBalance = user.currentBalance;
            user.dailyProfit = 0;
            user.dailyProfitPercent = 0;
            user.dailyResetAt = now;
            user.currentDay += 1;
            return true;
        }
        return false;
    }

    isDailyTargetHit(user) {
        return user.dailyProfitPercent >= DAILY_PROFIT_TARGET || 
               user.dailyProfitPercent <= -DAILY_STOP_LOSS;
    }

    // FIXED: Added missing calculateSlippage method
    calculateSlippage(liquidityUSD) {
        // Dynamic slippage based on liquidity
        // Higher liquidity = lower slippage needed
        if (liquidityUSD >= 50000) return 300; // 3%
        if (liquidityUSD >= 20000) return 500; // 5%
        if (liquidityUSD >= 10000) return 800; // 8%
        return 1200; // 12% for low liquidity
    }

    // FIXED: Added missing getCurrentPrice method
    async getCurrentPrice(tokenAddress) {
        try {
            // Get current price using Jupiter quote for 1 token
            const quote = await this.getJupiterQuote(
                tokenAddress,
                USDC_MINT,
                1000000000, // 1 token with 9 decimals
                300
            );

            if (!quote || !quote.outAmount) {
                console.log(`[Price] No quote for ${tokenAddress}`);
                return null;
            }

            // Price = USDC received / tokens sold
            const priceUSD = parseFloat(quote.outAmount) / 1000000; // USDC has 6 decimals
            return priceUSD;
        } catch (error) {
            console.error(`[Price] Error fetching price:`, error.message);
            return null;
        }
    }

    // FIXED: Added balance verification
    async verifyWalletBalance(requiredUSDC) {
        try {
            const usdcMint = new PublicKey(USDC_MINT);
            const walletPubkey = this.wallet.publicKey;

            // Get token accounts
            const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
                walletPubkey,
                { mint: usdcMint }
            );

            if (tokenAccounts.value.length === 0) {
                console.log('[Balance] No USDC token account found');
                return { success: false, balance: 0 };
            }

            const balance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
            console.log(`[Balance] USDC: ${balance}, Required: ${requiredUSDC}`);

            return {
                success: balance >= requiredUSDC,
                balance: balance
            };
        } catch (error) {
            console.error('[Balance] Verification failed:', error.message);
            return { success: false, balance: 0 };
        }
    }

    async findTradingOpportunity(userId) {
        if (this.isScanning) return null;
        this.isScanning = true;
    
        try {
            console.log('\n[Scanner] === STARTING TOKEN SCAN ===');
            const candidates = await this.bitquery.getGraduatingTokens();
    
            if (!candidates.length) {
                console.log('[Scanner] No candidates found at 90-98% bonding curve\n');
                return null;
            }
    
            console.log(`[Scanner] Analyzing ${candidates.length} candidates...\n`);
    
            for (const token of candidates) {
                console.log(`[Scanner] Checking ${token.symbol} (${token.bondingProgress.toFixed(1)}%)...`);
    
                // Volume spike check
                const volume = await this.bitquery.getVolumeHistory(token.address);
                if (!volume.spike) {
                    console.log(`[Scanner] ${token.symbol}: No volume spike, skipping.\n`);
                    continue;
                }

                const ratio = volume.previous > 0
                    ? (volume.recent / volume.previous)
                    : (volume.recent > 0 ? Infinity : 0);
                const ratioText = isFinite(ratio) ? ratio.toFixed(2) + 'x' : '∞';
                console.log(`  Volume Spike: ${ratioText}`);
    
                // Whale dump check
                const whaleDump = await this.bitquery.detectWhaleDumps(token.address);
                if (whaleDump) {
                    console.log(`[Scanner] ${token.symbol}: Whale dump detected, skipping.\n`);
                    continue;
                }
    
                // Found valid token
                console.log(`[Scanner] 🎯 SIGNAL FOUND: ${token.symbol}`);
                console.log(`  Bonding: ${token.bondingProgress.toFixed(1)}%`);
                console.log(`  Liquidity: $${token.liquidityUSD.toFixed(0)}`);
                console.log(`  Volume Spike: ${ratioText}\n`);
    
                return {
                    ...token,
                    volumeRecent: volume.recent,
                    volumePrevious: volume.previous,
                    volumeSpike: volume.previous > 0 ? (volume.recent / volume.previous) : Infinity
                };
            }
    
            console.log('[Scanner] No tokens passed all filters\n');
            return null;
        } catch (err) {
            console.error('[Scanner] ERROR in findTradingOpportunity:', err);
            return null;
        } finally {
            this.isScanning = false;
        }
    }

    async getJupiterQuote(inputMint, outputMint, amount, slippageBps = 300) {
        try {
            const url = `${this.JUPITER_QUOTE}?inputMint=${encodeURIComponent(inputMint)}&outputMint=${encodeURIComponent(outputMint)}&amount=${amount}&slippageBps=${slippageBps}`;
            console.log(`[Jupiter] Requesting quote: ${url}`);
            
            const res = await fetch(url, { 
                timeout: 12000,
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });
            
            if (!res.ok) {
                console.error('[Jupiter] Quote request failed:', res.status, res.statusText);
                return null;
            }
            
            const data = await res.json();
            
            // FIXED: Handle Jupiter V6 response structure correctly
            if (!data || !data.inAmount || !data.outAmount) {
                console.log('[Jupiter] Invalid quote response structure');
                return null;
            }
            
            console.log(`[Jupiter] Quote received: ${data.inAmount} → ${data.outAmount}`);
            
            return {
                ...data,
                inAmount: data.inAmount,
                outAmount: data.outAmount,
                route: data // Keep full response for swap
            };
        } catch (err) {
            console.error('[Jupiter] Quote error:', err.message);
            return null;
        }
    }

    async executeBuy(userId, token) {
        const user = this.getUserState(userId);
        
        try {
            console.log(`[Buy] Executing for ${token.symbol}...`);

            const amountUSDC = Math.floor(user.currentBalance * 1_000_000);
            if (amountUSDC <= 0) {
                throw new Error('Insufficient USDC balance for buy');
            }

            // FIXED: Verify wallet has sufficient balance
            const balanceCheck = await this.verifyWalletBalance(user.currentBalance);
            if (!balanceCheck.success) {
                throw new Error(`Insufficient wallet balance. Have: ${balanceCheck.balance}, Need: ${user.currentBalance}`);
            }
            
            const quote = await this.getJupiterQuote(USDC_MINT, token.address, amountUSDC, 300);
            if (!quote) {
                throw new Error('No quote available');
            }

            const slippageBps = this.calculateSlippage(token.liquidityUSD);
            const isHotLaunch = token.bondingProgress >= 96;
            const priorityFeeLamports = Math.floor(
                (isHotLaunch ? HOT_LAUNCH_PRIORITY_FEE_SOL : BASE_PRIORITY_FEE_SOL) * LAMPORTS_PER_SOL
            );

            const tx = await this.executeSwap(quote, priorityFeeLamports);
            if (!tx.success) {
                throw new Error(`Swap failed: ${tx.error}`);
            }

            const tokensReceived = parseFloat(quote.outAmount) / (10 ** 9); // Assume 9 decimals
            const usdcSpent = parseFloat(quote.inAmount) / 1000000;
            const entryPrice = usdcSpent / tokensReceived;
            
            user.position = {
                tokenAddress: token.address,
                symbol: token.symbol,
                entryPrice,
                entryTime: Date.now(),
                tokensOwned: tokensReceived,
                investedUSDC: usdcSpent,
                targetPrice: entryPrice * (1 + PER_TRADE_PROFIT_TARGET),
                stopLossPrice: entryPrice * (1 - PER_TRADE_STOP_LOSS),
                scalpMode: true,
                txSignature: tx.signature,
                bondingProgress: token.bondingProgress,
                liquidityUSD: token.liquidityUSD,
                tokenDecimals: 9
            };
            
            user.currentBalance -= usdcSpent;
            await this.saveState();
            await this.logTrade(userId, 'BUY', user.position);

            await this.bot.sendMessage(userId, this.formatBuyMessage(user.position, token), {
                parse_mode: 'HTML'
            });

            console.log(`[Buy] SUCCESS: ${token.symbol} @ $${entryPrice.toFixed(8)}`);
            return true;

        } catch (error) {
            console.error(`[Buy] Failed:`, error.message);
            await this.bot.sendMessage(userId, `❌ <b>Buy Failed</b>\n\n${error.message}`, {
                parse_mode: 'HTML'
            }).catch(err => console.error('[Buy] Failed to send error message:', err.message));
            return false;
        }
    }

    async executeSell(userId, reason, currentPrice) {
        const user = this.getUserState(userId);
        const pos = user.position;
    
        try {
            console.log(`[Sell] ${reason} for ${pos.symbol} @ $${currentPrice.toFixed(8)}`);
    
            const tokenDecimals = pos.tokenDecimals || 9;
            const amountTokens = Math.floor(pos.tokensOwned * (10 ** tokenDecimals));
    
            if (amountTokens <= 0) {
                throw new Error('Insufficient token balance for sell');
            }
    
            const quote = await this.getJupiterQuote(pos.tokenAddress, USDC_MINT, amountTokens, 300);
            if (!quote) throw new Error('No sell quote available');
    
            const slippageBps = this.calculateSlippage(pos.liquidityUSD || 10000);
            const tx = await this.executeSwap(quote, Math.floor(BASE_PRIORITY_FEE_SOL * LAMPORTS_PER_SOL));
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
    
            await this.saveState();
            await this.logTrade(userId, 'SELL', trade);
    
            await this.bot.sendMessage(userId, this.formatSellMessage(trade, user), {
                parse_mode: 'HTML'
            }).catch(err => console.error('[Sell] Failed to send message:', err.message));
    
            if (this.isDailyTargetHit(user)) {
                const target = user.dailyProfitPercent >= DAILY_PROFIT_TARGET ? 'PROFIT TARGET' : 'STOP LOSS';
                await this.bot.sendMessage(userId, this.formatDailyTargetMessage(user, target), {
                    parse_mode: 'HTML'
                }).catch(err => console.error('[Sell] Failed to send target message:', err.message));
            }
    
            console.log(`[Sell] SUCCESS: ${pos.symbol}, Profit: ${profitPercent.toFixed(2)}%`);
            return true;
    
        } catch (error) {
            console.error(`[Sell] Failed:`, error.message);
            await this.bot.sendMessage(userId, `❌ <b>Sell Failed</b>\n\n${error.message}`, {
                parse_mode: 'HTML'
            }).catch(err => console.error('[Sell] Failed to send error message:', err.message));
            return false;
        }
    }

    async monitorPosition(userId) {
        const user = this.getUserState(userId);
        if (!user.position) return;

        const pos = user.position;
        const currentPrice = await this.getCurrentPrice(pos.tokenAddress);
        
        if (!currentPrice) {
            console.log(`[Monitor] No price for ${pos.symbol}`);
            return;
        }

        const priceChange = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
        const holdTimeMin = (Date.now() - pos.entryTime) / 60000;

        console.log(`[Monitor] ${pos.symbol}: ${currentPrice.toFixed(8)} (${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(2)}%, ${holdTimeMin.toFixed(1)}m)`);

        if (pos.scalpMode && holdTimeMin < EXTENDED_HOLD_MINUTES) {
            if (priceChange >= SCALP_PROFIT_MIN * 100 && priceChange <= SCALP_PROFIT_MAX * 100) {
                await this.executeSell(userId, 'scalp_profit', currentPrice);
                return;
            }
        }

        if (pos.scalpMode && holdTimeMin >= EXTENDED_HOLD_MINUTES) {
            console.log(`[Monitor] ${pos.symbol}: Switching to extended hold mode`);
            pos.scalpMode = false;
            pos.targetPrice = pos.entryPrice * (1 + EXTENDED_HOLD_TARGET);
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
    }

    async executeSwap(quoteResponse, priorityFeeLamports = 0) {
        try {
            if (!quoteResponse) throw new Error('No quoteResponse provided to executeSwap');

            const swapUrl = this.JUPITER_SWAP;

            const payload = {
                quoteResponse: quoteResponse.route || quoteResponse,
                userPublicKey: this.wallet.publicKey.toString(),
                wrapAndUnwrapSol: true,
                dynamicComputeUnitLimit: true,
                prioritizationFeeLamports: priorityFeeLamports
            };

            console.log('[Swap] Requesting swap from Jupiter...');
            const res = await fetch(swapUrl, {
                method: 'POST',
                body: JSON.stringify(payload),
                headers: { 'Content-Type': 'application/json' },
                timeout: 20000
            });

            if (!res.ok) {
                const text = await res.text().catch(() => 'no-body');
                console.error('[Swap] Jupiter swap request failed:', res.status, res.statusText, text);
                return { success: false, error: `Jupiter swap request failed: ${res.status}` };
            }

            const data = await res.json();
            if (!data || !data.swapTransaction) {
                console.error('[Swap] Jupiter returned no swapTransaction', JSON.stringify(data).slice(0, 400));
                return { success: false, error: 'No swapTransaction in Jupiter response' };
            }

            const swapTxBs64 = data.swapTransaction;
            const txBuffer = Buffer.from(swapTxBs64, 'base64');
            const transaction = VersionedTransaction.deserialize(txBuffer);

            transaction.sign([this.wallet]);

            const rawSigned = transaction.serialize();
            const signature = await this.connection.sendRawTransaction(rawSigned, { 
                skipPreflight: false, 
                maxRetries: 3 
            });

            const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');

            if (confirmation.value && confirmation.value.err) {
                console.error('[Swap] Confirmation error:', JSON.stringify(confirmation.value.err));
                return { success: false, error: JSON.stringify(confirmation.value.err) };
            }

            console.log('[Swap] Success, signature:', signature);
            return { success: true, signature };
        } catch (err) {
            console.error('[Swap] executeSwap error:', err.message);
            return { success: false, error: err.message };
        }
    }

    async logTrade(userId, type, data) {
        try {
            const log = {
                userId,
                type,
                timestamp: new Date().toISOString(),
                ...data
            };

            let trades = [];
            try {
                trades = JSON.parse(await fs.readFile('trades.json', 'utf8'));
            } catch (e) {}

            trades.push(log);
            await fs.writeFile('trades.json', JSON.stringify(trades, null, 2));
        } catch (error) {
            console.error('[Log] Failed:', error.message);
        }
    }

    formatBuyMessage(pos, token) {
        return `
🚀 <b>BUY EXECUTED</b>

<b>Token:</b> ${pos.symbol}
<b>Entry Price:</b> ${pos.entryPrice.toFixed(8)}
<b>Amount:</b> ${pos.investedUSDC.toFixed(2)}
<b>Tokens:</b> ${pos.tokensOwned.toFixed(4)}

📊 <b>Market Data:</b>
Bonding Curve: ${token.bondingProgress.toFixed(1)}%
Liquidity: ${token.liquidityUSD.toFixed(0)}

🎯 <b>Targets:</b>
Scalp: ${SCALP_PROFIT_MIN * 100}%-${SCALP_PROFIT_MAX * 100}% (15min)
Extended: ${EXTENDED_HOLD_TARGET * 100}% (15min+)
Stop Loss: -${PER_TRADE_STOP_LOSS * 100}%

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
<b>Entry:</b> ${trade.entryPrice.toFixed(8)}
<b>Exit:</b> ${trade.exitPrice.toFixed(8)}
<b>Hold Time:</b> ${trade.holdTimeMinutes}m

💵 <b>Performance:</b>
Invested: ${trade.investedUSDC.toFixed(2)}
Received: ${trade.usdcReceived.toFixed(2)}
Profit: ${emoji} ${trade.profit.toFixed(2)} (${trade.profitPercent.toFixed(2)}%)

💼 <b>Account:</b>
Balance: ${user.currentBalance.toFixed(2)}
Daily P&L: ${user.dailyProfitPercent >= 0 ? '+' : ''}${user.dailyProfitPercent.toFixed(2)}%

📝 <b>TX:</b> <code>${trade.sellTxSignature}</code>
        `.trim();
    }

    formatDailyTargetMessage(user, target) {
        return `
🎯 <b>DAILY ${target} HIT</b>

Daily P&L: ${user.dailyProfitPercent >= 0 ? '+' : ''}${user.dailyProfitPercent.toFixed(2)}%
Starting Balance: ${user.dailyStartBalance.toFixed(2)}
Current Balance: ${user.currentBalance.toFixed(2)}

Bot entering 24h cooldown.
Next trading day: Day ${user.currentDay + 1}
        `.trim();
    }
}

// ============ TELEGRAM BOT ============
class TradingBot {
    constructor() {
        this.app = express();
        this.app.use(express.json());

        // FIXED: Set ownerId before bot initialization
        this.ownerId = AUTHORIZED_USERS.length > 0 ? AUTHORIZED_USERS[0] : null;

        if (USE_WEBHOOK && WEBHOOK_URL) {
            this.bot = new TelegramBot(TELEGRAM_TOKEN, { 
                webHook: { port: PORT, host: '0.0.0.0' }
            });
            this.setupWebhook();
        } else {
            this.bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
        }

        this.connection = new Connection(SOLANA_RPC_URL, 'confirmed');
        this.wallet = this.loadWallet(PRIVATE_KEY);
        this.bitquery = new BitqueryClient(BITQUERY_API_KEY);
        this.engine = new TradingEngine(this, this.wallet, this.connection, this.bitquery);

        this.setupCommands();
        this.engine.loadState();
        this.startTrading();

        this.app.listen(PORT, '0.0.0.0', () => {
            console.log(`Server running on port ${PORT}`);
        });
    }

    loadWallet(privateKey) {
        if (!privateKey) {
            throw new Error('PRIVATE_KEY not set');
        }
        try {
            const decoded = bs58.decode(privateKey);
            if (decoded.length === 64) {
                return Keypair.fromSecretKey(decoded);
            } else if (decoded.length === 32) {
                return Keypair.fromSeed(decoded);
            } else {
                throw new Error('Invalid PRIVATE_KEY length. Expect base58 64-byte secretKey or 32-byte seed.');
            }
        } catch (err) {
            console.error('[Wallet] loadWallet failed:', err.message);
            throw err;
        }
    }

    // FIXED: Added safe message sending helper
    async sendMessage(chatId, text, options = {}) {
        try {
            if (!chatId) {
                console.error('[Bot] Cannot send message: chatId is empty');
                return;
            }
            return await this.bot.sendMessage(chatId, text, options);
        } catch (error) {
            console.error('[Bot] Failed to send message:', error.message);
        }
    }

    setupCommands() {
        this.bot.onText(/\/start/, async (msg) => {
            if (!this.isAuthorized(msg.from.id)) return;

            const user = this.engine.getUserState(msg.from.id);
            user.isActive = true;
            await this.engine.saveState();

            await this.sendMessage(msg.chat.id, `
🤖 <b>AUTO-TRADING ACTIVATED</b>

📊 <b>Strategy:</b>
• Pump.fun tokens at 90-98% bonding curve
• Volume spike detection (${VOLUME_SPIKE_MULTIPLIER}x)
• Whale dump protection (${LARGE_SELL_THRESHOLD}+)
• Scalp ${SCALP_PROFIT_MIN * 100}-${SCALP_PROFIT_MAX * 100}% (0-15min)
• Extended hold ${EXTENDED_HOLD_TARGET * 100}% (15min+)
• Per-trade stop: -${PER_TRADE_STOP_LOSS * 100}%

🎯 <b>Daily Targets:</b>
Profit Target: +${DAILY_PROFIT_TARGET * 100}%
Stop Loss: -${DAILY_STOP_LOSS * 100}%

💼 <b>Account:</b>
Balance: ${user.currentBalance.toFixed(2)}
Day: ${user.currentDay}

Bot is now scanning for opportunities...
            `.trim(), { parse_mode: 'HTML' });
        });

        this.bot.onText(/\/stop/, async (msg) => {
            if (!this.isAuthorized(msg.from.id)) return;

            const user = this.engine.getUserState(msg.from.id);
            user.isActive = false;
            await this.engine.saveState();

            await this.sendMessage(msg.chat.id, `
🛑 <b>AUTO-TRADING STOPPED</b>

Use /start to resume trading.
            `.trim(), { parse_mode: 'HTML' });
        });

        this.bot.onText(/\/balance/, async (msg) => {
            if (!this.isAuthorized(msg.from.id)) return;

            const user = this.engine.getUserState(msg.from.id);
            const todayTrades = user.tradeHistory.filter(t => t.exitTime > user.dailyResetAt).length;
            
            await this.sendMessage(msg.chat.id, `
💼 <b>BALANCE</b>

<b>Current:</b> ${user.currentBalance.toFixed(2)}
<b>Daily Start:</b> ${user.dailyStartBalance.toFixed(2)}
<b>Daily P&L:</b> ${user.dailyProfitPercent >= 0 ? '📈 +' : '📉 '}${user.dailyProfitPercent.toFixed(2)}%

<b>Statistics:</b>
Trades Today: ${todayTrades}
Total Trades: ${user.totalTrades}
Success Rate: ${user.totalTrades > 0 ? ((user.successfulTrades / user.totalTrades) * 100).toFixed(1) : 0}%
            `.trim(), { parse_mode: 'HTML' });
        });

        this.bot.onText(/\/status/, async (msg) => {
            if (!this.isAuthorized(msg.from.id)) return;

            const user = this.engine.getUserState(msg.from.id);
            const hasPosition = user.position !== null;
            const dailyTargetHit = this.engine.isDailyTargetHit(user);

            let statusEmoji = user.isActive ? '🟢' : '🔴';
            let statusText = user.isActive ? 'Active' : 'Stopped';
            if (dailyTargetHit) {
                statusEmoji = '⏸️';
                statusText += ' (Cooldown)';
            }

            let positionInfo = '';
            if (hasPosition) {
                const pos = user.position;
                const currentPrice = await this.engine.getCurrentPrice(pos.tokenAddress);
                const priceChange = currentPrice ? ((currentPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(2) : '?';
                const holdTime = ((Date.now() - pos.entryTime) / 60000).toFixed(1);
                
                positionInfo = `

📊 <b>OPEN POSITION:</b>
Token: ${pos.symbol}
Entry: ${pos.entryPrice.toFixed(8)}
Current: ${currentPrice ? `+${currentPrice.toFixed(8)}` : 'Loading...'}
Change: ${priceChange}%
Target: ${pos.targetPrice.toFixed(8)}
Stop: ${pos.stopLossPrice.toFixed(8)}
Hold Time: ${holdTime}m
Mode: ${pos.scalpMode ? 'Scalp' : 'Extended'}`;
            }

            await this.sendMessage(msg.chat.id, `
${statusEmoji} <b>STATUS</b>

<b>Status:</b> ${statusText}
<b>Day:</b> ${user.currentDay}/30
<b>Balance:</b> ${user.currentBalance.toFixed(2)}
<b>Daily P&L:</b> ${user.dailyProfitPercent >= 0 ? '+' : ''}${user.dailyProfitPercent.toFixed(2)}%

📈 <b>Performance:</b>
Total Trades: ${user.totalTrades}
Successful: ${user.successfulTrades}
Win Rate: ${user.totalTrades > 0 ? ((user.successfulTrades / user.totalTrades) * 100).toFixed(1) : 0}%${positionInfo}
            `.trim(), { parse_mode: 'HTML' });
        });

        this.bot.onText(/\/history/, async (msg) => {
            if (!this.isAuthorized(msg.from.id)) return;

            const user = this.engine.getUserState(msg.from.id);
            if (!user.tradeHistory.length) {
                await this.sendMessage(msg.chat.id, '📭 <b>No trade history yet</b>', { parse_mode: 'HTML' });
                return;
            }

            const recent = user.tradeHistory.slice(-10).reverse();
            let text = `📜 <b>TRADE HISTORY</b>\n<i>Last ${recent.length} trades</i>\n\n`;

            recent.forEach((trade, i) => {
                const emoji = trade.profit > 0 ? '✅' : '❌';
                const reasonLabels = {
                    'scalp_profit': 'Scalp',
                    'extended_profit': 'Extended',
                    'stop_loss': 'Stop Loss'
                };
                
                text += `${emoji} <b>${trade.symbol}</b>\n`;
                text += `   Profit: ${trade.profit.toFixed(2)} (${trade.profitPercent.toFixed(2)}%)\n`;
                text += `   Type: ${reasonLabels[trade.reason] || trade.reason}\n`;
                text += `   Hold: ${trade.holdTimeMinutes}m\n\n`;
            });

            await this.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
        });

        this.bot.onText(/\/help/, async (msg) => {
            if (!this.isAuthorized(msg.from.id)) return;

            await this.sendMessage(msg.chat.id, `
📚 <b>COMMAND REFERENCE</b>

<b>Trading Commands:</b>
/start - Start auto-trading
/stop - Stop auto-trading
/balance - View balance & P&L
/status - Trading status & position
/history - Recent trades
/help - This menu

<b>Strategy Overview:</b>

<b>Entry Criteria:</b>
• Bonding curve: 90-98%
• Min liquidity: ${MIN_LIQUIDITY_USD.toLocaleString()}
• Volume spike: ${VOLUME_SPIKE_MULTIPLIER}x (10min)
• No whale dumps: ${LARGE_SELL_THRESHOLD}+ sells

<b>Exit Targets:</b>
• Scalp mode (0-15min): ${SCALP_PROFIT_MIN * 100}-${SCALP_PROFIT_MAX * 100}%
• Extended mode (15min+): ${EXTENDED_HOLD_TARGET * 100}%
• Stop loss: -${PER_TRADE_STOP_LOSS * 100}% (per trade)

<b>Daily Limits:</b>
• Profit target: +${DAILY_PROFIT_TARGET * 100}% → 24h cooldown
• Stop loss: -${DAILY_STOP_LOSS * 100}% → 24h cooldown

<b>Risk Management:</b>
• One position at a time
• Dynamic slippage (3-12%)
• Priority fees for fast execution
• State persistence (crash-safe)

⚠️ <b>Warning:</b> High-risk trading. Only use funds you can afford to lose completely.
            `.trim(), { parse_mode: 'HTML' });
        });
    }

    isAuthorized(userId) {
        return AUTHORIZED_USERS.length === 0 || AUTHORIZED_USERS.includes(userId.toString());
    }

    setupWebhook() {
        this.app.post('/webhook', (req, res) => {
            this.bot.processUpdate(req.body);
            res.sendStatus(200);
        });

        this.app.get('/health', (req, res) => {
            res.json({ 
                status: 'healthy', 
                timestamp: new Date().toISOString(),
                uptime: process.uptime()
            });
        });

        this.bot.setWebHook(`${WEBHOOK_URL}/webhook`).then(() => {
            console.log(`Webhook set: ${WEBHOOK_URL}/webhook`);
        }).catch(err => {
            console.error('Webhook setup failed:', err);
            process.exit(1);
        });
    }

    startTrading() {
        console.log('[Trading] Starting cycles...');
        
        setInterval(async () => {
            for (const [userId, user] of this.engine.userStates.entries()) {
                if (user.isActive && user.position) {
                    await this.engine.monitorPosition(userId);
                }
            }
        }, 30000);
    
        setInterval(async () => {
            await this.engine.tradingCycle();
        }, 300000);

        console.log('[Trading] Cycles active');
    }

    async shutdown() {
        console.log('Shutting down...');
        await this.engine.saveState();
        if (USE_WEBHOOK) await this.bot.deleteWebHook();
        process.exit(0);
    }
}

// ============ INITIALIZE ============
const bot = new TradingBot();

console.log('\n=== MEME TOKEN TRADING BOT ===');
console.log('Telegram:', TELEGRAM_TOKEN ? '✅' : '❌');
console.log('Bitquery:', BITQUERY_API_KEY ? '✅' : '❌');
console.log('Helius:', HELIUS_API_KEY ? '✅' : '❌');
console.log('Wallet:', PRIVATE_KEY ? '✅' : '❌');
console.log('Authorized Users:', AUTHORIZED_USERS.length > 0 ? AUTHORIZED_USERS.join(', ') : 'None (open to all)');
console.log('==============================\n');

process.on('SIGTERM', () => bot.shutdown());
process.on('SIGINT', () => bot.shutdown());
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    bot.shutdown();
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});

module.exports = bot;
