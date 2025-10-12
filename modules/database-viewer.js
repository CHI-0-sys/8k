const express = require('express');
const DatabaseManager = require('./DatabaseManager');

const app = express();
const db = new DatabaseManager('../data/trading.db');

// Serve HTML page
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Trading Database Viewer</title>
    <style>
        body { 
            font-family: Arial, sans-serif; 
            margin: 20px;
            background: #f5f5f5;
        }
        .container { 
            max-width: 1400px; 
            margin: 0 auto;
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        h1 { color: #333; }
        .section { 
            margin: 30px 0; 
            padding: 20px;
            background: #fafafa;
            border-radius: 4px;
        }
        table { 
            width: 100%; 
            border-collapse: collapse; 
            margin: 20px 0;
            background: white;
        }
        th, td { 
            padding: 12px; 
            text-align: left; 
            border: 1px solid #ddd; 
        }
        th { 
            background: #4CAF50; 
            color: white;
            font-weight: bold;
        }
        tr:hover { background: #f5f5f5; }
        button { 
            padding: 10px 20px; 
            margin: 5px;
            background: #4CAF50;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        }
        button:hover { background: #45a049; }
        .positive { color: green; font-weight: bold; }
        .negative { color: red; font-weight: bold; }
        .stats { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin: 20px 0;
        }
        .stat-card {
            background: white;
            padding: 15px;
            border-radius: 4px;
            border-left: 4px solid #4CAF50;
        }
        .stat-label { 
            color: #666; 
            font-size: 12px;
            text-transform: uppercase;
        }
        .stat-value { 
            font-size: 24px; 
            font-weight: bold;
            color: #333;
            margin-top: 5px;
        }
        .loading { text-align: center; padding: 20px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎯 Trading Database Viewer</h1>
        
        <div class="section">
            <h2>Quick Actions</h2>
            <button onclick="loadUsers()">View Users</button>
            <button onclick="loadTrades()">View Trades</button>
            <button onclick="loadPositions()">View Positions</button>
            <button onclick="loadStats()">View Statistics</button>
            <button onclick="loadAPIUsage()">API Usage</button>
            <button onclick="loadAnomalies()">Anomalies</button>
        </div>

        <div id="content" class="section">
            <p>Click a button above to view data</p>
        </div>
    </div>

    <script>
        async function loadUsers() {
            const content = document.getElementById('content');
            content.innerHTML = '<div class="loading">Loading...</div>';
            
            const response = await fetch('/api/users');
            const users = await response.json();
            
            content.innerHTML = '<h2>Users</h2>' + 
                '<table>' +
                '<tr><th>User ID</th><th>Balance</th><th>Daily Profit</th><th>Total Trades</th><th>Win Rate</th><th>Active</th></tr>' +
                users.map(u => {
                    const winRate = u.total_trades > 0 ? ((u.successful_trades / u.total_trades) * 100).toFixed(1) : '0';
                    return \`<tr>
                        <td>\${u.user_id}</td>
                        <td>$\${u.current_balance.toFixed(2)}</td>
                        <td class="\${u.daily_profit >= 0 ? 'positive' : 'negative'}">$\${u.daily_profit.toFixed(2)} (\${u.daily_profit_percent.toFixed(2)}%)</td>
                        <td>\${u.total_trades}</td>
                        <td>\${winRate}%</td>
                        <td>\${u.is_active ? '✅' : '❌'}</td>
                    </tr>\`;
                }).join('') +
                '</table>';
        }

        async function loadTrades() {
            const content = document.getElementById('content');
            content.innerHTML = '<div class="loading">Loading...</div>';
            
            const response = await fetch('/api/trades');
            const trades = await response.json();
            
            content.innerHTML = '<h2>Recent Trades (Last 50)</h2>' + 
                '<table>' +
                '<tr><th>Symbol</th><th>Entry</th><th>Exit</th><th>Profit</th><th>Profit %</th><th>Hold Time</th><th>Reason</th><th>Date</th></tr>' +
                trades.map(t => \`<tr>
                    <td><strong>\${t.symbol}</strong></td>
                    <td>$\${t.entry_price.toFixed(4)}</td>
                    <td>$\${t.exit_price.toFixed(4)}</td>
                    <td class="\${t.profit >= 0 ? 'positive' : 'negative'}">$\${t.profit.toFixed(2)}</td>
                    <td class="\${t.profit_percent >= 0 ? 'positive' : 'negative'}">\${t.profit_percent.toFixed(2)}%</td>
                    <td>\${t.hold_time_minutes.toFixed(0)}m</td>
                    <td>\${t.reason}</td>
                    <td>\${new Date(t.created_at * 1000).toLocaleString()}</td>
                </tr>\`).join('') +
                '</table>';
        }

        async function loadPositions() {
            const content = document.getElementById('content');
            content.innerHTML = '<div class="loading">Loading...</div>';
            
            const response = await fetch('/api/positions');
            const positions = await response.json();
            
            content.innerHTML = '<h2>Active Positions</h2>' + 
                '<table>' +
                '<tr><th>Symbol</th><th>Entry Price</th><th>Target</th><th>Stop Loss</th><th>Invested</th><th>Tokens</th><th>Mode</th><th>Entry Time</th></tr>' +
                positions.map(p => \`<tr>
                    <td><strong>\${p.symbol}</strong></td>
                    <td>$\${p.entry_price.toFixed(4)}</td>
                    <td>$\${p.target_price.toFixed(4)}</td>
                    <td>$\${p.stop_loss_price.toFixed(4)}</td>
                    <td>$\${p.invested_usdc.toFixed(2)}</td>
                    <td>\${p.tokens_owned.toFixed(2)}</td>
                    <td>\${p.scalp_mode ? 'Scalp' : 'Hold'}</td>
                    <td>\${new Date(p.entry_time).toLocaleString()}</td>
                </tr>\`).join('') +
                '</table>';
        }

        async function loadStats() {
            const content = document.getElementById('content');
            content.innerHTML = '<div class="loading">Loading...</div>';
            
            const response = await fetch('/api/stats');
            const stats = await response.json();
            
            const winRate = stats.total_trades > 0 ? 
                ((stats.winning_trades / stats.total_trades) * 100).toFixed(1) : '0';
            
            content.innerHTML = '<h2>Trading Statistics</h2>' +
                '<div class="stats">' +
                \`<div class="stat-card">
                    <div class="stat-label">Total Trades</div>
                    <div class="stat-value">\${stats.total_trades || 0}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Win Rate</div>
                    <div class="stat-value">\${winRate}%</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Total Profit</div>
                    <div class="stat-value \${stats.total_profit >= 0 ? 'positive' : 'negative'}">
                        $\${(stats.total_profit || 0).toFixed(2)}
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Avg Profit %</div>
                    <div class="stat-value">\${(stats.avg_profit_percent || 0).toFixed(2)}%</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Best Trade</div>
                    <div class="stat-value positive">\${(stats.max_profit_percent || 0).toFixed(2)}%</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Worst Trade</div>
                    <div class="stat-value negative">\${(stats.min_profit_percent || 0).toFixed(2)}%</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Avg Hold Time</div>
                    <div class="stat-value">\${(stats.avg_hold_time || 0).toFixed(0)}m</div>
                </div>\` +
                '</div>';
        }

        async function loadAPIUsage() {
            const content = document.getElementById('content');
            content.innerHTML = '<div class="loading">Loading...</div>';
            
            const response = await fetch('/api/api-usage');
            const usage = await response.json();
            
            content.innerHTML = '<h2>API Usage (Last 24 Hours)</h2>' + 
                '<table>' +
                '<tr><th>Service</th><th>Endpoint</th><th>Total Queries</th><th>Points Used</th><th>Success Rate</th></tr>' +
                usage.map(u => {
                    const successRate = ((u.successful_queries / u.total_queries) * 100).toFixed(1);
                    return \`<tr>
                        <td>\${u.service}</td>
                        <td>\${u.endpoint}</td>
                        <td>\${u.total_queries}</td>
                        <td>\${u.total_points}</td>
                        <td>\${successRate}%</td>
                    </tr>\`;
                }).join('') +
                '</table>';
        }

        async function loadAnomalies() {
            const content = document.getElementById('content');
            content.innerHTML = '<div class="loading">Loading...</div>';
            
            const response = await fetch('/api/anomalies');
            const anomalies = await response.json();
            
            content.innerHTML = '<h2>Unresolved Anomalies</h2>' + 
                (anomalies.length === 0 ? '<p>No anomalies detected ✅</p>' :
                '<table>' +
                '<tr><th>Type</th><th>Severity</th><th>Description</th><th>Date</th></tr>' +
                anomalies.map(a => \`<tr>
                    <td>\${a.anomaly_type}</td>
                    <td>\${a.severity}</td>
                    <td>\${a.description}</td>
                    <td>\${new Date(a.created_at * 1000).toLocaleString()}</td>
                </tr>\`).join('') +
                '</table>');
        }
    </script>
</body>
</html>
    `);
});

// API endpoints
app.get('/api/users', async (req, res) => {
    const users = await db.db.all('SELECT * FROM users');
    res.json(users);
});

app.get('/api/trades', async (req, res) => {
    const trades = await db.db.all('SELECT * FROM trades ORDER BY created_at DESC LIMIT 50');
    res.json(trades);
});

app.get('/api/positions', async (req, res) => {
    const positions = await db.db.all('SELECT * FROM positions WHERE is_active = 1');
    res.json(positions);
});

app.get('/api/stats', async (req, res) => {
    const stats = await db.db.get(`
        SELECT 
            COUNT(*) as total_trades,
            SUM(CASE WHEN profit > 0 THEN 1 ELSE 0 END) as winning_trades,
            SUM(CASE WHEN profit <= 0 THEN 1 ELSE 0 END) as losing_trades,
            AVG(profit_percent) as avg_profit_percent,
            MAX(profit_percent) as max_profit_percent,
            MIN(profit_percent) as min_profit_percent,
            SUM(profit) as total_profit,
            AVG(hold_time_minutes) as avg_hold_time
        FROM trades
    `);
    res.json(stats);
});

app.get('/api/api-usage', async (req, res) => {
    const usage = await db.getAPIUsageStats(24);
    res.json(usage);
});

app.get('/api/anomalies', async (req, res) => {
    const anomalies = await db.db.all('SELECT * FROM anomaly_alerts WHERE is_resolved = 0');
    res.json(anomalies);
});

// Start server
async function start() {
    await db.init();
    app.listen(3000, () => {
        console.log('📊 Database viewer running at http://localhost:3000');
    });
}

start();