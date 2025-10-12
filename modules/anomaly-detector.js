class AnomalyDetector {
    constructor(logger, database) {
        this.logger = logger;
        this.database = database;
        this.baselineMetrics = {
            avgWinRate: 0,
            avgProfitPercent: 0,
            avgHoldTime: 0,
            avgTradesPerDay: 0
        };
        this.recentTrades = [];
        this.maxRecentTrades = 100;
    }

    // Update baseline metrics
    async updateBaseline(userId) {
        try {
            const stats = await this.database.getTradeStatistics(userId);
            
            if (stats && stats.total_trades > 0) {
                this.baselineMetrics = {
                    avgWinRate: (stats.winning_trades / stats.total_trades) * 100,
                    avgProfitPercent: stats.avg_profit_percent || 0,
                    avgHoldTime: stats.avg_hold_time || 0,
                    avgTradesPerDay: stats.total_trades / 30 // Assuming 30-day period
                };

                this.logger.debug('Baseline metrics updated', this.baselineMetrics);
            }
        } catch (error) {
            this.logger.error('Failed to update baseline', { error: error.message });
        }
    }

    // Add trade to recent history
    addTrade(trade) {
        this.recentTrades.push(trade);
        
        if (this.recentTrades.length > this.maxRecentTrades) {
            this.recentTrades.shift();
        }
    }

    // Detect win rate anomaly
    detectWinRateAnomaly(userId) {
        if (this.recentTrades.length < 20) {
            return null; // Not enough data
        }

        const recentWins = this.recentTrades.filter(t => t.profit > 0).length;
        const recentWinRate = (recentWins / this.recentTrades.length) * 100;
        
        const deviation = Math.abs(recentWinRate - this.baselineMetrics.avgWinRate);
        const threshold = 20; // 20% deviation

        if (deviation > threshold) {
            const severity = deviation > 30 ? 'HIGH' : 'MEDIUM';
            
            const anomaly = {
                type: 'win_rate',
                severity,
                message: `Win rate deviation detected: ${deviation.toFixed(2)}%`,
                current: recentWinRate.toFixed(2),
                baseline: this.baselineMetrics.avgWinRate.toFixed(2),
                deviation: deviation.toFixed(2)
            };

            this.logger.warn('Win rate anomaly detected', anomaly);
            
            if (this.database) {
                this.database.createAnomalyAlert(
                    userId,
                    'win_rate',
                    severity,
                    anomaly.message,
                    anomaly
                );
            }

            return anomaly;
        }

        return null;
    }

    // Detect profit anomaly
    detectProfitAnomaly(userId) {
        if (this.recentTrades.length < 10) {
            return null;
        }

        const recentAvgProfit = this.recentTrades
            .reduce((sum, t) => sum + t.profitPercent, 0) / this.recentTrades.length;
        
        const deviation = Math.abs(recentAvgProfit - this.baselineMetrics.avgProfitPercent);
        const threshold = 5; // 5% deviation

        if (deviation > threshold) {
            const severity = deviation > 10 ? 'HIGH' : 'MEDIUM';
            
            const anomaly = {
                type: 'profit',
                severity,
                message: `Profit percentage deviation detected: ${deviation.toFixed(2)}%`,
                current: recentAvgProfit.toFixed(2),
                baseline: this.baselineMetrics.avgProfitPercent.toFixed(2),
                deviation: deviation.toFixed(2)
            };

            this.logger.warn('Profit anomaly detected', anomaly);
            
            if (this.database) {
                this.database.createAnomalyAlert(
                    userId,
                    'profit',
                    severity,
                    anomaly.message,
                    anomaly
                );
            }

            return anomaly;
        }

        return null;
    }

    // Detect losing streak
    detectLosingStreak(userId) {
        if (this.recentTrades.length < 5) {
            return null;
        }

        const recentFive = this.recentTrades.slice(-5);
        const allLosses = recentFive.every(t => t.profit <= 0);

        if (allLosses) {
            const totalLoss = recentFive.reduce((sum, t) => sum + t.profit, 0);
            
            const anomaly = {
                type: 'losing_streak',
                severity: 'HIGH',
                message: `5 consecutive losses detected`,
                streak: 5,
                totalLoss: totalLoss.toFixed(2)
            };

            this.logger.error('Losing streak detected', anomaly);
            
            if (this.database) {
                this.database.createAnomalyAlert(
                    userId,
                    'losing_streak',
                    'HIGH',
                    anomaly.message,
                    anomaly
                );
            }

            return anomaly;
        }

        return null;
    }

    // Detect unusual hold time
    detectHoldTimeAnomaly(userId, trade) {
        if (!this.baselineMetrics.avgHoldTime || this.baselineMetrics.avgHoldTime === 0) {
            return null;
        }

        const holdTime = trade.holdTimeMinutes;
        const deviation = Math.abs(holdTime - this.baselineMetrics.avgHoldTime);
        const deviationPercent = (deviation / this.baselineMetrics.avgHoldTime) * 100;
        
        const threshold = 100; // 100% deviation

        if (deviationPercent > threshold) {
            const anomaly = {
                type: 'hold_time',
                severity: 'LOW',
                message: `Unusual hold time: ${holdTime.toFixed(1)} minutes`,
                current: holdTime.toFixed(1),
                baseline: this.baselineMetrics.avgHoldTime.toFixed(1),
                deviationPercent: deviationPercent.toFixed(2)
            };

            this.logger.info('Hold time anomaly detected', anomaly);
            
            return anomaly;
        }

        return null;
    }

    // Detect sudden drawdown
    detectDrawdown(userId) {
        if (this.recentTrades.length < 10) {
            return null;
        }

        const recentTen = this.recentTrades.slice(-10);
        const totalProfit = recentTen.reduce((sum, t) => sum + t.profit, 0);
        const avgInvestment = recentTen.reduce((sum, t) => sum + t.investedUSDC, 0) / 10;
        
        const drawdownPercent = (totalProfit / avgInvestment) * 100;

        if (drawdownPercent < -10) { // More than 10% loss
            const anomaly = {
                type: 'drawdown',
                severity: drawdownPercent < -20 ? 'HIGH' : 'MEDIUM',
                message: `Significant drawdown detected: ${Math.abs(drawdownPercent).toFixed(2)}%`,
                drawdownPercent: drawdownPercent.toFixed(2),
                totalLoss: totalProfit.toFixed(2),
                trades: recentTen.length
            };

            this.logger.error('Drawdown detected', anomaly);
            
            if (this.database) {
                this.database.createAnomalyAlert(
                    userId,
                    'drawdown',
                    anomaly.severity,
                    anomaly.message,
                    anomaly
                );
            }

            return anomaly;
        }

        return null;
    }

    // Detect price impact anomaly
    detectPriceImpactAnomaly(expectedPrice, actualPrice, trade) {
        const priceDifference = Math.abs(actualPrice - expectedPrice);
        const differencePercent = (priceDifference / expectedPrice) * 100;

        if (differencePercent > 5) { // More than 5% difference
            const anomaly = {
                type: 'price_impact',
                severity: differencePercent > 10 ? 'HIGH' : 'MEDIUM',
                message: `Unexpected price impact: ${differencePercent.toFixed(2)}%`,
                expected: expectedPrice.toFixed(8),
                actual: actualPrice.toFixed(8),
                difference: differencePercent.toFixed(2),
                trade: trade.symbol
            };

            this.logger.warn('Price impact anomaly detected', anomaly);
            
            return anomaly;
        }

        return null;
    }

    // Detect unusual trading frequency
    detectFrequencyAnomaly(userId, tradesInLastHour) {
        const expectedTradesPerHour = this.baselineMetrics.avgTradesPerDay / 24;
        const deviation = Math.abs(tradesInLastHour - expectedTradesPerHour);
        const deviationPercent = expectedTradesPerHour > 0 ? 
            (deviation / expectedTradesPerHour) * 100 : 0;

        if (deviationPercent > 200) { // 200% deviation
            const anomaly = {
                type: 'frequency',
                severity: 'MEDIUM',
                message: `Unusual trading frequency: ${tradesInLastHour} trades in last hour`,
                current: tradesInLastHour,
                expected: expectedTradesPerHour.toFixed(2),
                deviationPercent: deviationPercent.toFixed(2)
            };

            this.logger.warn('Frequency anomaly detected', anomaly);
            
            if (this.database) {
                this.database.createAnomalyAlert(
                    userId,
                    'frequency',
                    'MEDIUM',
                    anomaly.message,
                    anomaly
                );
            }

            return anomaly;
        }

        return null;
    }

    // Detect token concentration (trading same token repeatedly)
    detectTokenConcentration(userId) {
        if (this.recentTrades.length < 10) {
            return null;
        }

        const tokenCounts = {};
        this.recentTrades.slice(-20).forEach(trade => {
            tokenCounts[trade.symbol] = (tokenCounts[trade.symbol] || 0) + 1;
        });

        for (const [symbol, count] of Object.entries(tokenCounts)) {
            if (count > 10) { // Same token more than 10 times in last 20 trades
                const anomaly = {
                    type: 'token_concentration',
                    severity: 'LOW',
                    message: `High concentration on ${symbol}: ${count} trades`,
                    token: symbol,
                    count,
                    percent: ((count / 20) * 100).toFixed(2)
                };

                this.logger.info('Token concentration detected', anomaly);
                
                return anomaly;
            }
        }

        return null;
    }

    // Run all anomaly checks
    async detectAllAnomalies(userId, trade = null) {
        const anomalies = [];

        // Update baseline periodically
        if (this.recentTrades.length % 20 === 0) {
            await this.updateBaseline(userId);
        }

        // Run checks
        const winRateAnomaly = this.detectWinRateAnomaly(userId);
        const profitAnomaly = this.detectProfitAnomaly(userId);
        const losingStreakAnomaly = this.detectLosingStreak(userId);
        const drawdownAnomaly = this.detectDrawdown(userId);
        const tokenConcentration = this.detectTokenConcentration(userId);

        if (winRateAnomaly) anomalies.push(winRateAnomaly);
        if (profitAnomaly) anomalies.push(profitAnomaly);
        if (losingStreakAnomaly) anomalies.push(losingStreakAnomaly);
        if (drawdownAnomaly) anomalies.push(drawdownAnomaly);
        if (tokenConcentration) anomalies.push(tokenConcentration);

        // Trade-specific checks
        if (trade) {
            const holdTimeAnomaly = this.detectHoldTimeAnomaly(userId, trade);
            if (holdTimeAnomaly) anomalies.push(holdTimeAnomaly);
        }

        if (anomalies.length > 0) {
            this.logger.info('Anomalies detected', { count: anomalies.length });
        }

        return anomalies;
    }

    // Get anomaly summary
    getSummary() {
        return {
            recentTradesCount: this.recentTrades.length,
            baseline: this.baselineMetrics,
            recentStats: this.getRecentStats()
        };
    }

    

    getRecentStats() {
        if (this.recentTrades.length === 0) {
            return {
                winRate: 0,
                avgProfit: 0,
                avgHoldTime: 0
            };
        }
        
        const wins = this.recentTrades.filter(t => t.profit > 0).length;
        const winRate = (wins / this.recentTrades.length) * 100;
        const avgProfit = this.recentTrades.reduce((sum, t) => sum + t.profitPercent, 0) / this.recentTrades.length;
        const avgHoldTime = this.recentTrades.reduce((sum, t) => sum + t.holdTimeMinutes, 0) / this.recentTrades.length;

        return {
            winRate: winRate.toFixed(2),
            avgProfit: avgProfit.toFixed(2),
            avgHoldTime: avgHoldTime.toFixed(1)
        };
    }

    // Clear recent trades
    clearRecentTrades() {
        this.recentTrades = [];
        this.logger.info('Recent trades cleared');
    }
}

module.exports = AnomalyDetector;