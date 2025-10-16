require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const PORT = process.env.PORT || 4002;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const AUTHORIZED_USERS = (process.env.AUTHORIZED_USERS || '').split(',');

console.log('Starting minimal bot...');
console.log('Port:', PORT);
console.log('Webhook URL:', WEBHOOK_URL);

const app = express();
app.use(express.json());

const bot = new TelegramBot(TELEGRAM_TOKEN);

// Health check
app.get('/', (req, res) => {
    res.json({ 
        status: 'ok', 
        mode: 'webhook', 
        timestamp: new Date(),
        uptime: process.uptime()
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        uptime: Math.floor(process.uptime()),
        memory: process.memoryUsage()
    });
});

// Webhook endpoint
app.post('/webhook', (req, res) => {
    console.log('📨 Webhook received:', req.body?.update_id);
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// Handle /start
bot.onText(/\/start/, (msg) => {
    console.log('🚀 Start command from:', msg.from.id, msg.from.username);
    const isAuth = AUTHORIZED_USERS.includes(msg.from.id.toString()) || 
                   AUTHORIZED_USERS.length === 0 || 
                   AUTHORIZED_USERS[0] === '';
    
    if (!isAuth) {
        console.log('❌ Unauthorized user');
        bot.sendMessage(msg.chat.id, '❌ Unauthorized. Your ID: ' + msg.from.id);
        return;
    }
    
    console.log('✅ Sending response...');
    bot.sendMessage(msg.chat.id, 
        '✅ <b>Bot is WORKING!</b>\n\n' +
        'Railway deployment successful.\n' +
        'Webhook is active.\n\n' +
        'Send /status for more info.',
        { parse_mode: 'HTML' }
    );
});

bot.onText(/\/status/, (msg) => {
    const userId = msg.from.id.toString();
    const isAuth = AUTHORIZED_USERS.includes(userId) || 
                   AUTHORIZED_USERS.length === 0 || 
                   AUTHORIZED_USERS[0] === '';
    
    if (!isAuth) return;
    
    const uptime = Math.floor(process.uptime());
    
    bot.sendMessage(msg.chat.id, `
🤖 <b>BOT STATUS</b>

Status: 🟢 Online
Mode: Production (Railway)
Webhook: ✅ Active
Uptime: ${uptime}s

💾 Memory:
Heap: ${Math.floor(process.memoryUsage().heapUsed / 1024 / 1024)} MB
RSS: ${Math.floor(process.memoryUsage().rss / 1024 / 1024)} MB

✅ All systems operational
    `, { parse_mode: 'HTML' });
});

// Log all messages
bot.on('message', (msg) => {
    console.log('📩 Message from', msg.from.id, ':', msg.text);
});

// Start server
app.listen(PORT, '0.0.0.0', async () => {
    console.log('\n✅ Server running on port', PORT);
    console.log('✅ Listening on 0.0.0.0:' + PORT);
    
    try {
        // Delete old webhook
        await bot.deleteWebhook();
        console.log('✅ Old webhook deleted');
        
        // Wait
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Set new webhook
        const webhookUrl = `${WEBHOOK_URL}/webhook`;
        await bot.setWebHook(webhookUrl);
        console.log('✅ Webhook set:', webhookUrl);
        console.log('\n🎯 Bot is ready! Send /start in Telegram to test.\n');
        
    } catch (err) {
        console.error('❌ Webhook setup error:', err.message);
    }
});

console.log('Bot initialized');