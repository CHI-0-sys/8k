const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

class DatabaseManager {
    constructor(dbPath = './data/trading.db') {
        this.dbPath = dbPath;
        this.db = null;
    }

    async init() {
        this.db = await open({
            filename: this.dbPath,
            driver: sqlite3.Database
        });

        await this.createTables();
        console.log('[Database] Initialized successfully');
    }

    async createTables() {
        // Users table
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                user_id TEXT PRIMARY KEY,
                is_active INTEGER DEFAULT 0,
                starting_balance REAL DEFAULT 20,
                current_balance REAL DEFAULT 20,
                daily_start_balance REAL DEFAULT 20,
                daily_profit REAL DEFAULT 0,
                daily_profit_percent REAL DEFAULT 0,
                current_day INTEGER DEFAULT 1,
                total_trades INTEGER DEFAULT 0,
                successful_trades INTEGER DEFAULT 0,
                last_trade_at INTEGER DEFAULT 0,
                daily_reset_at INTEGER DEFAULT 0,
                total_profit_taken REAL DEFAULT 0,
                trading_capital REAL DEFAULT 20,
                created_at INTEGER DEFAULT (strftime('%s', 'now')),
                updated_at INTEGER DEFAULT (strftime('%s', 'now'))
            )
        `);

        // Positions table
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS positions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                token_address TEXT NOT NULL,
                symbol TEXT NOT NULL,
                entry_price REAL NOT NULL,
                entry_time INTEGER NOT NULL,
                tokens_owned REAL NOT NULL,
                invested_usdc REAL NOT NULL,
                target_price REAL NOT NULL,
                stop_loss_price REAL NOT NULL,
                scalp_mode INTEGER DEFAULT 1,
                tx_signature TEXT,
                bonding_progress REAL,
                liquidity_usd REAL,
                token_decimals INTEGER DEFAULT 9,
                position_size_mode TEXT,
                is_active INTEGER DEFAULT 1,
                exit_price REAL,
                exit_time INTEGER,
                profit REAL,
                profit_percent REAL,
                exit_reason TEXT,
                sell_tx_signature TEXT,
                created_at INTEGER DEFAULT (strftime('%s', 'now')),
                FOREIGN KEY (user_id) REFERENCES users(user_id)
            )
        `);

        // Trades history table
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                token_address TEXT NOT NULL,
                symbol TEXT NOT NULL,
                entry_price REAL NOT NULL,
                exit_price REAL NOT NULL,
                entry_time INTEGER NOT NULL,
                exit_time INTEGER NOT NULL,
                tokens_owned REAL NOT NULL,
                invested_usdc REAL NOT NULL,
                usdc_received REAL NOT NULL,
                profit REAL NOT NULL,
                profit_percent REAL NOT NULL,
                reason TEXT NOT NULL,
                buy_tx_signature TEXT,
                sell_tx_signature TEXT,
                hold_time_minutes REAL,
                bonding_progress REAL,
                liquidity_usd REAL,
                was_paper_trade INTEGER DEFAULT 0,
                created_at INTEGER DEFAULT (strftime('%s', 'now')),
                FOREIGN KEY (user_id) REFERENCES users(user_id)
            )
        `);

        // Performance metrics table
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS performance_metrics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                date TEXT NOT NULL,
                total_trades INTEGER DEFAULT 0,
                winning_trades INTEGER DEFAULT 0,
                losing_trades INTEGER DEFAULT 0,
                total_profit REAL DEFAULT 0,
                total_loss REAL DEFAULT 0,
                win_rate REAL DEFAULT 0,
                profit_factor REAL DEFAULT 0,
                expectancy REAL DEFAULT 0,
                largest_win REAL DEFAULT 0,
                largest_loss REAL DEFAULT 0,
                strategy_level TEXT,
                created_at INTEGER DEFAULT (strftime('%s', 'now')),
                FOREIGN KEY (user_id) REFERENCES users(user_id)
            )
        `);

        // API usage tracking
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS api_usage (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                service TEXT NOT NULL,
                endpoint TEXT NOT NULL,
                query_count INTEGER DEFAULT 1,
                estimated_points INTEGER DEFAULT 0,
                success INTEGER DEFAULT 1,
                error_message TEXT,
                timestamp INTEGER DEFAULT (strftime('%s', 'now'))
            )
        `);

        // Anomaly alerts table
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS anomaly_alerts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                anomaly_type TEXT NOT NULL,
                severity TEXT NOT NULL,
                description TEXT NOT NULL,
                metrics TEXT,
                is_resolved INTEGER DEFAULT 0,
                created_at INTEGER DEFAULT (strftime('%s', 'now')),
                resolved_at INTEGER,
                FOREIGN KEY (user_id) REFERENCES users(user_id)
            )
        `);

        // Backtest results table
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS backtest_results (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                strategy_name TEXT NOT NULL,
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                initial_capital REAL NOT NULL,
                final_capital REAL NOT NULL,
                total_trades INTEGER DEFAULT 0,
                winning_trades INTEGER DEFAULT 0,
                win_rate REAL DEFAULT 0,
                profit_factor REAL DEFAULT 0,
                sharpe_ratio REAL DEFAULT 0,
                max_drawdown REAL DEFAULT 0,
                parameters TEXT,
                created_at INTEGER DEFAULT (strftime('%s', 'now'))
            )
        `);

        // Create indexes
        await this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_trades_user_id ON trades(user_id);
            CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at);
            CREATE INDEX IF NOT EXISTS idx_positions_user_id ON positions(user_id);
            CREATE INDEX IF NOT EXISTS idx_positions_is_active ON positions(is_active);
            CREATE INDEX IF NOT EXISTS idx_api_usage_timestamp ON api_usage(timestamp);
            CREATE INDEX IF NOT EXISTS idx_anomaly_alerts_user_id ON anomaly_alerts(user_id);
        `);
    }

    // User operations
    async getUser(userId) {
        return await this.db.get('SELECT * FROM users WHERE user_id = ?', userId);
    }

    async createUser(userId, initialBalance = 20) {
        await this.db.run(`
            INSERT INTO users (user_id, starting_balance, current_balance, daily_start_balance, trading_capital, daily_reset_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `, userId, initialBalance, initialBalance, initialBalance, initialBalance, Date.now());
    }

    async updateUser(userId, updates) {
        const fields = Object.keys(updates).map(key => `${key} = ?`).join(', ');
        const values = [...Object.values(updates), Date.now(), userId];
        await this.db.run(`
            UPDATE users SET ${fields}, updated_at = ? WHERE user_id = ?
        `, values);
    }

    // Position operations
    async createPosition(userId, positionData) {
        const result = await this.db.run(`
            INSERT INTO positions (
                user_id, token_address, symbol, entry_price, entry_time,
                tokens_owned, invested_usdc, target_price, stop_loss_price,
                scalp_mode, tx_signature, bonding_progress, liquidity_usd,
                token_decimals, position_size_mode
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            userId, positionData.tokenAddress, positionData.symbol,
            positionData.entryPrice, positionData.entryTime, positionData.tokensOwned,
            positionData.investedUSDC, positionData.targetPrice, positionData.stopLossPrice,
            positionData.scalpMode ? 1 : 0, positionData.txSignature,
            positionData.bondingProgress, positionData.liquidityUSD,
            positionData.tokenDecimals, positionData.positionSizeMode
        ]);
        return result.lastID;
    }

    async getActivePositions(userId) {
        return await this.db.all(
            'SELECT * FROM positions WHERE user_id = ? AND is_active = 1',
            userId
        );
    }

    async getPosition(positionId) {
        return await this.db.get('SELECT * FROM positions WHERE id = ?', positionId);
    }

    async updatePosition(positionId, updates) {
        const fields = Object.keys(updates).map(key => `${key} = ?`).join(', ');
        const values = [...Object.values(updates), positionId];
        await this.db.run(`
            UPDATE positions SET ${fields} WHERE id = ?
        `, values);
    }

    async closePosition(positionId, exitData) {
        await this.db.run(`
            UPDATE positions 
            SET is_active = 0, exit_price = ?, exit_time = ?, 
                profit = ?, profit_percent = ?, exit_reason = ?, sell_tx_signature = ?
            WHERE id = ?
        `, [
            exitData.exitPrice, exitData.exitTime, exitData.profit,
            exitData.profitPercent, exitData.reason, exitData.sellTxSignature,
            positionId
        ]);
    }

    // Trade operations
    async recordTrade(userId, tradeData) {
        await this.db.run(`
            INSERT INTO trades (
                user_id, token_address, symbol, entry_price, exit_price,
                entry_time, exit_time, tokens_owned, invested_usdc, usdc_received,
                profit, profit_percent, reason, buy_tx_signature, sell_tx_signature,
                hold_time_minutes, bonding_progress, liquidity_usd, was_paper_trade
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            userId, tradeData.tokenAddress, tradeData.symbol,
            tradeData.entryPrice, tradeData.exitPrice, tradeData.entryTime,
            tradeData.exitTime, tradeData.tokensOwned, tradeData.investedUSDC,
            tradeData.usdcReceived, tradeData.profit, tradeData.profitPercent,
            tradeData.reason, tradeData.buyTxSignature, tradeData.sellTxSignature,
            tradeData.holdTimeMinutes, tradeData.bondingProgress,
            tradeData.liquidityUSD, tradeData.wasPaperTrade ? 1 : 0
        ]);
    }

    async getTradeHistory(userId, limit = 100) {
        return await this.db.all(`
            SELECT * FROM trades WHERE user_id = ? 
            ORDER BY created_at DESC LIMIT ?
        `, userId, limit);
    }

    async getTradesByDateRange(userId, startDate, endDate) {
        return await this.db.all(`
            SELECT * FROM trades 
            WHERE user_id = ? AND created_at BETWEEN ? AND ?
            ORDER BY created_at DESC
        `, userId, startDate, endDate);
    }

    // Performance metrics
    async savePerformanceMetrics(userId, metrics) {
        await this.db.run(`
            INSERT INTO performance_metrics (
                user_id, date, total_trades, winning_trades, losing_trades,
                total_profit, total_loss, win_rate, profit_factor, expectancy,
                largest_win, largest_loss, strategy_level
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            userId, new Date().toISOString().split('T')[0],
            metrics.totalTrades, metrics.winningTrades, metrics.losingTrades,
            metrics.totalProfit, metrics.totalLoss, metrics.winRate,
            metrics.profitFactor, metrics.expectancy, metrics.largestWin,
            metrics.largestLoss, metrics.strategyLevel
        ]);
    }

    async getPerformanceHistory(userId, days = 30) {
        return await this.db.all(`
            SELECT * FROM performance_metrics 
            WHERE user_id = ? 
            ORDER BY created_at DESC LIMIT ?
        `, userId, days);
    }

    // API usage tracking
    async trackAPIUsage(service, endpoint, estimatedPoints, success = true, errorMessage = null) {
        await this.db.run(`
            INSERT INTO api_usage (service, endpoint, estimated_points, success, error_message)
            VALUES (?, ?, ?, ?, ?)
        `, service, endpoint, estimatedPoints, success ? 1 : 0, errorMessage);
    }

    async getAPIUsageStats(hours = 24) {
        const since = Date.now() / 1000 - (hours * 3600);
        return await this.db.all(`
            SELECT service, endpoint, 
                   SUM(query_count) as total_queries,
                   SUM(estimated_points) as total_points,
                   SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful_queries,
                   SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failed_queries
            FROM api_usage
            WHERE timestamp >= ?
            GROUP BY service, endpoint
        `, since);
    }

    // Anomaly alerts
    async createAnomalyAlert(userId, anomalyType, severity, description, metrics) {
        await this.db.run(`
            INSERT INTO anomaly_alerts (user_id, anomaly_type, severity, description, metrics)
            VALUES (?, ?, ?, ?, ?)
        `, userId, anomalyType, severity, description, JSON.stringify(metrics));
    }

    async getUnresolvedAnomalies(userId) {
        return await this.db.all(`
            SELECT * FROM anomaly_alerts 
            WHERE user_id = ? AND is_resolved = 0
            ORDER BY created_at DESC
        `, userId);
    }

    async resolveAnomaly(anomalyId) {
        await this.db.run(`
            UPDATE anomaly_alerts 
            SET is_resolved = 1, resolved_at = ? 
            WHERE id = ?
        `, Date.now(), anomalyId);
    }

    // Backtest results
    async saveBacktestResult(backtestData) {
        await this.db.run(`
            INSERT INTO backtest_results (
                strategy_name, start_date, end_date, initial_capital, final_capital,
                total_trades, winning_trades, win_rate, profit_factor, sharpe_ratio,
                max_drawdown, parameters
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            backtestData.strategyName, backtestData.startDate, backtestData.endDate,
            backtestData.initialCapital, backtestData.finalCapital, backtestData.totalTrades,
            backtestData.winningTrades, backtestData.winRate, backtestData.profitFactor,
            backtestData.sharpeRatio, backtestData.maxDrawdown, JSON.stringify(backtestData.parameters)
        ]);
    }

    async getBacktestResults(limit = 50) {
        return await this.db.all(`
            SELECT * FROM backtest_results 
            ORDER BY created_at DESC LIMIT ?
        `, limit);
    }

    // Statistics and analytics
    async getTradeStatistics(userId) {
        return await this.db.get(`
            SELECT 
                COUNT(*) as total_trades,
                SUM(CASE WHEN profit > 0 THEN 1 ELSE 0 END) as winning_trades,
                SUM(CASE WHEN profit <= 0 THEN 1 ELSE 0 END) as losing_trades,
                AVG(profit) as avg_profit,
                AVG(profit_percent) as avg_profit_percent,
                MAX(profit_percent) as max_profit_percent,
                MIN(profit_percent) as min_profit_percent,
                SUM(profit) as total_profit,
                AVG(hold_time_minutes) as avg_hold_time
            FROM trades
            WHERE user_id = ?
        `, userId);
    }

    async getTopPerformingTokens(userId, limit = 10) {
        return await this.db.all(`
            SELECT 
                symbol,
                COUNT(*) as trade_count,
                SUM(profit) as total_profit,
                AVG(profit_percent) as avg_profit_percent,
                MAX(profit_percent) as best_trade
            FROM trades
            WHERE user_id = ?
            GROUP BY symbol
            ORDER BY total_profit DESC
            LIMIT ?
        `, userId, limit);
    }

    // Cleanup old data
    async cleanupOldData(daysToKeep = 90) {
        const cutoffTime = Date.now() / 1000 - (daysToKeep * 24 * 3600);
        
        await this.db.run('DELETE FROM api_usage WHERE timestamp < ?', cutoffTime);
        await this.db.run('DELETE FROM trades WHERE created_at < ? AND user_id NOT IN (SELECT user_id FROM users WHERE is_active = 1)', cutoffTime);
        
        console.log(`[Database] Cleaned up data older than ${daysToKeep} days`);
    }

    async close() {
        if (this.db) {
            await this.db.close();
            console.log('[Database] Connection closed');
        }
    }
}

module.exports = DatabaseManager;