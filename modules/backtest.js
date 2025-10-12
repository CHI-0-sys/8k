class BacktestEngine {
    constructor(logger, database) {
        this.logger = logger;
        this.database = database;
        this.trades = [];
        this.balance = 0;
        this.initialBalance = 0;
        this.currentDay = 1;
        this.dailyResults = [];
    }

    // Initialize backtest
    async initialize(initialCapital, startDate, endDate, strategy) {
        this.initialBalance = initialCapital;
        this.balance = initialCapital;
        this.startDate = startDate;
        this.endDate = endDate;
        this.strategy = strategy;
        this.trades = [];
        this.dailyResults = [];
        this.currentDay = 1;

        this.logger.info('Backtest initialized', {
            capital: initialCapital,
            startDate,
            endDate,
            strategy: strategy.name
        });
    }

    // Load historical data for backtest
    async loadHistoricalData(tokenAddress, startDate, endDate) {
        // Note: In production, you'd load real historical price/volume data
        // This is a simplified mock implementation
        
        this.logger.info('Loading historical data', { tokenAddress, startDate, endDate });

        // Mock data generation for demonstration
        const data = [];
        const dayMs = 24 * 60 * 60 * 1000;
        const days = Math.floor((new Date(endDate) - new Date(startDate)) / dayMs);

        for (let i = 0; i < days; i++) {
            const timestamp = new Date(startDate).getTime() + (i * dayMs);
            
            // Generate mock OHLCV data
            const open = 0.0001 + (Math.random() * 0.0001);
            const high = open * (1 + Math.random() * 0.15);
            const low = open * (1 - Math.random() * 0.1);
            const close = low + (Math.random() * (high - low));
            const volume = 10000 + (Math.random() * 50000);

            data.push({
                timestamp,
                date: new Date(timestamp).toISOString().split('T')[0],
                open,
                high,
                low,
                close,
                volume,
                bondingProgress: 93 + (Math.random() * 5),
                liquidityUSD: 8000 + (Math.random() * 20000)
            });
        }

        return data;
    }

    // Simulate a buy trade
    simulateBuy(data, positionSize) {
        const entryPrice = data.close;
        const tokensOwned = positionSize / entryPrice;
        
        const trade = {
            type: 'BUY',
            timestamp: data.timestamp,
            entryPrice,
            tokensOwned,
            investedUSDC: positionSize,
            bondingProgress: data.bondingProgress,
            liquidityUSD: data.liquidityUSD
        };

        this.balance -= positionSize;
        return trade;
    }

    // Simulate a sell trade
    simulateSell(position, data, reason) {
        const exitPrice = data.close;
        const usdcReceived = position.tokensOwned * exitPrice;
        const profit = usdcReceived - position.investedUSDC;
        const profitPercent = (profit / position.investedUSDC) * 100;

        const trade = {
            ...position,
            exitPrice,
            exitTime: data.timestamp,
            usdcReceived,
            profit,
            profitPercent,
            reason,
            holdTimeMinutes: (data.timestamp - position.timestamp) / 60000
        };

        this.balance += usdcReceived;
        this.trades.push(trade);

        return trade;
    }

    // Run backtest on historical data
    async runBacktest(historicalData) {
        let position = null;
        let dailyProfit = 0;
        let dailyStartBalance = this.balance;
        let tradesThisDay = [];

        for (let i = 1; i < historicalData.length; i++) {
            const currentData = historicalData[i];
            const previousData = historicalData[i - 1];

            // Check for new day
            if (currentData.date !== previousData.date) {
                this.recordDailyResults(previousData.date, dailyProfit, dailyStartBalance, tradesThisDay);
                dailyStartBalance = this.balance;
                dailyProfit = 0;
                tradesThisDay = [];
                this.currentDay++;
            }

            // Check if we should enter a position
            if (!position && this.shouldEnterTrade(currentData, previousData)) {
                const positionSize = this.calculatePositionSize(this.balance);
                
                if (positionSize >= 10 && this.balance >= positionSize) {
                    position = this.simulateBuy(currentData, positionSize);
                    this.logger.debug('Backtest BUY', {
                        date: currentData.date,
                        price: position.entryPrice,
                        size: positionSize
                    });
                }
            }

            // Check if we should exit position
            if (position && this.shouldExitTrade(position, currentData, previousData)) {
                const trade = this.simulateSell(position, currentData, this.getExitReason(position, currentData));
                tradesThisDay.push(trade);
                dailyProfit += trade.profit;
                
                this.logger.debug('Backtest SELL', {
                    date: currentData.date,
                    profit: trade.profit.toFixed(2),
                    profitPercent: trade.profitPercent.toFixed(2)
                });

                position = null;
            }
        }

        // Close any open position at end of backtest
        if (position) {
            const lastData = historicalData[historicalData.length - 1];
            const trade = this.simulateSell(position, lastData, 'backtest_end');
            tradesThisDay.push(trade);
            dailyProfit += trade.profit;
        }

        // Record final day
        const lastData = historicalData[historicalData.length - 1];
        this.recordDailyResults(lastData.date, dailyProfit, dailyStartBalance, tradesThisDay);

        return this.generateReport();
    }

    // Determine if should enter trade based on strategy
    shouldEnterTrade(currentData, previousData) {
        const strategy = this.strategy;

        // Check bonding progress
        if (currentData.bondingProgress < strategy.minBondingProgress ||
            currentData.bondingProgress > strategy.maxBondingProgress) {
            return false;
        }

        // Check liquidity
        if (currentData.liquidityUSD < strategy.minLiquidity) {
            return false;
        }

        // Check volume spike
        const volumeRatio = currentData.volume / previousData.volume;
        if (volumeRatio < strategy.volumeSpikeMultiplier) {
            return false;
        }

        // Check price momentum
        const priceChange = (currentData.close - previousData.close) / previousData.close;
        if (priceChange < -0.05) { // Don't buy if price dropped >5%
            return false;
        }

        return true;
    }

    // Determine if should exit trade
    shouldExitTrade(position, currentData, previousData) {
        const currentPrice = currentData.close;
        const profitPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
        const holdTimeMinutes = (currentData.timestamp - position.timestamp) / 60000;

        const strategy = this.strategy;

        // Scalp profit target (0-15 minutes)
        if (holdTimeMinutes < strategy.extendedHoldMinutes) {
            if (profitPercent >= strategy.scalpProfitMin * 100 && 
                profitPercent <= strategy.scalpProfitMax * 100) {
                return true;
            }
        }

        // Extended profit target (15+ minutes)
        if (holdTimeMinutes >= strategy.extendedHoldMinutes) {
            if (profitPercent >= strategy.extendedHoldTarget * 100) {
                return true;
            }
        }

        // Stop loss
        if (profitPercent <= -strategy.stopLoss * 100) {
            return true;
        }

        return false;
    }

    getExitReason(position, currentData) {
        const currentPrice = currentData.close;
        const profitPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
        const holdTimeMinutes = (currentData.timestamp - position.timestamp) / 60000;

        if (profitPercent <= -this.strategy.stopLoss * 100) {
            return 'stop_loss';
        } else if (holdTimeMinutes < this.strategy.extendedHoldMinutes) {
            return 'scalp_profit';
        } else {
            return 'extended_profit';
        }
    }

    calculatePositionSize(currentBalance) {
        const strategy = this.strategy;
        
        switch (strategy.positionSizeMode) {
            case 'FIXED':
                return strategy.fixedPositionSize;
            case 'PERCENTAGE':
                return currentBalance * strategy.percentagePositionSize;
            default:
                return 20;
        }
    }

    recordDailyResults(date, dailyProfit, dailyStartBalance, trades) {
        const dailyProfitPercent = (dailyProfit / dailyStartBalance) * 100;
        
        this.dailyResults.push({
            day: this.currentDay,
            date,
            startBalance: dailyStartBalance,
            endBalance: this.balance,
            profit: dailyProfit,
            profitPercent: dailyProfitPercent,
            trades: trades.length,
            winningTrades: trades.filter(t => t.profit > 0).length
        });
    }

    // Generate backtest report
    generateReport() {
        const winningTrades = this.trades.filter(t => t.profit > 0);
        const losingTrades = this.trades.filter(t => t.profit <= 0);
        
        const totalProfit = this.trades.reduce((sum, t) => sum + t.profit, 0);
        const totalWins = winningTrades.reduce((sum, t) => sum + t.profit, 0);
        const totalLosses = Math.abs(losingTrades.reduce((sum, t) => sum + t.profit, 0));
        
        const winRate = this.trades.length > 0 ? 
            (winningTrades.length / this.trades.length) * 100 : 0;
        
        const profitFactor = totalLosses > 0 ? totalWins / totalLosses : 
            (totalWins > 0 ? 999 : 0);
        
        const avgWin = winningTrades.length > 0 ?
            winningTrades.reduce((sum, t) => sum + t.profitPercent, 0) / winningTrades.length : 0;
        
        const avgLoss = losingTrades.length > 0 ?
            losingTrades.reduce((sum, t) => sum + Math.abs(t.profitPercent), 0) / losingTrades.length : 0;
        
        const expectancy = (winRate / 100) * avgWin - ((100 - winRate) / 100) * avgLoss;
        
        // Calculate max drawdown
        let peak = this.initialBalance;
        let maxDrawdown = 0;
        let runningBalance = this.initialBalance;
        
        for (const trade of this.trades) {
            runningBalance += trade.profit;
            if (runningBalance > peak) {
                peak = runningBalance;
            }
            const drawdown = (peak - runningBalance) / peak * 100;
            if (drawdown > maxDrawdown) {
                maxDrawdown = drawdown;
            }
        }
        
        // Calculate Sharpe ratio (simplified)
        const dailyReturns = this.dailyResults.map(d => d.profitPercent);
        const avgReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
        const variance = dailyReturns.reduce((sum, ret) => 
            sum + Math.pow(ret - avgReturn, 2), 0) / dailyReturns.length;
        const stdDev = Math.sqrt(variance);
        const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;
        
        const report = {
            summary: {
                strategyName: this.strategy.name,
                startDate: this.startDate,
                endDate: this.endDate,
                initialCapital: this.initialBalance,
                finalCapital: this.balance,
                totalReturn: totalProfit,
                totalReturnPercent: ((this.balance - this.initialBalance) / this.initialBalance * 100).toFixed(2),
                days: this.dailyResults.length
            },
            performance: {
                totalTrades: this.trades.length,
                winningTrades: winningTrades.length,
                losingTrades: losingTrades.length,
                winRate: winRate.toFixed(2),
                profitFactor: profitFactor.toFixed(2),
                expectancy: expectancy.toFixed(2),
                avgWin: avgWin.toFixed(2),
                avgLoss: avgLoss.toFixed(2),
                largestWin: Math.max(...this.trades.map(t => t.profitPercent)).toFixed(2),
                largestLoss: Math.min(...this.trades.map(t => t.profitPercent)).toFixed(2)
            },
            risk: {
                maxDrawdown: maxDrawdown.toFixed(2),
                sharpeRatio: sharpeRatio.toFixed(2),
                avgHoldTime: (this.trades.reduce((sum, t) => sum + t.holdTimeMinutes, 0) / this.trades.length).toFixed(1)
            },
            daily: this.dailyResults,
            trades: this.trades
        };

        this.logger.info('Backtest completed', {
            trades: report.performance.totalTrades,
            winRate: report.performance.winRate,
            finalCapital: report.summary.finalCapital
        });

        return report;
    }

    // Save backtest results to database
    async saveResults(report) {
        if (!this.database) {
            this.logger.warn('No database connection, skipping save');
            return;
        }

        try {
            await this.database.saveBacktestResult({
                strategyName: report.summary.strategyName,
                startDate: report.summary.startDate,
                endDate: report.summary.endDate,
                initialCapital: report.summary.initialCapital,
                finalCapital: report.summary.finalCapital,
                totalTrades: report.performance.totalTrades,
                winningTrades: report.performance.winningTrades,
                winRate: parseFloat(report.performance.winRate),
                profitFactor: parseFloat(report.performance.profitFactor),
                sharpeRatio: parseFloat(report.risk.sharpeRatio),
                maxDrawdown: parseFloat(report.risk.maxDrawdown),
                parameters: this.strategy
            });

            this.logger.info('Backtest results saved to database');
        } catch (error) {
            this.logger.error('Failed to save backtest results', { error: error.message });
        }
    }

    // Compare multiple strategies
    async compareStrategies(strategies, historicalData) {
        const results = [];

        for (const strategy of strategies) {
            await this.initialize(this.initialBalance, this.startDate, this.endDate, strategy);
            const report = await this.runBacktest(historicalData);
            results.push(report);
        }

        // Rank strategies
        results.sort((a, b) => {
            const scoreA = this.calculateStrategyScore(a);
            const scoreB = this.calculateStrategyScore(b);
            return scoreB - scoreA;
        });

        return {
            bestStrategy: results[0],
            allResults: results,
            comparison: this.generateComparison(results)
        };
    }

    calculateStrategyScore(report) {
        // Weighted scoring system
        const returnScore = parseFloat(report.summary.totalReturnPercent) * 0.3;
        const winRateScore = parseFloat(report.performance.winRate) * 0.25;
        const profitFactorScore = parseFloat(report.performance.profitFactor) * 10 * 0.2;
        const sharpeScore = parseFloat(report.risk.sharpeRatio) * 20 * 0.15;
        const drawdownScore = (100 - parseFloat(report.risk.maxDrawdown)) * 0.1;

        return returnScore + winRateScore + profitFactorScore + sharpeScore + drawdownScore;
    }

    generateComparison(results) {
        return results.map((r, i) => ({
            rank: i + 1,
            strategy: r.summary.strategyName,
            return: r.summary.totalReturnPercent + '%',
            winRate: r.performance.winRate + '%',
            profitFactor: r.performance.profitFactor,
            sharpe: r.risk.sharpeRatio,
            maxDrawdown: r.risk.maxDrawdown + '%',
            score: this.calculateStrategyScore(r).toFixed(2)
        }));
    }

    // Generate visual equity curve data
    generateEquityCurve() {
        let balance = this.initialBalance;
        const curve = [{ date: this.startDate, balance: this.initialBalance }];

        for (const trade of this.trades) {
            balance += trade.profit;
            curve.push({
                date: new Date(trade.exitTime).toISOString().split('T')[0],
                balance: balance.toFixed(2),
                profit: trade.profit.toFixed(2)
            });
        }

        return curve;
    }
}

module.exports = BacktestEngine;