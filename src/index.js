require('dotenv').config();
const express = require('express');
const WABot = require('./bot');
const mongoService = require('./mongoService');
const settingsService = require('./settingsService');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const axios = require('axios');

const app = express();
const PORT = 3010; // Fixed port as requested

// Proxy middleware for WAHA endpoints
app.use(async (req, res, next) => {
    const isBotApi = req.path.startsWith('/api/mongo') ||
                      req.path.startsWith('/api/whatsapp') ||
                      req.path.startsWith('/api/admin') ||
                      req.path.startsWith('/api/grok');

    const isWahaPath = (req.path.startsWith('/api/') && !isBotApi) ||
                       req.path.startsWith('/dashboard') ||
                       req.path.startsWith('/swagger') ||
                       req.path === '/'; // waha status check

    if (isWahaPath) {
        try {
            const wahaUrl = `http://localhost:3012${req.originalUrl}`;
            console.log(`[PROXY] Forwarding ${req.method} ${req.originalUrl} to WAHA at ${wahaUrl}`);

            // Forward headers
            const headers = { ...req.headers };
            delete headers.host; // let axios handle Host header

            // Inject WAHA_API_KEY if not provided by the client
            if (process.env.WAHA_API_KEY && !headers['x-api-key']) {
                headers['X-Api-Key'] = process.env.WAHA_API_KEY;
            }

            // Forward request to WAHA using axios with stream
            const response = await axios({
                method: req.method,
                url: wahaUrl,
                headers: headers,
                data: req, // Pipe raw request stream
                params: req.query,
                responseType: 'stream',
                validateStatus: () => true
            });

            // Forward status and headers
            res.status(response.status);
            Object.entries(response.headers).forEach(([key, val]) => {
                res.setHeader(key, val);
            });

            // Pipe response back to the client
            response.data.pipe(res);
        } catch (error) {
            console.error('[PROXY] Error forwarding request to WAHA:', error.message);
            res.status(502).json({ error: 'Failed to communicate with internal WAHA service' });
        }
    } else {
        next();
    }
});

let wahaProcess = null;

function findWahaPath() {
    const candidatePaths = [
        '/app/dist/main.js',
        '/app/dist/src/main.js',
        '/app/main.js',
        '/app/dist/main',
        '../dist/main.js',
        '../dist/src/main.js'
    ];

    for (const p of candidatePaths) {
        if (fs.existsSync(p)) {
            return p;
        }
    }

    // Recursive search in /app excluding bot, node_modules, and .git
    console.log('🔍 Searching recursively for WAHA main.js in /app...');
    try {
        const found = [];
        function searchDir(dir) {
            if (dir.includes('/app/bot') || dir.includes('node_modules') || dir.includes('.git')) {
                return;
            }
            if (!fs.existsSync(dir)) return;
            const files = fs.readdirSync(dir, { withFileTypes: true });
            for (const file of files) {
                const fullPath = path.join(dir, file.name);
                if (file.isDirectory()) {
                    searchDir(fullPath);
                } else if (file.isFile() && (file.name === 'main.js' || file.name === 'main')) {
                    found.push(fullPath);
                }
            }
        }
        searchDir('/app');
        if (found.length > 0) {
            console.log(`🎯 Found matching WAHA entrypoint(s) via recursive search: ${found.join(', ')}`);
            return found[0];
        }
    } catch (e) {
        console.error('⚠️ Error searching for WAHA files:', e.message);
    }

    // List the contents of /app as a diagnostic fallback
    console.log('📁 Printing directory contents of /app to assist diagnosis:');
    try {
        const listDir = (dir, depth = 0) => {
            if (depth > 2) return; // Prevent too deep listing
            if (!fs.existsSync(dir)) return;
            const files = fs.readdirSync(dir, { withFileTypes: true });
            for (const file of files) {
                const indent = '  '.repeat(depth);
                console.log(`${indent}- ${file.name}${file.isDirectory() ? '/' : ''}`);
                if (file.isDirectory() && file.name !== 'node_modules' && file.name !== '.git' && file.name !== 'bot') {
                    listDir(path.join(dir, file.name), depth + 1);
                }
            }
        };
        listDir('/app');
    } catch (e) {
        console.error('⚠️ Failed to list /app directory:', e.message);
    }

    return null;
}

function startWaha() {
    const wahaPath = findWahaPath();

    if (wahaPath) {
        console.log(`🚀 Found internal WAHA at ${wahaPath}. Spawning child process...`);

        const wahaEnv = {
            ...process.env,
            PORT: '3012', // Run WAHA on an internal port
            API_ENABLED: 'true',
            ENGINE: process.env.WHATSAPP_DEFAULT_ENGINE || 'nowjs',
            LOG_LEVEL: 'info',
            WEBHOOK_URL: 'http://localhost:3010/webhook',
            WEBHOOK_EVENTS: 'message,ack,message.any'
        };

        // Temporary authentication disablement for testing phase
        if (process.env.DISABLE_AUTH === 'true') {
            console.log('🔓 DISABLE_AUTH=true detected. Disabling WAHA API Key, Dashboard, and Swagger authentication.');
            wahaEnv.WAHA_API_KEY = '';
            wahaEnv.WAHA_NO_API_KEY = 'True';
            wahaEnv.WAHA_DASHBOARD_PASSWORD = '';
            wahaEnv.WAHA_DASHBOARD_NO_PASSWORD = 'True';
            wahaEnv.WHATSAPP_SWAGGER_PASSWORD = '';
            wahaEnv.WHATSAPP_SWAGGER_NO_PASSWORD = 'True';
        }

        // Dynamically compute the cwd to be the base container directory /app
        const spawnCwd = wahaPath.startsWith('/app') ? '/app' : path.dirname(path.dirname(wahaPath));

        wahaProcess = spawn('node', [wahaPath], {
            env: wahaEnv,
            cwd: spawnCwd,
            stdio: 'inherit' // Inherit stdout/stderr to print WAHA's logs in Render's console
        });

        wahaProcess.on('error', (err) => {
            console.error('❌ Failed to start WAHA child process:', err);
        });

        wahaProcess.on('exit', (code, signal) => {
            console.log(`⚠️ WAHA child process exited with code ${code} and signal ${signal}`);
        });

        return true;
    } else {
        console.log('🔧 Internal WAHA files not found in /app. Running bot in standalone mode (no local WAHA spawn).');
        return false;
    }
}

async function waitForWaha(url, maxRetries = 120) {
    console.log(`⏳ Waiting for internal WAHA service to start at ${url}...`);
    for (let i = 1; i <= maxRetries; i++) {
        try {
            const headers = {};
            if (process.env.WAHA_API_KEY) {
                headers['X-Api-Key'] = process.env.WAHA_API_KEY;
            }
            await axios.get(`${url}/api/sessions`, { headers, timeout: 1000 });
            console.log('✅ WAHA service is ready!');
            return true;
        } catch (err) {
            // Wait 1 second before retrying
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    console.warn('⚠️ WAHA service did not become ready in time. Proceeding in limited mode...');
    return false;
}

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
    wahaApiUrl: process.env.WAHA_API_URL || 'http://localhost:3010',
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

// Link WhatsApp via Pairing Code for mobile-friendly flow
app.get('/link-whatsapp', async (req, res) => {
    try {
        let phone = req.query.phone;
        const session = req.query.session || config.wahaSessionName || 'default';

        if (!phone) {
            return res.send(`
                <html>
                <head>
                    <meta charset="utf-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <title>Vincular WhatsApp - Bot</title>
                    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
                </head>
                <body class="bg-light d-flex align-items-center justify-content-center" style="min-height: 100vh;">
                    <div class="card shadow border-0 p-4 m-3" style="max-width: 500px; width: 100%;">
                        <h2 class="text-center text-success mb-4">Vincular WhatsApp</h2>
                        <form method="GET" action="/link-whatsapp">
                            <div class="mb-3">
                                <label class="form-label fw-bold">Número de Teléfono</label>
                                <input type="text" class="form-control form-control-lg" name="phone" placeholder="ej. 34611223344" required>
                                <div class="form-text">Ingresa tu número de teléfono con código de país completo, sin símbolos (+ o -).</div>
                            </div>
                            <div class="mb-3">
                                <label class="form-label fw-bold">Nombre de la Sesión (Opcional)</label>
                                <input type="text" class="form-control" name="session" value="${session}">
                            </div>
                            <button type="submit" class="btn btn-success btn-lg w-100">Generar Código de Vinculación</button>
                        </form>
                    </div>
                </body>
                </html>
            `);
        }

        // Clean phone number
        phone = phone.replace(/[+\-\s()]/g, '');

        if (!bot || !bot.wahaService) {
            return res.status(503).send('<h1>Error: El bot o el servicio WAHA aún no están listos</h1>');
        }

        let result;
        if (config.simulationMode) {
            console.log(`[SIMULATION] Mocking request-code for ${phone}`);
            result = { code: 'SIMULATED-CODE' };
        } else {
            // First ensure the session is running
            try {
                await bot.wahaService.startSession(session);
                // Give it 3 seconds to spin up if it was stopped
                await new Promise(resolve => setTimeout(resolve, 3000));
            } catch (err) {
                console.log('Session start attempt info:', err.message);
            }
            result = await bot.wahaService.requestCode(session, phone);
        }

        const pairingCode = result.code || result.pairingCode || result.result?.code || JSON.stringify(result);

        res.send(`
            <html>
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <title>Código de Vinculación - Bot</title>
                <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
            </head>
            <body class="bg-light d-flex align-items-center justify-content-center" style="min-height: 100vh;">
                <div class="card shadow border-0 p-4 m-3" style="max-width: 500px; width: 100%;">
                    <h2 class="text-center text-success mb-3">Tu Código de Vinculación</h2>
                    <p class="text-center text-muted mb-4">Ingresa este código en tu aplicación de WhatsApp móvil para conectar el bot.</p>

                    <div class="text-center bg-dark text-warning p-4 rounded mb-4">
                        <span class="display-4 fw-bold font-monospace text-wrap" style="letter-spacing: 2px;">${pairingCode}</span>
                    </div>

                    <h4 class="mb-3">Pasos a seguir en tu celular:</h4>
                    <ol class="list-group list-group-numbered mb-4 border-0">
                        <li class="list-group-item border-0 bg-transparent ps-0">Abre la app de <strong>WhatsApp</strong> en tu teléfono.</li>
                        <li class="list-group-item border-0 bg-transparent ps-0">Ve a <strong>Ajustes / Configuración</strong> (tres puntos en Android o pestaña de Configuración en iPhone).</li>
                        <li class="list-group-item border-0 bg-transparent ps-0">Selecciona <strong>Dispositivos vinculados</strong>.</li>
                        <li class="list-group-item border-0 bg-transparent ps-0">Presiona <strong>Vincular un dispositivo</strong>.</li>
                        <li class="list-group-item border-0 bg-transparent ps-0">Selecciona la opción <strong>Vincular con el número de teléfono</strong> (abajo en la pantalla).</li>
                        <li class="list-group-item border-0 bg-transparent ps-0">Introduce el código de arriba: <strong>${pairingCode}</strong>.</li>
                    </ol>

                    <div class="alert alert-info text-center py-2 mb-0">
                        Una vez ingresado, el bot se conectará automáticamente. ¡Puedes cerrar esta pestaña!
                    </div>
                </div>
            </body>
            </html>
        `);

        // Save requested number as backup primary session & phone
        const settings = settingsService.getSettings();
        const updatedSettings = {
            ...settings,
            primarySessionName: session,
            primaryPhoneNumber: phone
        };
        settingsService.saveSettings(updatedSettings);

    } catch (error) {
        res.status(500).send(`
            <html>
            <head><meta charset="utf-8"><title>Error</title></head>
            <body class="p-4">
                <h1 class="text-danger">Error al generar código</h1>
                <p>${error.message}</p>
                <a href="/link-whatsapp" class="btn btn-secondary">Volver a intentar</a>
            </body>
            </html>
        `);
    }
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

app.post('/api/whatsapp/request-code', express.json(), async (req, res) => {
    try {
        const { sessionName, phoneNumber } = req.body;
        if (!sessionName || !phoneNumber) {
            return res.status(400).json({ error: 'sessionName and phoneNumber are required' });
        }
        if (!bot || !bot.wahaService) {
            return res.status(503).json({ error: 'Bot or WAHA service not ready' });
        }

        let result;
        if (config.simulationMode) {
            console.log(`[SIMULATION] Mocking request-code for ${phoneNumber}`);
            result = { success: true, status: 'PENDING_CONFIRMATION', phoneNumber };
        } else {
            result = await bot.wahaService.requestCode(sessionName, phoneNumber);
        }

        // Save requested number as backup primary session & phone
        const settings = settingsService.getSettings();
        const updatedSettings = {
            ...settings,
            primarySessionName: sessionName,
            primaryPhoneNumber: phoneNumber
        };
        settingsService.saveSettings(updatedSettings);

        res.json({ success: true, result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/whatsapp/authorize-code', express.json(), async (req, res) => {
    try {
        const { sessionName, code } = req.body;
        if (!sessionName || !code) {
            return res.status(400).json({ error: 'sessionName and code are required' });
        }
        if (!bot || !bot.wahaService) {
            return res.status(503).json({ error: 'Bot or WAHA service not ready' });
        }

        let result;
        let phoneNumber = "";

        if (config.simulationMode) {
            console.log(`[SIMULATION] Mocking authorize-code: ${code}`);
            result = { success: true, status: 'CONNECTED' };
            phoneNumber = "123456789";
        } else {
            result = await bot.wahaService.authorizeCode(sessionName, code);
            try {
                // Wait 2 seconds for session to fully transition to connected
                await new Promise(resolve => setTimeout(resolve, 2000));
                const me = await bot.wahaService.getMe(sessionName);
                if (me && me.id) {
                    phoneNumber = me.id.split('@')[0];
                }
            } catch (meError) {
                console.error('Could not fetch connected number details immediately:', meError.message);
            }
        }

        // Save to settings
        const settings = settingsService.getSettings();
        const updatedSettings = {
            ...settings,
            primarySessionName: sessionName,
            primaryPhoneNumber: phoneNumber || settings.primaryPhoneNumber || ""
        };
        settingsService.saveSettings(updatedSettings);

        res.json({ success: true, result, phoneNumber });
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

        // Start internal WAHA if present
        const hasWaha = startWaha();
        if (hasWaha) {
            await waitForWaha('http://localhost:3012');
            if (config.wahaApiUrl === 'http://localhost:3010') {
                config.wahaApiUrl = 'http://localhost:3012';
                console.log(`🔄 Local WAHA detected. Pointing bot direct connection to ${config.wahaApiUrl}`);
            }
        }

        // Create bot instance first (so it is defined and won't throw TypeError for incoming requests)
        console.log('🤖 Creating WA Bot instance...');
        bot = new WABot(config);

        // Start Express server on fixed port FIRST
        app.listen(PORT, '0.0.0.0', async () => {
            console.log(`🌐 Express server running on port ${PORT}`);
            console.log(`📊 Health check: http://localhost:${PORT}/health`);
            console.log(`🤖 Bot status: http://localhost:${PORT}/bot/status`);
            console.log(`🔗 Webhook URL: http://192.168.18.182:${PORT}/webhook`);

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

            // Start message polling (DISABLED - WAHA requires chatId for each request)
            console.log('📡 Bot ready to receive messages via webhook');
            console.log('🔗 Webhook URL: http://localhost:' + PORT + '/webhook');
            console.log('💡 Configure WAHA to send webhooks to this URL for real-time message processing');
            console.log('🧪 Use test endpoint: http://localhost:' + PORT + '/bot/test-message for testing');

            // Cleanup old conversations every hour
            setInterval(() => {
                bot.cleanup();
                console.log('🧹 Cleaned up old conversation history');
            }, 60 * 60 * 1000);

            console.log('✅ Bot started successfully!');
            console.log(`📝 Command key: "${config.botCommandKey}"`);
            console.log(`🤖 Bot name: "${config.botName}"`);
            console.log('💬 The bot will respond to messages starting with the command key in both private and group chats.');

            // Print test access links block
            const baseHost = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
            console.log('\n========================================');
            console.log('📋 ENLACES DE ACCESO PARA PRUEBAS:');
            console.log(`🖥️  Dashboard WAHA: ${baseHost}/dashboard`);
            console.log(`📘 Swagger/API Docs: ${baseHost}/swagger`);
            console.log(`❤️  Health check: ${baseHost}/health`);
            console.log(`🤖 Bot status: ${baseHost}/bot/status`);
            console.log('========================================\n');
        }).on('error', (err) => {
            console.error('❌ Failed to start server:', err);
            if (err.code === 'EADDRINUSE') {
                console.error(`❌ Port ${PORT} is already in use. Please stop the other process or change the PORT in .env`);
            }
            process.exit(1);
        });

    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

// Start the application
startServer();
