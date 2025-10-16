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
    res.json({ status: 'ok', mode: 'webhook', timestamp: new Date() });
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy', uptime: process.uptime() });
});

// Webhook endpoint
app.post('/webhook', (req, res) => {
    console.log('Webhook received:', req.body);
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// Start server
app.listen(PORT, '0.0.0.0', async () => {
    console.log('Server running on port', PORT);
    
    try {
        // Delete old webhook
        await bot.deleteWebHook();
        console.log('Old webhook deleted');
        
        // Set new webhook
        const webhookUrl = `${WEBHOOK_URL}/webhook`;
        await bot.setWebHook(webhookUrl);
        console.log('Webhook set:', webhookUrl);
        
        // Verify
        const info = await bot.getWebhookInfo();
        console.log('Webhook info:', info);
        
    } catch (err) {
        console.error('Webhook setup failed:', err.message);
    }
});

// Handle /start
bot.onText(/\/start/, (msg) => {
    console.log('Start command from:', msg.from.id);
    const isAuth = AUTHORIZED_USERS.includes(msg.from.id.toString());
    
    if (!isAuth) {
        bot.sendMessage(msg.chat.id, '❌ Unauthorized');
        return;
    }
    
    bot.sendMessage(msg.chat.id, '✅ Minimal bot working on Railway!');
});

console.log('Bot initialized');