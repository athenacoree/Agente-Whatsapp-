require('dotenv').config();
const express = require('express');
const WABot = require('./bot');
const mongoService = require('./mongoService');
const settingsService = require('./settingsService');
const path = require('path');

const app = express();
const PORT = 3010; // Fixed port as requested

// Global concurrent tracking state
global.activeChatsCount = 0;
global.recentActiveUsers = new Set(); // Track unique users in last 15 min

// Grok xAI configuration store (in-memory persistent state)
global.grokConfig = {
    apiKey: process.env.GROK_API_KEY || '',
    model: 'grok-2-1212',
    enabled: false
};

// Load configuration
const config = {
    wahaApiUrl: process.env.WAHA_API_URL || 'http://localhost:3000',
    wahaSessionName: process.env.WAHA_SESSION_NAME || 'default',
    wahaApiKey: process.env.WAHA_API_KEY,
    groqApiKey: process.env.GROQ_API_KEY,
    botCommandKey: process.env.BOT_COMMAND_KEY || '!ai',
    botName: process.env.BOT_NAME || 'WA Bot',
    simulationMode: process.env.SIMULATION_MODE === 'true',
    monitoredChats: process.env.MONITORED_CHATS ? process.env.MONITORED_CHATS.split(',').map(chat => chat.trim()) : [],
    spamDetection: {
        maxMessagesPerMinute: parseInt(process.env.SPAM_MAX_MESSAGES_PER_MINUTE) || 20,  // Human-like: rapid conversation
        maxMessagesPerHour: parseInt(process.env.SPAM_MAX_MESSAGES_PER_HOUR) || 100,    // Human-like: active chatting
        maxMessagesPerDay: parseInt(process.env.SPAM_MAX_MESSAGES_PER_DAY) || 500,     // Human-like: very active user
        cooldownSeconds: parseInt(process.env.SPAM_COOLDOWN_SECONDS) || 1,             // Reduced: allow quick replies
        detectionThreshold: parseInt(process.env.SPAM_DETECTION_THRESHOLD) || 50       // Higher threshold to reduce false positives
    }
};

// Validate required environment variables
function validateConfig() {
    const missing = [];

    if (!config.groqApiKey) {
        missing.push('GROQ_API_KEY');
    }

    if (missing.length > 0) {
        console.error('❌ Missing required environment variables:');
        missing.forEach(key => console.error(`   - ${key}`));
        console.error('\nPlease copy .env.example to .env and fill in the required values.');
        process.exit(1);
    }

    console.log('✅ Configuration validated');
}

// Error handling middleware
function setupErrorHandling() {
    process.on('uncaughtException', (error) => {
        console.error('Uncaught Exception:', error);
        process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
        console.error('Unhandled Rejection at:', promise, 'reason:', reason);
        process.exit(1);
    });

    // Graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n🛑 Received SIGINT. Shutting down gracefully...');
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        console.log('\n🛑 Received SIGTERM. Shutting down gracefully...');
        process.exit(0);
    });
}

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '..', 'public')));

// Admin redirection
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

// MongoDB Atlas Admin Endpoints
app.post('/api/mongo/config', express.json(), async (req, res) => {
    try {
        const { name, uri, database, category, limitMb } = req.body;
        if (!uri) {
            return res.status(400).json({ error: 'URI is required' });
        }
        const config = await mongoService.addConfig({ name, uri, database, category, limitMb });
        res.status(201).json({ success: true, data: config });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Users and Access Control Endpoints
app.get('/api/admin/users', async (req, res) => {
    try {
        if (!bot || !bot.activeDatabaseService) {
            return res.json({ success: true, data: [] });
        }
        const { search } = req.query;
        let users = [];
        if (search) {
            users = await bot.activeDatabaseService.searchUserData(search, 'all');
        } else {
            users = await bot.activeDatabaseService.getAllUserData(100, 0);
        }

        // Merge in the actual detail (data_json) if database returned only summary rows,
        // and add access status from settings
        const settings = settingsService.getSettings();
        const userAccess = settings.userAccess || {};

        const enrichedUsers = await Promise.all(users.map(async (u) => {
            let fullUser = u;
            if (!u.data_json) {
                // Fetch full data if we just got a summary
                const detail = await bot.activeDatabaseService.getUserData(u.chat_id);
                if (detail) fullUser = detail;
            }
            return {
                chat_id: fullUser.chat_id,
                user_name: fullUser.user_name,
                phone_number: fullUser.phone_number,
                created_at: fullUser.created_at,
                updated_at: fullUser.updated_at,
                data_json: typeof fullUser.data_json === 'string' ? JSON.parse(fullUser.data_json) : (fullUser.data_json || {}),
                tags: Array.isArray(fullUser.tags) ? fullUser.tags : (typeof fullUser.tags === 'string' ? JSON.parse(fullUser.tags) : []),
                accessStatus: userAccess[fullUser.chat_id] || 'normal'
            };
        }));

        res.json({ success: true, data: enrichedUsers });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/users/:chatId/status', express.json(), (req, res) => {
    try {
        const { chatId } = req.params;
        const { status } = req.body; // 'normal', 'banned', 'special'
        if (!['normal', 'banned', 'special'].includes(status)) {
            return res.status(400).json({ error: 'Status no válido' });
        }

        const settings = settingsService.getSettings();
        settings.userAccess = settings.userAccess || {};
        settings.userAccess[chatId] = status;

        settingsService.saveSettings({ userAccess: settings.userAccess });
        res.json({ success: true, data: settings.userAccess });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/users/:chatId/add-contact', async (req, res) => {
    try {
        const { chatId } = req.params;
        if (!bot || !bot.wahaService) {
            return res.status(503).json({ error: 'Bot or WAHA service not ready' });
        }

        // Get user details to retrieve name
        const user = await bot.activeDatabaseService.getUserData(chatId);
        const name = user ? user.user_name : 'Contacto Bot';
        const cleanPhone = chatId.replace('@c.us', '').replace('@g.us', '');

        const result = await bot.wahaService.addContact(cleanPhone, name);
        res.json({ success: true, result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Multi-WhatsApp Session Management Endpoints
app.get('/api/whatsapp/sessions', async (req, res) => {
    try {
        if (!bot || !bot.wahaService) {
            return res.json({ success: true, data: [{ name: 'default', status: 'RUNNING' }] });
        }
        const sessions = await bot.wahaService.getSessions();
        res.json({ success: true, data: sessions });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/whatsapp/sessions', express.json(), async (req, res) => {
    try {
        const { sessionName } = req.body;
        if (!sessionName) {
            return res.status(400).json({ error: 'Session name is required' });
        }
        if (!bot || !bot.wahaService) {
            return res.status(503).json({ error: 'Bot or WAHA service not ready' });
        }
        const result = await bot.wahaService.startSession(sessionName);
        res.json({ success: true, result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/whatsapp/sessions/:session', async (req, res) => {
    try {
        const { session } = req.params;
        if (!bot || !bot.wahaService) {
            return res.status(503).json({ error: 'Bot or WAHA service not ready' });
        }
        const result = await bot.wahaService.stopSession(session);
        res.json({ success: true, result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/whatsapp/qr/:session', async (req, res) => {
    try {
        const { session } = req.params;
        if (!bot || !bot.wahaService) {
            return res.status(503).json({ error: 'Bot or WAHA service not ready' });
        }
        const qrData = await bot.wahaService.getSessionQr(session);
        res.json({ success: true, qr: qrData });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/mongo/config', (req, res) => {
    res.json({ success: true, data: mongoService.getConfigs() });
});

app.delete('/api/mongo/config/:id', async (req, res) => {
    try {
        const result = await mongoService.removeConfig(req.params.id);
        res.json({ success: result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/mongo/test', express.json(), async (req, res) => {
    try {
        const { uri } = req.body;
        if (!uri) {
            return res.status(400).json({ error: 'URI is required' });
        }
        const result = await mongoService.testConnection(uri);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/mongo/stats', async (req, res) => {
    try {
        const stats = await mongoService.getAllDbStats();
        res.json({ success: true, data: stats });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Settings and Outbound Configuration Endpoints
app.get('/api/admin/settings', (req, res) => {
    res.json({ success: true, data: settingsService.getSettings() });
});

app.post('/api/admin/settings', express.json(), (req, res) => {
    try {
        const updated = settingsService.saveSettings(req.body);
        res.json({ success: true, data: updated });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/outbound/send', express.json(), async (req, res) => {
    try {
        if (!bot || !bot.wahaService) {
            return res.status(503).json({ error: 'Bot or WAHA service not initialized' });
        }

        const settings = settingsService.getSettings();
        const { numbers, messageTemplate } = settings.outbound;

        if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
            return res.status(400).json({ error: 'No outbound numbers configured' });
        }

        const results = [];
        for (let num of numbers) {
            num = num.trim();
            if (!num) continue;
            // Ensure format has @c.us
            let chatId = num;
            if (!chatId.includes('@')) {
                chatId = `${chatId}@c.us`;
            }

            try {
                // If the user does not exist in our system, save them first with a marker/state
                // indicating we initiated contact with them
                if (bot.activeDatabaseService) {
                    const existing = await bot.activeDatabaseService.getUserData(chatId);
                    if (!existing) {
                        await bot.activeDatabaseService.upsertUserData(chatId, {
                            userName: `Usuario ${num}`,
                            phoneNumber: num,
                            tags: ['outbound-initiated'],
                            data: {
                                is_registered: false,
                                outbound_initiated: true,
                                outbound_message_sent: true,
                                outbound_message_time: new Date().toISOString()
                            }
                        });
                    }
                }

                await bot.wahaService.sendMessage(chatId, messageTemplate);
                results.push({ number: num, status: 'sent' });
            } catch (err) {
                console.error(`Failed to send outbound message to ${num}:`, err.message);
                results.push({ number: num, status: 'failed', error: err.message });
            }
        }

        res.json({ success: true, results });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Grok xAI Configuration Endpoints
app.get('/api/grok/config', (req, res) => {
    res.json({ success: true, data: global.grokConfig });
});

app.post('/api/grok/config', express.json(), (req, res) => {
    try {
        const { apiKey, model, enabled } = req.body;
        if (apiKey !== undefined) global.grokConfig.apiKey = apiKey;
        if (model !== undefined) global.grokConfig.model = model;
        if (enabled !== undefined) global.grokConfig.enabled = enabled;

        // Propagate changes to dynamic Grok service if required
        if (bot && bot.grokService) {
            bot.grokService.apiKey = global.grokConfig.apiKey;
            bot.grokService.model = global.grokConfig.model;
        }

        res.json({ success: true, data: global.grokConfig });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Endpoint to obtain bot registration and connection status
app.get('/api/admin/bot/status', async (req, res) => {
    try {
        if (!bot) {
            return res.status(503).json({ error: 'Bot is not initialized' });
        }

        // Get status from database
        const dbConfig = await bot.activeDatabaseService.getBotConfig('bot_phone_number');
        const wahaStatus = await bot.wahaService.getBotStatus();

        // Count messages sent, received, and unique active users
        let messagesSent = 0;
        let messagesReceived = 0;
        let activeUsers = 0;

        if (bot.activeDatabaseService) {
            try {
                // Get general logs stats
                const stats = await bot.activeDatabaseService.getMessageStats();
                messagesReceived = parseInt(stats.totalMessages) || 0;
                activeUsers = parseInt(stats.uniqueUsers) || 0;

                // For sent, check message logs where response_content is not null
                if (bot.activeDatabaseService.pool) {
                    const sentRes = await bot.activeDatabaseService.pool.query(
                        'SELECT COUNT(*) as count FROM message_logs WHERE response_content IS NOT NULL'
                    );
                    messagesSent = parseInt(sentRes.rows[0].count) || 0;
                } else if (bot.activeDatabaseService.db) {
                    const sentRes = await new Promise((resolve, reject) => {
                        bot.activeDatabaseService.db.get(
                            'SELECT COUNT(*) as count FROM message_logs WHERE response_content IS NOT NULL',
                            (err, row) => {
                                if (err) reject(err);
                                else resolve(row);
                            }
                        );
                    });
                    messagesSent = parseInt(sentRes.count) || 0;
                }
            } catch (statsErr) {
                console.error('Error fetching message count for bot status:', statsErr.message);
            }
        }

        res.json({
            success: true,
            data: {
                registered: !!dbConfig,
                phoneNumber: dbConfig ? dbConfig.value : null,
                verified: dbConfig ? !!dbConfig.verified : false,
                connected: wahaStatus.connected,
                sessionId: wahaStatus.sessionId,
                status: wahaStatus.status,
                stats: {
                    sent: messagesSent,
                    received: messagesReceived,
                    users: activeUsers
                }
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Request verification code to register new bot number
app.post('/api/admin/bot/register/request', express.json(), async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        if (!phoneNumber) {
            return res.status(400).json({ error: 'Phone number is required' });
        }

        if (!bot) {
            return res.status(503).json({ error: 'Bot is not initialized' });
        }

        const cleanPhone = phoneNumber.replace('+', '').trim();
        const result = await bot.wahaService.requestRegistration(cleanPhone);

        // Store intermediate state in database
        await bot.activeDatabaseService.setBotConfig('bot_phone_number', phoneNumber, false);

        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Verify registration code
app.post('/api/admin/bot/register/verify', express.json(), async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) {
            return res.status(400).json({ error: 'Verification code is required' });
        }

        if (!bot) {
            return res.status(503).json({ error: 'Bot is not initialized' });
        }

        // Get temporary number from db
        const dbConfig = await bot.activeDatabaseService.getBotConfig('bot_phone_number');
        if (!dbConfig) {
            return res.status(400).json({ error: 'No phone number registration in progress' });
        }

        const result = await bot.wahaService.verifyRegistration(dbConfig.value, code);

        // Mark as verified in database
        await bot.activeDatabaseService.setBotConfig('bot_phone_number', dbConfig.value, true);

        // Auto-reconnect with the new registered number
        await bot.wahaService.connectBot(dbConfig.value);

        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get registration status
app.get('/api/admin/bot/register/status', async (req, res) => {
    try {
        if (!bot) {
            return res.status(503).json({ error: 'Bot is not initialized' });
        }

        const dbConfig = await bot.activeDatabaseService.getBotConfig('bot_phone_number');
        res.json({
            success: true,
            data: {
                phoneNumber: dbConfig ? dbConfig.value : null,
                verified: dbConfig ? !!dbConfig.verified : false,
                registeredAt: dbConfig ? dbConfig.registered_at : null
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Connect bot with registered number
app.post('/api/admin/bot/connect', async (req, res) => {
    try {
        if (!bot) {
            return res.status(503).json({ error: 'Bot is not initialized' });
        }

        const dbConfig = await bot.activeDatabaseService.getBotConfig('bot_phone_number');
        if (!dbConfig) {
            return res.status(400).json({ error: 'No registered number to connect' });
        }

        const result = await bot.wahaService.connectBot(dbConfig.value);
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Real-time system stats endpoint
app.get('/api/admin/stats', async (req, res) => {
    try {
        let accountsCount = 0;
        let wahaStatus = 'Disconnected';

        if (bot && bot.activeDatabaseService) {
            try {
                // Fetch unique users count from active database
                const users = await bot.activeDatabaseService.getAllUserData(1000, 0);
                accountsCount = users.length;
            } catch (dbError) {
                console.error('Error fetching user count for stats:', dbError.message);
            }
        }

        if (bot && bot.wahaService) {
            try {
                const conn = await bot.wahaService.checkConnection();
                if (conn && conn.status === 'connected') {
                    wahaStatus = 'Connected';
                }
            } catch (wahaError) {
                wahaStatus = 'Disconnected';
            }
        }

        res.json({
            success: true,
            data: {
                accountsCount,
                activeUsersCount: global.recentActiveUsers.size,
                concurrentChatsCount: global.activeChatsCount,
                wahaStatus,
                uptime: process.uptime()
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// MCP Tools endpoints for Admin UI integration
app.get('/api/admin/mcp/tools', async (req, res) => {
    try {
        if (!bot || !bot.aiChatService || !bot.aiChatService.mcpServer) {
            return res.status(503).json({ error: 'MCP Server not available yet' });
        }

        // Expose available tools by invoking the list schema handler
        const listRequestHandler = bot.aiChatService.mcpServer.server._requestHandlers.get('tools/list');
        if (!listRequestHandler) {
            return res.json({ success: true, tools: [] });
        }
        const toolsList = await listRequestHandler();
        res.json({ success: true, tools: toolsList.tools || [] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/mcp/tools/execute', express.json(), async (req, res) => {
    try {
        const { name, arguments: args } = req.body;
        if (!bot || !bot.aiChatService || !bot.aiChatService.mcpServer) {
            return res.status(503).json({ error: 'MCP Server not available yet' });
        }

        const callRequestHandler = bot.aiChatService.mcpServer.server._requestHandlers.get('tools/call');
        if (!callRequestHandler) {
            return res.status(500).json({ error: 'Tool execution handler not registered' });
        }

        const result = await callRequestHandler({ params: { name, arguments: args } });
        res.json({ success: true, result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        bot: {
            name: config.botName,
            commandKey: config.botCommandKey,
            wahaApiUrl: config.wahaApiUrl
        }
    });
});

// Bot status endpoint
app.get('/bot/status', (req, res) => {
    const status = {
        status: 'running',
        timestamp: new Date().toISOString(),
        simulationMode: config.simulationMode,
        config: {
            botName: config.botName,
            commandKey: config.botCommandKey,
            wahaSessionName: config.wahaSessionName,
            wahaApiUrl: config.wahaApiUrl
        }
    };

    // Include spam statistics if bot is initialized
    if (bot) {
        status.spamStats = bot.getSpamStats();
        status.spamConfig = config.spamDetection;
    }

    res.json(status);
});

let bot; // Global bot variable

// Test endpoint for simulation
app.post('/bot/test-message', express.json(), async (req, res) => {
    try {
        if (!bot) {
            return res.status(503).json({ error: 'Bot not initialized yet' });
        }

        const { message, chatId, from } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        // Simulate incoming message
        const testMessage = {
            id: Date.now().toString(),
            body: message,
            chatId: chatId || 'test-chat@c.us',
            from: from || 'test-user@c.us',
            timestamp: Date.now(),
            notifyName: 'Test User'
        };

        // Process the message
        await bot.handleIncomingMessage(testMessage);

        res.json({
            success: true,
            message: 'Test message processed',
            testMessage
        });
    } catch (error) {
        console.error('Error processing test message:', error);
        res.status(500).json({
            error: 'Failed to process test message',
            details: error.message
        });
    }
});

// Webhook endpoint for WAHA
app.post('/webhook', express.json(), async (req, res) => {
    try {
        if (!bot) {
            return res.status(503).json({ error: 'Bot not initialized yet' });
        }

        console.log('📥 Received webhook:', JSON.stringify(req.body, null, 2));

        // Handle WAHA webhook format: {"chatId": "11111111111@c.us", "text": "Hi there!", "session": "default"}
        if (req.body.chatId && req.body.text) {
            const message = {
                id: Date.now().toString(),
                body: req.body.text,
                text: req.body.text,
                chatId: req.body.chatId,
                from: req.body.chatId,
                timestamp: Date.now(),
                notifyName: 'WhatsApp User',
                session: req.body.session || 'default'
            };

            await bot.handleIncomingMessage(message);
            console.log(`✅ Processed message from ${req.body.chatId}: "${req.body.text}"`);
        }
        // Handle WAHA event format (the real format being sent)
        else if (req.body.event && req.body.payload) {
            const payload = req.body.payload;

            if ((req.body.event === 'message' || req.body.event === 'message.any') &&
                payload.body &&
                payload.from &&
                !payload.fromMe) {

                const message = {
                    id: payload.id || Date.now().toString(),
                    body: payload.body,
                    text: payload.body,
                    chatId: payload.from,
                    from: payload.from,
                    timestamp: payload.timestamp || Date.now(),
                    notifyName: payload.notifyName || 'WhatsApp User',
                    session: req.body.session || 'default'
                };

                await bot.handleIncomingMessage(message);
                console.log(`✅ Processed message from ${payload.from}: "${payload.body}"`);
            }
        }
        // Handle multiple messages format
        else if (req.body.messages && Array.isArray(req.body.messages)) {
            for (const msg of req.body.messages) {
                if (msg.chatId && (msg.body || msg.text)) {
                    const message = {
                        id: msg.id || Date.now().toString(),
                        body: msg.body || msg.text,
                        text: msg.text || msg.body,
                        chatId: msg.chatId,
                        from: msg.from || msg.chatId,
                        timestamp: msg.timestamp || Date.now(),
                        notifyName: msg.notifyName || 'WhatsApp User',
                        session: msg.session || 'default'
                    };

                    await bot.handleIncomingMessage(message);
                    console.log(`✅ Processed message from ${msg.chatId}: "${msg.body || msg.text}"`);
                }
            }
        }
        // Handle other webhook formats
        else {
            const messages = req.body.event && req.body.event.data ? req.body.event.data : [req.body];
            for (const message of messages) {
                if (message && (message.body || message.text)) {
                    await bot.handleIncomingMessage(message);
                }
            }
        }

        res.json({ success: true, message: 'Webhook processed successfully' });
    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).json({
            error: 'Failed to process webhook',
            details: error.message
        });
    }
});

// Start server and bot
async function startServer() {
    try {
        // Setup error handling
        setupErrorHandling();

        // Validate configuration
        validateConfig();

        // Create and initialize bot
        console.log('🤖 Initializing WA Bot...');
        bot = new WABot(config);

        // Check WAHA connection
        if (config.simulationMode) {
            console.log('🔧 Running in SIMULATION MODE - WAHA connection not required');
            console.log('💭 Bot will simulate message handling for testing');
        } else {
            const initialized = await bot.initialize();
            if (!initialized) {
                console.error('⚠️  WAHA connection failed, but bot will continue in limited mode');
                console.log('📱 To use full functionality, ensure WAHA is running on:', config.wahaApiUrl);
                console.log('🔧 Or set SIMULATION_MODE=true in .env for testing');
            } else {
                console.log('✅ WAHA service initialized successfully');
            }
        }

        // Start Express server on fixed port
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`🌐 Express server running on port ${PORT}`);
            console.log(`📊 Health check: http://localhost:${PORT}/health`);
            console.log(`🤖 Bot status: http://localhost:${PORT}/bot/status`);
            console.log(`🔗 Webhook URL: http://192.168.18.182:${PORT}/webhook`);
        }).on('error', (err) => {
            console.error('❌ Failed to start server:', err);
            if (err.code === 'EADDRINUSE') {
                console.error(`❌ Port ${PORT} is already in use. Please stop the other process or change the PORT in .env`);
            }
            process.exit(1);
        });

        // Start message polling (DISABLED - WAHA requires chatId for each request)
        console.log('📡 Bot ready to receive messages via webhook');
        console.log('🔗 Webhook URL: http://localhost:' + PORT + '/webhook');
        console.log('💡 Configure WAHA to send webhooks to this URL for real-time message processing');
        console.log('🧪 Use test endpoint: http://localhost:' + PORT + '/bot/test-message for testing');

        // For now, disable polling as WAHA API requires specific chatId
        // if (!config.simulationMode) {
        //     bot.startPolling(3000);
        // }

        // Cleanup old conversations every hour
        setInterval(() => {
            bot.cleanup();
            console.log('🧹 Cleaned up old conversation history');
        }, 60 * 60 * 1000);

        console.log('✅ Bot started successfully!');
        console.log(`📝 Command key: "${config.botCommandKey}"`);
        console.log(`🤖 Bot name: "${config.botName}"`);
        console.log('💬 The bot will respond to messages starting with the command key in both private and group chats.');

    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

// Start the application
startServer();
