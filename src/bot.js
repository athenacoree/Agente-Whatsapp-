const WAHAService = require('./wahaService');
const GroqService = require('./groqService');
const SpamDetector = require('./spamDetector');
const DatabaseService = require('./databaseService');
const DatabaseServiceSQLite = require('./databaseServiceSQLite');
const DataMenuService = require('./dataMenuService');
const DocumentService = require('./documentService');
const DocumentMenuService = require('./documentMenuService');
const StatusService = require('./statusService');
const StatusAIService = require('./statusAIService');
const AIChatService = require('./aiChatService');
const grokService = require('./grokService');

class WABot {
    constructor(config) {
        this.wahaService = new WAHAService(config.wahaApiUrl, config.wahaSessionName, config.wahaApiKey);
        this.groqService = new GroqService(config.groqApiKey);
        this.grokService = grokService;
        this.commandKey = config.botCommandKey;
        this.botName = config.botName;
        this.simulationMode = config.simulationMode || false;
        this.conversationHistory = new Map(); // Store conversation history per chat
        this.isProcessing = new Set(); // Track ongoing processing to avoid duplicates
        this.monitoredChats = config.monitoredChats || []; // List of chat IDs to monitor
        this.spamDetector = new SpamDetector(config.spamDetection); // Initialize spam detection with config

        // Initialize database services (PostgreSQL with SQLite fallback)
        this.databaseService = new DatabaseService(config);
        this.sqliteFallbackService = new DatabaseServiceSQLite(config);
        this.dataMenuService = new DataMenuService(this.databaseService);

        // Initialize document services
        this.documentService = new DocumentService(this.databaseService);
        this.documentMenuService = new DocumentMenuService(this.documentService);

        // Initialize status services
        this.statusService = new StatusService(this.databaseService);
        this.statusAIService = new StatusAIService(config.groqApiKey);

        // Initialize AI Chat Service (replaces traditional menu system)
        this.aiChatService = new AIChatService(
            config.groqApiKey,
            this.databaseService,
            this.documentService,
            this.statusService
        );
    }

    async initialize() {
        try {
            // Initialize database first - try PostgreSQL, fallback to SQLite
            console.log('🗄️ Initializing database...');
            let dbInitialized = await this.databaseService.initialize();

            if (!dbInitialized) {
                console.log('⚠️ PostgreSQL connection failed, trying SQLite fallback...');
                dbInitialized = await this.sqliteFallbackService.initialize();

                if (dbInitialized) {
                    console.log('✅ SQLite fallback database initialized successfully');
                    // Use SQLite service for the data menu
                    this.dataMenuService = new DataMenuService(this.sqliteFallbackService);
                    this.activeDatabaseService = this.sqliteFallbackService;
                } else {
                    console.error('❌ Both PostgreSQL and SQLite initialization failed');
                    this.activeDatabaseService = null;
                    // Create dummy menu services that return error messages
                    this.dataMenuService = {
                        userMenuStates: new Map(),
                        handleDataCommand: async () => '❌ Database not available. Please try again later.'
                    };
                    this.documentService = {
                        initialized: false
                    };
                    this.documentMenuService = {
                        userMenuStates: new Map(),
                        handleDocumentCommand: async () => '❌ Document service not available. Please try again later.'
                    };
                    this.statusService = {
                        initialized: false
                    };
                    this.statusAIService = {
                        initialized: false
                    };
                }
            } else {
                console.log('✅ PostgreSQL database initialized successfully');
                this.activeDatabaseService = this.databaseService;
            }

            // Initialize document service
            console.log('📋 Initializing document service...');
            let docInitialized = await this.documentService.initialize();

            if (!docInitialized) {
                console.error('⚠️ Document service initialization failed');
            } else {
                console.log('✅ Document service initialized successfully');
            }

            // Initialize status services
            console.log('📋 Initializing status service...');
            let statusInitialized = await this.statusService.initialize();

            if (!statusInitialized) {
                console.error('⚠️ Status service initialization failed');
            } else {
                console.log('✅ Status service initialized successfully');
            }

            // Initialize status AI service
            console.log('🤖 Initializing status AI service...');
            let statusAIInitialized = await this.statusAIService.initialize();

            if (!statusAIInitialized) {
                console.error('⚠️ Status AI service initialization failed');
            } else {
                console.log('✅ Status AI service initialized successfully');
            }

            if (this.simulationMode) {
                console.log('🔧 Simulation mode: Skipping WAHA connection check');
                return true;
            }

            console.log('Checking WAHA connection...');
            const status = await this.wahaService.checkConnection();
            console.log('WAHA connection status:', status);
            return true;
        } catch (error) {
            console.error('Failed to initialize WAHA service:', error);
            return false;
        }
    }

    parseMessage(message) {
        // Extract message content and metadata
        return {
            id: message.id || '',
            content: message.body || message.text || '',
            chatId: message.chatId || message.from,
            from: message.from || message.author,
            timestamp: message.timestamp || Date.now(),
            isGroup: message.chatId ? message.chatId.includes('@g.us') : false,
            senderName: message.notifyName || message.pushname || 'Unknown'
        };
    }

    isBotCommand(messageContent) {
        const content = messageContent.toLowerCase().trim();

        // Traditional commands
        const traditionalCommands = content.startsWith(this.commandKey.toLowerCase()) ||
               content === '.data' ||
               content === '.1' ||
               content === '.2' ||
               content === '.3' ||
               content === '.4' ||
               content === '.5' ||
               content === '.kekuranganpt' ||
               content.startsWith('.kekuranganpt') ||
               content === '.updatekekuranganpt' ||
               content.startsWith('.updatekekuranganpt') ||
               content === '.laporan' ||
               content.startsWith('.laporan ') ||
               content === '.tambahstatus' ||
               content.startsWith('.tambahstatus ') ||
               content === '.help';

        if (traditionalCommands) {
            return true;
        }

        // Natural language AI chat triggers - Indonesian
        const indonesianTriggers = [
            'cari', 'search', 'lihat', 'show', 'tampilkan', 'display',
            'cek', 'check', 'ada', 'berapa', 'how many', 'berapa banyak', 'apa', 'what',
            'statistik', 'statistics', 'data', 'pengguna', 'user',
            'kekurangan', 'document', 'dokumen', 'pt', 'perusahaan', 'company',
            'laporan', 'report', 'status', 'kerja', 'work',
            'tambah', 'tambahkan', 'update', 'insert', 'add',
            'berikut', 'ikut', 'ini', 'dibawah ini', 'missing', 'hilang',
            'tag', 'tags', 'pesan', 'message', 'semua', 'all',
            'buat', 'create', 'generate', 'bantuan', 'help'
        ];

        // Natural language AI chat triggers - English
        const englishTriggers = [
            'find', 'get', 'list', 'show me', 'tell me', 'what',
            'search for', 'look up', 'how many', 'statistics',
            'users', 'messages', 'reports', 'status', 'add', 'create'
        ];

        // Check if message contains any trigger words
        return indonesianTriggers.some(trigger => content.includes(trigger)) ||
               englishTriggers.some(trigger => content.includes(trigger));
    }

    extractUserMessage(messageContent) {
        const content = messageContent.toLowerCase().trim();

        // Handle traditional commands
        if (content === '.data' || content === '.1' || content === '.2' ||
            content === '.3' || content === '.4' || content === '.5' ||
            content === '.help' || content === '.kekuranganpt' ||
            content.startsWith('.kekuranganpt ') || content === '.updatekekuranganpt' ||
            content.startsWith('.updatekekuranganpt ') || content === '.laporan' ||
            content.startsWith('.laporan ') || content === '.tambahstatus' ||
            content.startsWith('.tambahstatus ')) {
            return content;
        }

        // Handle AI command with prefix (e.g., "!ai halo")
        if (content.startsWith(this.commandKey.toLowerCase())) {
            return messageContent.trim()
                .substring(this.commandKey.length)
                .trim();
        }

        // For natural language, return the original message
        return messageContent.trim();
    }

    isDataCommand(userMessage) {
        return userMessage === '.data' ||
               userMessage.startsWith('.1') ||
               userMessage.startsWith('.2') ||
               userMessage.startsWith('.3') ||
               userMessage.startsWith('.4') ||
               userMessage === '.5' ||
               userMessage === '.help';
    }

    getConversationKey(chatId, sender) {
        // For group chats, track per user
        if (chatId.includes('@g.us')) {
            return `${chatId}_${sender}`;
        }
        // For private chats, use chat ID
        return chatId;
    }

    isDocumentCommand(userMessage) {
        return userMessage === '.kekuranganpt' ||
               userMessage.startsWith('.kekuranganpt ') ||
               userMessage === '.updatekekuranganpt' ||
               userMessage.startsWith('.updatekekuranganpt ');
    }

    isStatusCommand(userMessage) {
        return userMessage === '.laporan' ||
               userMessage.startsWith('.laporan ') ||
               userMessage === '.tambahstatus' ||
               userMessage.startsWith('.tambahstatus ');
    }

    getConversationHistory(key) {
        if (!this.conversationHistory.has(key)) {
            this.conversationHistory.set(key, []);
        }
        return this.conversationHistory.get(key);
    }

    addToHistory(key, role, content) {
        const history = this.getConversationHistory(key);
        history.push({ role, content, timestamp: Date.now() });

        // Keep only last 20 messages to manage memory
        if (history.length > 20) {
            history.splice(0, history.length - 20);
        }
    }

    async handleIncomingMessage(message) {
        try {
            const parsedMessage = this.parseMessage(message);
            const processingKey = `${parsedMessage.chatId}_${parsedMessage.id}`;

            // Skip if already processing this message
            if (this.isProcessing.has(processingKey)) {
                return;
            }

            // Skip bot's own messages
            if (parsedMessage.from === 'bot' || parsedMessage.senderName === this.botName) {
                return;
            }

            // Check if this is a bot command OR user is in an active menu state
            const userId = this.getConversationKey(parsedMessage.chatId, parsedMessage.from);

            // Track active user in last 15 min globally
            global.recentActiveUsers = global.recentActiveUsers || new Set();
            global.recentActiveUsers.add(userId);
            setTimeout(() => {
                if (global.recentActiveUsers) {
                    global.recentActiveUsers.delete(userId);
                }
            }, 15 * 60 * 1000); // Expirar en 15 minutos

            const isInDataMenuState = this.dataMenuService && this.dataMenuService.userMenuStates &&
                                     this.dataMenuService.userMenuStates.has(userId);
            const isInDocumentMenuState = this.documentMenuService && this.documentMenuService.userMenuStates &&
                                         this.documentMenuService.userMenuStates.has(userId);
            const isInMenuState = isInDataMenuState || isInDocumentMenuState;

            if (!this.isBotCommand(parsedMessage.content) && !isInMenuState) {
                return;
            }

            // Spam detection disabled - allow free messaging

            this.isProcessing.add(processingKey);

            // Track concurrent active processing count globally
            global.activeChatsCount = (global.activeChatsCount || 0) + 1;

            try {
                console.log(`Processing command from ${parsedMessage.senderName} in ${parsedMessage.isGroup ? 'group' : 'private'} chat (Concurrent: ${global.activeChatsCount})`);

                const userMessage = this.extractUserMessage(parsedMessage.content);

                // Handle data commands (.data, .1, .2, .3, .4, .5, .help)
                if (this.isDataCommand(userMessage)) {
                    await this.handleDirectDataCommand(parsedMessage, userMessage);
                    return;
                }

                // Handle direct document commands (.kekuranganpt, .updatekekuranganpt)
                if (this.isDocumentCommand(userMessage)) {
                    // Check if document service is available
                    if (!this.documentService || !this.documentService.initialized) {
                        const errorMessage = '❌ Layanan dokumen tidak tersedia. Silakan coba lagi nanti.\n\n💡 Pastikan database PostgreSQL berjalan atau coba perintah database (.data) lainnya.';

                        if (this.simulationMode) {
                            console.log(`🔧 [SIMULATION] Document service response: ${errorMessage}`);
                        } else {
                            await this.wahaService.sendMessage(parsedMessage.chatId, errorMessage);
                        }
                        return;
                    }

                    await this.handleDirectDocumentCommand(parsedMessage, userMessage);
                    return;
                }

                // Handle status commands (.laporan, .tambahstatus)
                if (this.isStatusCommand(userMessage)) {
                    // Check if status service is available
                    if (!this.statusService || !this.statusService.initialized) {
                        const errorMessage = '❌ Layanan status tidak tersedia. Silakan coba lagi nanti.\n\n💡 Pastikan database PostgreSQL berjalan atau coba perintah database (.data) lainnya.';

                        if (this.simulationMode) {
                            console.log(`🔧 [SIMULATION] Status service response: ${errorMessage}`);
                        } else {
                            await this.wahaService.sendMessage(parsedMessage.chatId, errorMessage);
                        }
                        return;
                    }

                    await this.handleStatusCommand(parsedMessage, userMessage);
                    return;
                }

                // Handle menu responses (when user is in active menu state)
                if (isInMenuState) {
                    if (isInDataMenuState && this.dataMenuService) {
                        await this.handleMenuResponse(parsedMessage, userId);
                        return;
                    }
                    if (isInDocumentMenuState && this.documentMenuService) {
                        await this.handleDocumentMenuResponse(parsedMessage, userId);
                        return;
                    }
                }

                if (!userMessage) {
                    const welcomeMessage = '🤖 *Halo! Saya adalah Asisten AI WhatsApp Bot*\n\nSaya siap membantu Anda dengan:\n• 📊 Data pengguna dan statistik\n• 📋 Manajemen dokumen dan kekurangan PT\n• 📈 Laporan status pekerjaan\n• 💬 Chat AI dengan memori percakapan\n\n💡 *Cara penggunaan:*\n• Ketik permintaan dalam bahasa Indonesia atau Inggris\n• Contoh: "cari data user john", "lihat statistik pesan", "cek kekurangan PT Maju Bersatu"\n• Tidak perlu lagi menggunakan menu! Chat langsung dengan saya\n\n🎯 *Apa yang bisa saya bantu hari ini?*';

                    if (this.simulationMode) {
                        console.log(`🔧 [SIMULATION] Welcome message to ${parsedMessage.senderName}: ${welcomeMessage}`);
                    } else {
                        await this.wahaService.sendMessage(parsedMessage.chatId, welcomeMessage);
                    }
                    return;
                }

                // Get conversation history
                const conversationKey = this.getConversationKey(parsedMessage.chatId, parsedMessage.from);
                const history = this.getConversationHistory(conversationKey);

                // Show typing indicator
                await this.sendTypingIndicator(parsedMessage.chatId);

                // Process with AI Chat Service (with MCP tools)
                const response = await this.aiChatService.processMessage(userMessage, history);

                if (response.success) {
                    let responseText = response.content;

                    // Add tool usage indicator if tools were used
                    if (response.usedTools) {
                        responseText += '\n\n🔧 *Processed with AI tools*';
                    }

                    // Send response (or simulate)
                    if (this.simulationMode) {
                        console.log(`🔧 [SIMULATION] Response to ${parsedMessage.senderName}: ${responseText}`);
                    } else {
                        await this.wahaService.sendMessage(parsedMessage.chatId, responseText);
                    }

                    // Update conversation history
                    this.addToHistory(conversationKey, 'user', userMessage);
                    this.addToHistory(conversationKey, 'assistant', responseText);

                    // Log message and response to database
                    await this.logMessageToDatabase(parsedMessage, responseText);

                    console.log(`AI chat response processed for ${parsedMessage.senderName} (tools used: ${response.usedTools})`);
                } else {
                    const errorMessage = `Maaf, saya mengalami kesalahan saat memproses permintaan Anda. Silakan coba lagi.\n\n💡 *Tips:*\n• Pastikan permintaan Anda jelas\n• Coba dengan kata kunci seperti: "cari", "lihat", "cek", "tambah"\n• Contoh: "cari data user", "lihat statistik", "cek kekurangan PT Nama"`;

                    if (this.simulationMode) {
                        console.log(`🔧 [SIMULATION] Error message to ${parsedMessage.senderName}: ${errorMessage}`);
                    } else {
                        await this.wahaService.sendMessage(parsedMessage.chatId, errorMessage);
                    }

                    // Log failed message to database
                    await this.logMessageToDatabase(parsedMessage, errorMessage);

                    console.error('AI Chat Service error:', response.error);
                }

                // Mark message as read (optional, ignore errors)
                if (parsedMessage.id && !this.simulationMode) {
                    try {
                        await this.wahaService.markAsRead(parsedMessage.chatId, parsedMessage.id);
                    } catch (readError) {
                        // Ignore markAsRead errors as it's not critical functionality
                        console.log('⚠️ Could not mark message as read (non-critical):', readError.message);
                    }
                }

            } finally {
                this.isProcessing.delete(processingKey);
                global.activeChatsCount = Math.max(0, (global.activeChatsCount || 1) - 1);
            }

        } catch (error) {
            console.error('Error handling message:', error);
            global.activeChatsCount = Math.max(0, (global.activeChatsCount || 1) - 1);
        }
    }

    async sendTypingIndicator(chatId) {
        // WAHA doesn't have a direct typing indicator API
        // This is a placeholder for future implementation
        // We could send a temporary message like "Typing..." if needed
    }

    async startPolling(intervalMs = 3000) {
        if (this.simulationMode) {
            console.log('🔧 Simulation mode: Message polling disabled');
            return;
        }

        console.log('🔄 Starting message polling for ALL incoming messages...');
        console.log('📱 Bot will respond to anyone sending messages with command key:', this.commandKey);

        let lastMessageTimestamp = Date.now();

        setInterval(async () => {
            try {
                // Try to get recent messages from all chats
                const messages = await this.wahaService.getMessages(20);

                if (Array.isArray(messages)) {
                    for (const message of messages) {
                        // Only process incoming messages (not from me) that are newer than last check
                        if (!message.fromMe &&
                            message.timestamp &&
                            message.timestamp * 1000 > lastMessageTimestamp &&
                            message.body) {

                            console.log(`📨 New message from ${message.from || message.chatId}: "${message.body}"`);
                            await this.handleIncomingMessage(message);
                        }
                    }
                }

                lastMessageTimestamp = Date.now();
            } catch (error) {
                console.error('Error in polling loop:', error.message);
            }
        }, intervalMs);
    }

    async cleanup() {
        // Clean up old conversation history
        const now = Date.now();
        const maxAge = 24 * 60 * 60 * 1000; // 24 hours

        for (const [key, history] of this.conversationHistory.entries()) {
            const filtered = history.filter(msg =>
                now - msg.timestamp < maxAge
            );

            if (filtered.length === 0) {
                this.conversationHistory.delete(key);
            } else {
                this.conversationHistory.set(key, filtered);
            }
        }

        // Clean up spam detection data
        this.spamDetector.cleanup();

        // Clean up data menu states
        this.dataMenuService.cleanup();
    }

    // Handle .data command
    async handleDataCommand(parsedMessage) {
        try {
            // Show typing indicator
            await this.sendTypingIndicator(parsedMessage.chatId);

            // Get response from data menu service
            const response = await this.dataMenuService.handleDataCommand(
                parsedMessage.chatId,
                parsedMessage.senderName,
                '.data'
            );

            
            // Send response
            if (this.simulationMode) {
                console.log(`🔧 [SIMULATION] Data menu response to ${parsedMessage.senderName}:`, response);
            } else {
                await this.wahaService.sendMessage(parsedMessage.chatId, response);
            }

            // Log the command
            if (this.activeDatabaseService && this.activeDatabaseService.initialized) {
                await this.activeDatabaseService.logCommand(
                    parsedMessage.chatId,
                    'data_menu',
                    {
                        senderName: parsedMessage.senderName,
                        timestamp: new Date().toISOString()
                    }
                );
            }

        } catch (error) {
            console.error('Error handling .data command:', error);
            const errorMessage = '❌ Terjadi kesalahan saat mengakses database. Silakan coba lagi nanti.';

            if (this.simulationMode) {
                console.log(`🔧 [SIMULATION] Error message to ${parsedMessage.senderName}: ${errorMessage}`);
            } else {
                await this.wahaService.sendMessage(parsedMessage.chatId, errorMessage);
            }
        }
    }

    // Handle direct data commands (.data, .1, .2, .3, .4, .5)
    async handleDirectDataCommand(parsedMessage, command) {
        try {
            console.log(`Processing direct data command "${command}" from ${parsedMessage.senderName}`);

            // Show typing indicator
            await this.sendTypingIndicator(parsedMessage.chatId);

            let response = '';

            // Parse command and parameters
            const parts = command.split(' ');
            const mainCommand = parts[0];
            const parameter = parts.slice(1).join(' ');

            switch (mainCommand) {
                case '.data':
                    response = `📊 *Menu Database - Pilih opsi:*

1. 🔍 Cari data pengguna - Kirim .1
2. 📋 Lihat semua pengguna - Kirim .2
3. 📈 Lihat statistik pesan - Kirim .3
4. 🏷️ Jelajahi berdasarkan tags - Kirim .4
5. ❌ Keluar menu - Kirim .5

💡 *Balas dengan .1, .2, .3, .4, atau .5*

📋 *Perintah Dokumen (Langsung):*
• \`.kekuranganpt [nama PT]\` - Cek kekurangan dokumen PT
• \`.updatekekuranganpt [nama PT]:[kekurangan]\` - Tambah kekurangan dokumen

💡 *Format Kekurangan:*
\`.updatekekuranganpt PT Nama:JenisPekerjaan:1. item1
2. item2
3. item3\`

**Contoh Jenis Pekerjaan:**
PPIU, Umroh Plus, Haji Plus, Visa, Tiket, dll.`;
                    break;

                case '.1':
                    response = await this.handleSearchUsers(parsedMessage, parameter);
                    break;

                case '.2':
                    response = await this.handleViewAllUsers(parsedMessage);
                    break;

                case '.3':
                    response = await this.handleViewStatistics(parsedMessage);
                    break;

                case '.4':
                    response = await this.handleBrowseTags(parsedMessage, parameter);
                    break;

                case '.5':
                    response = '👋 Menu data ditutup. Kirim `.data` lagi kapan saja untuk mengakses database.';
                    break;

                case '.help':
                    response = this.getHelpMessage();
                    break;

                default:
                    response = '❌ Perintah tidak valid. Kirim `.data` untuk melihat opsi yang tersedia atau `.help` untuk semua perintah.';
            }

            // Send response
            if (this.simulationMode) {
                console.log(`🔧 [SIMULATION] Direct command response to ${parsedMessage.senderName}:`);
                console.log(response);
            } else {
                await this.wahaService.sendMessage(parsedMessage.chatId, response);
            }

            // Log the command
            if (this.activeDatabaseService && this.activeDatabaseService.initialized) {
                await this.activeDatabaseService.logCommand(
                    parsedMessage.chatId,
                    'direct_command',
                    {
                        senderName: parsedMessage.senderName,
                        command: command,
                        timestamp: new Date().toISOString()
                    }
                );
            }

        } catch (error) {
            console.error('Error handling direct data command:', error);
            const errorMessage = '❌ Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.';

            if (this.simulationMode) {
                console.log(`🔧 [SIMULATION] Error message to ${parsedMessage.senderName}: ${errorMessage}`);
            } else {
                await this.wahaService.sendMessage(parsedMessage.chatId, errorMessage);
            }
        }
    }

    // Handle search users command (.1)
    async handleSearchUsers(parsedMessage, searchTerm = '') {
        if (!this.activeDatabaseService || !this.activeDatabaseService.initialized) {
            return '❌ Database tidak tersedia. Silakan coba lagi nanti.';
        }

        try {
            if (searchTerm) {
                // Search for specific user
                const results = await this.activeDatabaseService.searchUserData(searchTerm, 'all');

                if (results.length === 0) {
                    return `❌ No users found for "${searchTerm}".\n\n💡 Send \`.data\` to return to menu.`;
                }

                let response = `🔍 *Search Results for "${searchTerm}" (${results.length} found):*\n\n`;

                results.forEach((user, index) => {
                    const tags = user.tags && user.tags.length > 0 ? user.tags.join(', ') : 'No tags';
                    const data = user.data_json || {};
                    const displayName = this.getDisplayName(user);
                    response += `*${index + 1}. ${displayName}*\n`;

                    // Only show phone number if it's properly formatted and not a chat ID
                    if (user.phone_number && !user.phone_number.includes('@')) {
                        response += `📱 ${user.phone_number}\n`;
                    }

                    // Show department if available in data_json
                    if (data.department) {
                        response += `🏢 ${data.department}\n`;
                    }

                    response += `🏷️ ${tags}\n\n`;
                });

                response += `Send \`.data\` to return to main menu.`;
                return response;
            } else {
                // Show recent users
                const users = await this.activeDatabaseService.getAllUserData(10, 0);

                if (users.length === 0) {
                    return '📋 No users found in the database.\n\n💡 Send `.data` to return to menu.';
                }

                let response = `🔍 *Search Users - Recent Users:*\n\n`;

                users.forEach((user, index) => {
                    const displayName = this.getDisplayName(user);
                    response += `${index + 1}. ${displayName}\n`;
                });

                response += `\n💡 *To search for a specific user:*\n`;
                response += `Send \`.1 <name>\` (example: \`.1 John\`)\n\n`;
                response += `Send \`.data\` to return to main menu.`;

                return response;
            }
        } catch (error) {
            console.error('Error searching users:', error);
            return '❌ Kesalahan saat mencari pengguna. Silakan coba lagi.';
        }
    }

    // Handle view all users command (.2)
    async handleViewAllUsers(parsedMessage) {
        if (!this.activeDatabaseService || !this.activeDatabaseService.initialized) {
            return '❌ Database tidak tersedia. Silakan coba lagi nanti.';
        }

        try {
            const users = await this.activeDatabaseService.getAllUserData(20, 0);

            if (users.length === 0) {
                return '📋 No users found in the database.\n\n💡 Send `.data` to return to menu.';
            }

            let response = `📋 *All Users (${users.length} found):*\n\n`;

            users.forEach((user, index) => {
                const tags = user.tags && user.tags.length > 0 ? user.tags.join(', ') : 'No tags';
                const data = user.data_json || {};
                const displayName = this.getDisplayName(user);
                response += `*${index + 1}. ${displayName}*\n`;

                // Only show phone number if it's properly formatted and not a chat ID
                if (user.phone_number && !user.phone_number.includes('@')) {
                    response += `📱 ${user.phone_number}\n`;
                }

                // Show department if available in data_json
                if (data.department) {
                    response += `🏢 ${data.department}\n`;
                }

                response += `🏷️ ${tags}\n\n`;
            });

            response += `Send \`.data\` to return to main menu.`;

            return response;
        } catch (error) {
            console.error('Error viewing users:', error);
            return '❌ Kesalahan saat melihat pengguna. Silakan coba lagi.';
        }
    }

    // Handle view statistics command (.3)
    async handleViewStatistics(parsedMessage) {
        if (!this.activeDatabaseService || !this.activeDatabaseService.initialized) {
            return '❌ Database tidak tersedia. Silakan coba lagi nanti.';
        }

        try {
            const stats = await this.activeDatabaseService.getMessageStats();

            // Get user names for top chatters
            const topChattersWithNames = await Promise.all(
                stats.topChatters.map(async (user) => {
                    try {
                        const userData = await this.activeDatabaseService.getUserData(user.chat_id);
                        const mockUser = {
                            chatId: user.chat_id,
                            user_name: userData?.user_name
                        };
                        const displayName = this.getDisplayName(mockUser);
                        return {
                            ...user,
                            displayName: displayName
                        };
                    } catch (error) {
                        // Fallback to chat_id if user data not found
                        const mockUser = {
                            chatId: user.chat_id,
                            user_name: null
                        };
                        const displayName = this.getDisplayName(mockUser);
                        return {
                            ...user,
                            displayName: displayName
                        };
                    }
                })
            );

            const response = `📈 *Message Statistics:*

📊 Total Messages: ${stats.totalMessages}
📅 Messages Today: ${stats.todayMessages}
👥 Unique Users: ${stats.uniqueUsers}

🔥 *Top Chatters Today:*
${topChattersWithNames.map((user, index) =>
    `${index + 1}. ${user.displayName}: ${user.message_count} messages`
).join('\n') || 'No messages today'}

Send \`.data\` to return to main menu.`;

            return response;
        } catch (error) {
            console.error('Error viewing statistics:', error);
            return '❌ Kesalahan saat melihat statistik. Silakan coba lagi.';
        }
    }

    // Handle browse tags command (.4)
    async handleBrowseTags(parsedMessage, tagName = '') {
        if (!this.activeDatabaseService || !this.activeDatabaseService.initialized) {
            return '❌ Database tidak tersedia. Silakan coba lagi nanti.';
        }

        try {
            if (tagName) {
                // Search for specific tag
                const results = await this.activeDatabaseService.searchUserData(tagName, 'tags');

                if (results.length === 0) {
                    return `❌ No users found with tag "${tagName}".\n\n💡 Send \`.data\` to return to menu.`;
                }

                let response = `🏷️ *Users with tag "${tagName}" (${results.length} found):*\n\n`;

                results.forEach((user, index) => {
                    const tags = user.tags && user.tags.length > 0 ? user.tags.join(', ') : 'No tags';
                    const data = user.data_json || {};
                    const displayName = this.getDisplayName(user);
                    response += `*${index + 1}. ${displayName}*\n`;

                    // Only show phone number if it's properly formatted and not a chat ID
                    if (user.phone_number && !user.phone_number.includes('@')) {
                        response += `📱 ${user.phone_number}\n`;
                    }

                    // Show department if available in data_json
                    if (data.department) {
                        response += `🏢 ${data.department}\n`;
                    }

                    response += `🏷️ ${tags}\n\n`;
                });

                response += `Send \`.data\` to return to main menu.`;
                return response;
            } else {
                // Show all tags
                const users = await this.activeDatabaseService.getAllUserData(100, 0);
                const tagCounts = {};

                // Count tags from all users
                users.forEach(user => {
                    if (user.tags && Array.isArray(user.tags)) {
                        user.tags.forEach(tag => {
                            if (tag && tag.trim()) {
                                tagCounts[tag] = (tagCounts[tag] || 0) + 1;
                            }
                        });
                    }
                });

                // Convert to array and sort by count
                const sortedTags = Object.entries(tagCounts)
                    .sort(([, a], [, b]) => b - a)
                    .slice(0, 20); // Top 20 tags

                if (sortedTags.length === 0) {
                    return '🏷️ No tags found in the database.\n\n💡 Send `.data` to return to menu.';
                }

                let response = `🏷️ *Popular Tags:*\n\n`;

                sortedTags.forEach(([tag, count], index) => {
                    response += `${index + 1}. ${tag} (${count} users)\n`;
                });

                response += `\n💡 *To search by tag:*\n`;
                response += `Send \`.4 <tag>\` (example: \`.4 important\`)\n\n`;
                response += `Send \`.data\` to return to main menu.`;

                return response;
            }
        } catch (error) {
            console.error('Error browsing tags:', error);
            return '❌ Kesalahan saat menjelajahi tags. Silakan coba lagi.';
        }
    }

    // Handle menu responses (number selections, text inputs, etc.)
    async handleMenuResponse(parsedMessage, userId) {
        try {
            console.log(`Processing menu response from ${parsedMessage.senderName}: "${parsedMessage.content}"`);

            // Show typing indicator
            await this.sendTypingIndicator(parsedMessage.chatId);

            // Get response from data menu service
            const response = await this.dataMenuService.handleDataCommand(
                parsedMessage.chatId,
                parsedMessage.senderName,
                parsedMessage.content
            );

            // Send response
            if (this.simulationMode) {
                console.log(`🔧 [SIMULATION] Menu response to ${parsedMessage.senderName}:`);
                console.log(response);
            } else {
                await this.wahaService.sendMessage(parsedMessage.chatId, response);
            }

            // Log the menu interaction
            if (this.activeDatabaseService && this.activeDatabaseService.initialized) {
                await this.activeDatabaseService.logCommand(
                    parsedMessage.chatId,
                    'menu_response',
                    {
                        senderName: parsedMessage.senderName,
                        userInput: parsedMessage.content,
                        timestamp: new Date().toISOString()
                    }
                );
            }

        } catch (error) {
            console.error('Error handling menu response:', error);
            const errorMessage = '❌ Terjadi kesalahan saat memproses pilihan Anda. Silakan coba lagi.';

            if (this.simulationMode) {
                console.log(`🔧 [SIMULATION] Error message to ${parsedMessage.senderName}: ${errorMessage}`);
            } else {
                await this.wahaService.sendMessage(parsedMessage.chatId, errorMessage);
            }
        }
    }

    // Log message to database
    async logMessageToDatabase(parsedMessage, responseContent = null) {
        // Log to PostgreSQL/SQLite
        if (this.activeDatabaseService && this.activeDatabaseService.initialized) {
            try {
                await this.activeDatabaseService.logMessage({
                    messageId: parsedMessage.id,
                    chatId: parsedMessage.chatId,
                    senderName: parsedMessage.senderName,
                    messageContent: parsedMessage.content,
                    messageType: 'text',
                    responseContent: responseContent
                });

                // Update or create user data
                await this.activeDatabaseService.upsertUserData(parsedMessage.chatId, {
                    userName: parsedMessage.senderName,
                    phoneNumber: parsedMessage.chatId.replace('@c.us', '').replace('@g.us', ''),
                    data: {
                        lastMessage: parsedMessage.content,
                        lastMessageTime: new Date().toISOString(),
                        totalMessages: await this.getUserMessageCount(parsedMessage.chatId)
                    },
                    tags: this.extractTagsFromMessage(parsedMessage.content)
                });
            } catch (error) {
                console.error('Error logging message to local SQL database:', error);
            }
        }

        // Save dynamically to MongoDB Atlas if connections are active
        const mongoService = require('./mongoService');
        if (mongoService && mongoService.getConfigs().length > 0) {
            try {
                const userDataObj = {
                    chatId: parsedMessage.chatId,
                    userName: parsedMessage.senderName,
                    phoneNumber: parsedMessage.chatId.replace('@c.us', '').replace('@g.us', ''),
                    data: {
                        lastMessage: parsedMessage.content,
                        lastMessageTime: new Date().toISOString(),
                    },
                    tags: this.extractTagsFromMessage(parsedMessage.content)
                };

                const chatLogObj = {
                    messageId: parsedMessage.id,
                    chatId: parsedMessage.chatId,
                    senderName: parsedMessage.senderName,
                    messageContent: parsedMessage.content,
                    messageType: 'text',
                    responseContent: responseContent
                };

                // Non-blocking fire-and-forget save to MongoDB Atlas
                mongoService.saveUserData(userDataObj).catch(err => console.error('Atlas User Save fail:', err));
                mongoService.saveChatLog(chatLogObj).catch(err => console.error('Atlas ChatLog Save fail:', err));
            } catch (mongoError) {
                console.error('Error executing MongoDB Atlas logging:', mongoError);
            }
        }
    }

    // Helper method to get user message count
    async getUserMessageCount(chatId) {
        if (!this.activeDatabaseService || !this.activeDatabaseService.initialized) return 0;

        try {
            // For PostgreSQL
            if (this.activeDatabaseService.pool) {
                const result = await this.activeDatabaseService.pool.query(
                    'SELECT COUNT(*) as count FROM message_logs WHERE chat_id = $1',
                    [chatId]
                );
                return parseInt(result.rows[0].count) || 0;
            }
            // For SQLite
            else if (this.activeDatabaseService.db) {
                const result = await new Promise((resolve, reject) => {
                    this.activeDatabaseService.db.get(
                        'SELECT COUNT(*) as count FROM message_logs WHERE chat_id = ?',
                        [chatId],
                        (err, row) => {
                            if (err) reject(err);
                            else resolve(row);
                        }
                    );
                });
                return parseInt(result.count) || 0;
            }
            return 0;
        } catch (error) {
            console.error('Error getting message count:', error);
            return 0;
        }
    }

    // Helper method to extract tags from messages
    extractTagsFromMessage(message) {
        // Simple tag extraction - look for hashtags
        const hashtags = message.match(/#\w+/g) || [];
        return hashtags.map(tag => tag.substring(1)); // Remove # symbol
    }

    // Helper method to get clean display name for user
    getDisplayName(user) {
        if (user.user_name) {
            return user.user_name;
        }

        // Extract phone number from chat ID if available
        const phoneNumber = user.chatId.replace('@c.us', '').replace('@g.us', '');

        // If it's a numeric phone number, format it nicely
        if (/^\d+$/.test(phoneNumber)) {
            return phoneNumber;
        }

        // Fallback to chat ID
        return user.chatId;
    }

    // Method to report a user for spam (can be triggered by admins)
    reportUser(userId, reporterId) {
        this.spamDetector.reportUser(userId, reporterId);
        console.log(`📢 User ${userId} reported for spam by ${reporterId}`);
    }

    // Handle direct document commands (.kekuranganpt, .updatekekuranganpt)
    async handleDirectDocumentCommand(parsedMessage, command) {
        try {
            if (!this.documentService || !this.documentService.initialized) {
                return '❌ Layanan dokumen tidak tersedia. Silakan coba lagi nanti.';
            }

            console.log(`Processing direct document command "${command}" from ${parsedMessage.senderName}`);

            // Show typing indicator
            await this.sendTypingIndicator(parsedMessage.chatId);

            let response = '';

            // Parse command and parameters
            const parts = command.split(' ');
            const mainCommand = parts[0];
            const parameter = parts.slice(1).join(' ');

            switch (mainCommand) {
                case '.kekuranganpt':
                    if (!parameter || parameter.trim().length === 0) {
                        response = `📋 *Cek Kekurangan Dokumen PT*

💡 *Format:*
\`.kekuranganpt [nama PT]\`

**Contoh:**
\`.kekuranganpt PT Maju Bersatu\`
\`.kekuranganpt Travel Umroh Bersama\`

📋 *Perintah Lainnya:*
• \`.updatekekuranganpt [nama PT]:[jenis pekerjaan]:[kekurangan]\` - Tambah kekurangan dokumen

**Contoh Jenis Pekerjaan:** PPIU, Umroh Plus, Haji Plus, Visa, dll.`;
                    } else {
                        response = await this.handleCheckKekuranganPT(parsedMessage, parameter);
                    }
                    break;

                case '.updatekekuranganpt':
                    if (!parameter || parameter.trim().length === 0) {
                        response = `📝 *Update Kekurangan Dokumen PT*

💡 *Format:*
\`.updatekekuranganpt [nama PT]:[kekurangan yang ditambahkan]\`

**Contoh (Dengan Jenis Pekerjaan):**
\`.updatekekuranganpt PT Maju Bersatu:PPIU:1. ktp
2. sk ppiu\`

**Contoh (Multiple Items):**
\`.updatekekuranganpt Travel Umroh:Umroh Plus:1. paspor
2. visa
3. tiket pesawat\`

**Contoh (Single Item):**
\`.updatekekuranganpt PT Maju:Paspor masih berlaku 3 bulan lagi\`

📋 *Perintah Lainnya:*
• \`.kekuranganpt [nama PT]\` - Cek kekurangan dokumen PT`;
                    } else {
                        response = await this.handleUpdateKekuranganPT(parsedMessage, parameter);
                    }
                    break;

                default:
                    response = '❌ Perintah dokumen tidak valid. Gunakan `.kekuranganpt [nama PT]` atau `.updatekekuranganpt [nama PT]:[kekurangan]`';
            }

            // Send response
            if (this.simulationMode) {
                console.log(`🔧 [SIMULATION] Direct document command response to ${parsedMessage.senderName}:`);
                console.log(response);
            } else {
                await this.wahaService.sendMessage(parsedMessage.chatId, response);
            }

            // Log the command
            if (this.activeDatabaseService && this.activeDatabaseService.initialized) {
                await this.activeDatabaseService.logCommand(
                    parsedMessage.chatId,
                    'direct_document_command',
                    {
                        senderName: parsedMessage.senderName,
                        command: command,
                        timestamp: new Date().toISOString()
                    }
                );
            }

        } catch (error) {
            console.error('Error handling direct document command:', error);
            const errorMessage = '❌ Terjadi kesalahan saat memproses perintah dokumen Anda. Silakan coba lagi nanti.';

            if (this.simulationMode) {
                console.log(`🔧 [SIMULATION] Error message to ${parsedMessage.senderName}: ${errorMessage}`);
            } else {
                await this.wahaService.sendMessage(parsedMessage.chatId, errorMessage);
            }
        }
    }

    // Handle check kekurangan PT
    async handleCheckKekuranganPT(parsedMessage, ptName) {
        if (!this.documentService || !this.documentService.initialized) {
            return '❌ Layanan dokumen tidak tersedia. Silakan coba lagi nanti.';
        }

        try {
            const results = await this.documentService.searchDocuments(ptName.trim());

            if (results.length === 0) {
                return `❌ Tidak ada dokumen yang ditemukan untuk PT "${ptName}".\n\n💡 Pastikan nama PT benar atau tambahkan dokumen menggunakan \`.updatekekuranganpt ${ptName}:[kekurangan]\``;
            }

            // Filter only kekurangan documents
            const kekuranganDocs = results.filter(doc =>
                doc.document_type === 'Kekurangan Dokumen'
            );

            let response = '';

            if (kekuranganDocs.length > 0) {
                response = `📋 *Kekurangan Dokumen untuk "${ptName}" (${kekuranganDocs.length} ditemukan):*\n\n`;

                kekuranganDocs.forEach((doc, docIndex) => {
                    response += `🏢 Nama PT: ${doc.pt_name}\n`;
                    response += `📋 Tipe: ${doc.document_type}\n`;

                    // Parse description untuk extract jenis pekerjaan dan kekurangan
                    if (doc.description) {
                        // Check if description contains jenis pekerjaan
                        const jobTypeMatch = doc.description.match(/Jenis Pekerjaan:\s*([^\n]+)/i);
                        const kekuranganMatch = doc.description.match(/Kekurangan:\s*(.+)/i);

                        if (jobTypeMatch) {
                            response += ` Jenis Pekerjaan: ${jobTypeMatch[1].trim()}\n`;
                        }

                        response += `📝 Kekurangan:\n`;

                        // Parse kekurangan items
                        let kekuranganText = '';
                        if (kekuranganMatch) {
                            kekuranganText = kekuranganMatch[1].trim();
                        } else {
                            // Fallback: split by semicolon for backward compatibility
                            const parts = doc.description.split(';');
                            kekuranganText = parts.length > 1 ? parts.slice(1).join(';').trim() : doc.description;
                        }

                        const items = kekuranganText.split(';').map(item => item.trim()).filter(item => item);
                        items.forEach((item, index) => {
                            response += `${index + 1}. ${item}\n`;
                        });
                    }

                    response += `👤 Dilaporkan oleh: ${doc.created_by}\n`;
                    response += `📅 Tanggal: ${new Date(doc.created_at).toLocaleDateString()}\n`;
                    response += `---\n\n`;
                });
            } else {
                response = `📋 *Dokumen untuk "${ptName}" (${results.length} ditemukan):*\n\n`;

                results.slice(0, 10).forEach((doc, index) => {
                    response += this.documentService.formatDocumentForDisplay(doc, index + 1);
                });
            }

            response += `💡 *Untuk menambah kekurangan:*\n\`.updatekekuranganpt ${ptName}:[kekurangan yang ditemukan]\``;

            return response;

        } catch (error) {
            console.error('Error checking kekurangan PT:', error);
            return '❌ Terjadi kesalahan saat mencari kekurangan PT. Silakan coba lagi.';
        }
    }

    // Handle update kekurangan PT
    async handleUpdateKekuranganPT(parsedMessage, parameter) {
        if (!this.documentService || !this.documentService.initialized) {
            return '❌ Layanan dokumen tidak tersedia. Silakan coba lagi nanti.';
        }

        try {
            // Parse parameter: "PT Name:JenisPekerjaan:kekurangan" or "PT Name:kekurangan" (backward compatibility)
            const firstColonIndex = parameter.indexOf(':');
            if (firstColonIndex === -1) {
                return '❌ Format tidak valid. Gunakan: `.updatekekuranganpt [nama PT]:[jenis pekerjaan]:[kekurangan]` atau `.updatekekuranganpt [nama PT]:[kekurangan]`\n\n**Contoh:** `.updatekekuranganpt PT Maju Bersatu:PPIU:1. ktp\n2. sk ppiu`';
            }

            const ptName = parameter.substring(0, firstColonIndex).trim();
            const remainingText = parameter.substring(firstColonIndex + 1).trim();

            // Check if this is 3-parameter format (PT:JenisPekerjaan:Kekurangan) or 2-parameter format (PT:Kekurangan)
            const secondColonIndex = remainingText.indexOf(':');

            let jenisPekerjaan = '';
            let kekuranganText = '';

            if (secondColonIndex === -1) {
                // 2-parameter format: PT:Kekurangan
                jenisPekerjaan = 'Tidak Spesifik';
                kekuranganText = remainingText;
            } else {
                // 3-parameter format: PT:JenisPekerjaan:Kekurangan
                jenisPekerjaan = remainingText.substring(0, secondColonIndex).trim();
                kekuranganText = remainingText.substring(secondColonIndex + 1).trim();
            }

            if (!ptName || !kekuranganText) {
                return '❌ Nama PT dan kekurangan harus diisi. Gunakan format: `.updatekekuranganpt [nama PT]:[jenis pekerjaan]:[kekurangan]`';
            }

            // Parse kekurangan yang bisa multiple items dengan nomor
            let kekuranganItems = [];

            // Split by newlines or semicolons
            const lines = kekuranganText.split(/[\n;]+/).map(line => line.trim()).filter(line => line);

            for (const line of lines) {
                // Check if line starts with number format (1., 2., etc.)
                const numberedMatch = line.match(/^\d+\.\s*(.+)$/);
                if (numberedMatch) {
                    kekuranganItems.push(numberedMatch[1].trim());
                } else {
                    // If not numbered, treat as single item
                    kekuranganItems.push(line);
                }
            }

            // If no items found, use the original text as single item
            if (kekuranganItems.length === 0) {
                kekuranganItems = [kekuranganText];
            }

            // Format kekurangan dengan nomor
            const formattedKekurangan = kekuranganItems.map((item, index) => `${index + 1}. ${item}`).join('\n');

            // Create document data for kekurangan
            const documentData = {
                documentType: 'Kekurangan Dokumen',
                documentName: `Kekurangan ${jenisPekerjaan} - ${new Date().toLocaleDateString()}`,
                description: `Jenis Pekerjaan: ${jenisPekerjaan}\nKekurangan: ${kekuranganItems.join('; ')}`,
                createdBy: parsedMessage.senderName,
                tags: ['kekurangan', 'update', jenisPekerjaan.toLowerCase(), parsedMessage.senderName.toLowerCase()]
            };

            // Add to database
            await this.documentService.addDocument(ptName, documentData);

            const response = `✅ *Kekurangan Dokumen Berhasil Ditambahkan!*

🏢 Nama PT: ${ptName}
📋 Tipe: Kekurangan Dokumen
 Jenis Pekerjaan: ${jenisPekerjaan}
📝 Kekurangan:
${formattedKekurangan}
👤 Dilaporkan oleh: ${parsedMessage.senderName}
📅 Tanggal: ${new Date().toLocaleDateString()}

📋 *Total Kekurangan untuk "${ptName}" sekarang dapat dilihat dengan:*
\`.kekuranganpt ${ptName}\`

💡 *Untuk menambah kekurangan lagi:*
\`.updatekekuranganpt ${ptName}:[jenis pekerjaan]:[kekurangan lain]\``;

            return response;

        } catch (error) {
            console.error('Error updating kekurangan PT:', error);
            return '❌ Terjadi kesalahan saat menambah kekurangan PT. Silakan coba lagi.';
        }
    }

    // Handle document commands (.kekuranganpt)
    async handleDocumentCommand(parsedMessage) {
        try {
            if (!this.documentService || !this.documentService.initialized) {
                return '❌ Layanan dokumen tidak tersedia. Silakan coba lagi nanti.';
            }

            console.log(`Processing document command from ${parsedMessage.senderName}`);

            // Show typing indicator
            await this.sendTypingIndicator(parsedMessage.chatId);

            // Get response from document menu service
            const response = await this.documentMenuService.handleDocumentCommand(
                parsedMessage.chatId,
                parsedMessage.senderName,
                parsedMessage.content
            );

            return response;

        } catch (error) {
            console.error('Error handling document command:', error);
            return '❌ Terjadi kesalahan saat memproses permintaan dokumen Anda. Silakan coba lagi nanti.';
        }
    }

    // Handle document menu responses
    async handleDocumentMenuResponse(parsedMessage, userId) {
        try {
            console.log(`Processing document menu response from ${parsedMessage.senderName}: "${parsedMessage.content}"`);

            // Show typing indicator
            await this.sendTypingIndicator(parsedMessage.chatId);

            // Get response from document menu service
            const response = await this.documentMenuService.handleDocumentCommand(
                parsedMessage.chatId,
                parsedMessage.senderName,
                parsedMessage.content
            );

            // Send response
            if (this.simulationMode) {
                console.log(`🔧 [SIMULATION] Document menu response to ${parsedMessage.senderName}:`);
                console.log(response);
            } else {
                await this.wahaService.sendMessage(parsedMessage.chatId, response);
            }

            // Log the document menu interaction
            if (this.activeDatabaseService && this.activeDatabaseService.initialized) {
                await this.activeDatabaseService.logCommand(
                    parsedMessage.chatId,
                    'document_menu_response',
                    {
                        senderName: parsedMessage.senderName,
                        userInput: parsedMessage.content,
                        timestamp: new Date().toISOString()
                    }
                );
            }

        } catch (error) {
            console.error('Error handling document menu response:', error);
            const errorMessage = '❌ Terjadi kesalahan saat memproses pilihan dokumen Anda. Silakan coba lagi.';

            if (this.simulationMode) {
                console.log(`🔧 [SIMULATION] Error message to ${parsedMessage.senderName}: ${errorMessage}`);
            } else {
                await this.wahaService.sendMessage(parsedMessage.chatId, errorMessage);
            }
        }
    }

    // Get help message with all available commands
    getHelpMessage() {
        return `🤖 *WhatsApp AI Bot - Panduan Lengkap*

🚀 *Cara Baru Berinteraksi:*
Tidak perlu lagi menggunakan menu! Sekarang Anda bisa chat langsung dengan AI menggunakan bahasa alami.

💬 *Cara Penggunaan AI Chat:*
Ketik permintaan Anda dalam bahasa Indonesia atau Inggris, contoh:

📊 *Data & Statistik:*
• "cari data user john" → Mencari pengguna bernama John
• "lihat semua pengguna" → Menampilkan daftar semua pengguna
• "tampilkan statistik pesan" → Menampilkan statistik lengkap
• "berapa total pesan hari ini?" → Info statistik hari ini
• "cari user dengan tag important" → Cari berdasarkan tag

📋 *Dokumen & Kekurangan PT:*
• "cek kekurangan PT Maju Bersatu" → Cek kekurangan dokumen
• "tambah kekurangan PT Test: paspor, visa" → Tambah kekurangan
• "ada kekurangan apa untuk PT Travel Umroh?" → Info kekurangan

📈 *Status Pekerjaan:*
• "laporan status hari ini" → Laporan status terkini
• "tambah status: PT Merdeka proses legalitas" → Tambah status baru
• "status kemarin ada apa saja?" → Lihat status kemarin
• "buat laporan AI untuk pimpinan" → Generate laporan formal

🎯 *Contoh Percakapan:*
**User:** "cari data pengguna dengan nama andi"
**AI:** 🔍 *Menemukan 2 pengguna dengan nama 'andi'...*

**User:** "cek kekurangan PT Maju Bersatu"
**AI:** 📋 *Kekurangan Dokumen untuk PT Maju Bersatu...*

**User:** "tambah status PT Test menunggu dokumen"
**AI:** ✅ *Status berhasil ditambahkan...*

🔧 *Fitur AI Chat:*
✅ Memahami bahasa Indonesia & Inggris
✅ Memori percakapan (mengingat konteks)
✅ Akses database langsung tanpa menu
✅ Pemrosesan cerdas dengan AI tools
✅ Format respons yang mudah dibaca

💡 *Tips Penggunaan:*
• Gunakan kata kunci: "cari", "lihat", "cek", "tambah", "laporan"
• Bisa bahasa Indonesia atau Inggris
• Tidak perlu format perintah yang rumit
• AI akan mengerti maksud Anda

⚡ *Perintah Tradisional (Masih Bisa):*
• \`.data\` - Menu database (jika diperlukan)
• \`.help\` - Bantuan ini
• \`${this.commandKey} <pesan>\` - Chat AI alternatif

🎉 *Sekarang lebih mudah! Cukup chat dengan AI seperti berbicara dengan asisten nyata!*

📱 *Butuh bantuan?* Kirim pesan dengan kata "help" atau "bantuan"`;
    }

    // Handle status commands (.laporan, .tambahstatus)
    async handleStatusCommand(parsedMessage, command) {
        try {
            if (!this.statusService || !this.statusService.initialized) {
                return '❌ Layanan status tidak tersedia. Silakan coba lagi nanti.';
            }

            console.log(`Processing status command "${command}" from ${parsedMessage.senderName}`);

            // Show typing indicator
            await this.sendTypingIndicator(parsedMessage.chatId);

            let response = '';

            // Parse command and parameters
            const parts = command.split(' ');
            const mainCommand = parts[0];
            const parameter = parts.slice(1).join(' ');

            switch (mainCommand) {
                case '.laporan':
                    if (!parameter || parameter.trim().length === 0) {
                        response = await this.showTodayStatus(parsedMessage);
                    } else {
                        response = await this.showStatusByDate(parsedMessage, parameter);
                    }
                    break;

                case '.tambahstatus':
                    if (!parameter || parameter.trim().length === 0) {
                        response = `📝 *Tambah Status Pekerjaan*

💡 *Format:*
\`.tambahstatus [status pekerjaan]\`

**Contoh:**
\`.tambahstatus PT Merdeka proses menunggu akta\`
\`.tambahstatus PT Kawan menunggu legalitas\`

**Status Bisa Multiple Items:**
\`.tambahstatus PT Test:1. dokumen A sedang diproses
2. menunggu konfirmasi client\`

📋 *Perintah Lainnya:*
• \`.laporan\` - Lihat laporan status hari ini
• \`.help\` - Bantuan lengkap`;
                    } else {
                        response = await this.updateStatus(parsedMessage, parameter);
                    }
                    break;

                default:
                    response = '❌ Perintah status tidak valid. Gunakan `.laporan` atau `.tambahstatus [status]`';
            }

            // Send response
            if (this.simulationMode) {
                console.log(`🔧 [SIMULATION] Status command response to ${parsedMessage.senderName}:`);
                console.log(response);
            } else {
                await this.wahaService.sendMessage(parsedMessage.chatId, response);
            }

            // Log the command
            if (this.activeDatabaseService && this.activeDatabaseService.initialized) {
                await this.activeDatabaseService.logCommand(
                    parsedMessage.chatId,
                    'status_command',
                    {
                        senderName: parsedMessage.senderName,
                        command: command,
                        timestamp: new Date().toISOString()
                    }
                );
            }

        } catch (error) {
            console.error('Error handling status command:', error);
            const errorMessage = '❌ Terjadi kesalahan saat memproses status. Silakan coba lagi nanti.';

            if (this.simulationMode) {
                console.log(`🔧 [SIMULATION] Error message to ${parsedMessage.senderName}: ${errorMessage}`);
            } else {
                await this.wahaService.sendMessage(parsedMessage.chatId, errorMessage);
            }
        }
    }

    // Show today's status
    async showTodayStatus(parsedMessage) {
        try {
            const statusList = await this.statusService.getTodayStatus();

            if (statusList.length === 0) {
                const response = `📋 *Status Pekerjaan Hari Ini*

📅 Tanggal: ${new Date().toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
🕐 Waktu: ${new Date().toLocaleTimeString('id-ID')}

📝 *Belum ada status pekerjaan yang dilaporkan hari ini.*

💡 *Untuk menambah status:*
\`.tambahstatus [status pekerjaan]\`

**Contoh:**
\`.tambahstatus PT Merdeka proses menunggu akta\`
\`.tambahstatus PT Kawan menunggu legalitas\`

📋 *Status AI:*
\`.laporan\` (untuk format laporan ke pimpinan)`;
                return response;
            }

            let response = `📋 *Status Pekerjaan Hari Ini*

📅 Tanggal: ${new Date().toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
🕐 Update Terakhir: ${new Date().toLocaleTimeString('id-ID')}
📊 Total Status: ${statusList.length}

📝 *Daftar Status:*\n\n`;

            statusList.forEach((status, index) => {
                response += this.statusService.formatStatusForDisplay(status, index + 1);
            });

            response += `\n💡 *Untuk menambah status:*
\`.tambahstatus [status pekerjaan]\`

📋 *Status AI:*
\`.laporan\` (untuk format laporan ke pimpinan)`;
            return response;

        } catch (error) {
            console.error('Error showing today status:', error);
            return '❌ Terjadi kesalahan saat mengambil status. Silakan coba lagi.';
        }
    }

    // Show status by specific date
    async showStatusByDate(parsedMessage, dateString) {
        try {
            // Parse date string (support various formats)
            let targetDate;
            try {
                if (dateString.toLowerCase() === 'kemarin') {
                    const yesterday = new Date();
                    yesterday.setDate(yesterday.getDate() - 1);
                    targetDate = yesterday.toISOString().split('T')[0];
                } else if (dateString.toLowerCase() === 'besok') {
                    const tomorrow = new Date();
                    tomorrow.setDate(tomorrow.getDate() + 1);
                    targetDate = tomorrow.toISOString().split('T')[0];
                } else {
                    // Try to parse as date
                    const parsedDate = new Date(dateString);
                    if (isNaN(parsedDate.getTime())) {
                        // Try DD/MM/YYYY format
                        const parts = dateString.split('/');
                        if (parts.length === 3) {
                            targetDate = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
                        } else {
                            throw new Error('Invalid date format');
                        }
                    } else {
                        targetDate = parsedDate.toISOString().split('T')[0];
                    }
                }
            } catch (error) {
                return `❌ Format tanggal tidak valid. Gunakan format DD/MM/YYYY atau kata kunci seperti "kemarin", "besok".\n\n**Contoh:**\n\`.laporan 18/10/2025\`\n\`.laporan kemarin\`\n\`.laporan besok\``;
            }

            const statusList = await this.statusService.getStatusByDate(targetDate);

            if (statusList.length === 0) {
                const response = `📋 *Status Pekerjaan - ${targetDate}*

📅 Tanggal: ${new Date(targetDate).toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}

📝 *Tidak ada status pekerjaan untuk tanggal ini.*

💡 *Untuk menambah status:*
\`.tambahstatus [status pekerjaan]\``;
                return response;
            }

            let response = `📋 *Status Pekerjaan - ${targetDate}*

📅 Tanggal: ${new Date(targetDate).toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
📊 Total Status: ${statusList.length}

📝 *Daftar Status:*\n\n`;

            statusList.forEach((status, index) => {
                response += this.statusService.formatStatusForDisplay(status, index + 1);
            });

            return response;

        } catch (error) {
            console.error('Error showing status by date:', error);
            return '❌ Terjadi kesalahan saat mengambil status. Silakan coba lagi.';
        }
    }

    // Update status
    async updateStatus(parsedMessage, statusText) {
        try {
            // Parse status text for multiple items
            let statusItems = [];

            // Split by semicolon or newline
            const lines = statusText.split(/[;\n]+/).map(line => line.trim()).filter(line => line);

            for (const line of lines) {
                // Check if line starts with number format (1., 2., etc.)
                const numberedMatch = line.match(/^\d+\.\s*(.+)$/);
                if (numberedMatch) {
                    statusItems.push(numberedMatch[1].trim());
                } else {
                    // If not numbered, treat as single item
                    statusItems.push(line);
                }
            }

            // If no items found, use the original text as single item
            if (statusItems.length === 0) {
                statusItems = [statusText];
            }

            // Add each status to database
            const addedStatuses = [];
            for (const item of statusItems) {
                const status = await this.statusService.addStatus(
                    item,
                    parsedMessage.senderName,
                    ['user-added', 'manual-update']
                );
                addedStatuses.push(status);
            }

            let response = `✅ *Status Berhasil Ditambahkan!*\n\n`;

            addedStatuses.forEach((status, index) => {
                response += `${index + 1}. ${status.status_text}\n`;
            });

            response += `\n👤 Ditambahkan oleh: ${parsedMessage.senderName}`;
            response += `\n📅 Tanggal: ${new Date().toLocaleDateString()}`;
            response += `\n🕐 Waktu: ${new Date().toLocaleTimeString('id-ID')}`;

            response += `\n\n💡 *Lihat laporan status hari ini:*
\`.laporan\`

📋 *Format AI untuk Pimpinan:*
\`.laporan\` (untuk membuat laporan formal)`;

            return response;

        } catch (error) {
            console.error('Error updating status:', error);
            return '❌ Terjadi kesalahan saat menambah status. Silakan coba lagi.';
        }
    }

    // Generate AI formatted report for management
    async generateStatusAIReport(parsedMessage, targetDate = null) {
        try {
            if (!this.statusService || !this.statusService.initialized) {
                return '❌ Layanan status tidak tersedia. Silakan coba lagi nanti.';
            }

            if (!this.statusAIService || !this.statusAIService.initialized) {
                return '❌ AI service tidak tersedia. Silakan coba lagi nanti.';
            }

            const date = targetDate || new Date().toISOString().split('T')[0];
            const statusList = await this.statusService.getStatusByDate(date);

            if (statusList.length === 0) {
                return `📋 *Laporan Status AI - ${date}*

Tidak ada status pekerjaan untuk tanggal ini, sehingga tidak dapat dibuat laporan AI.

💡 *Tips:*
- Tambah status terlebih dahulu dengan \`.tambahstatus [status]\`
- Pastikan status sudah tersedia sebelum generate laporan AI`;
            }

            // Show processing message
            const processingMessage = `🤖 *Sedang Memproses Laporan Status dengan AI...*

📊 Data Status: ${statusList.length} item
🎯 Target: Format formal untuk pimpinan
⏳ Mohon tunggu beberapa saat...`;

            if (!this.simulationMode) {
                await this.wahaService.sendMessage(parsedMessage.chatId, processingMessage);
            } else {
                console.log(`🔧 [SIMULATION] Processing message: ${processingMessage}`);
            }

            // Process with AI
            const aiResult = await this.statusAIService.processStatusForManagement(statusList);

            // Save AI processed result
            for (const status of statusList) {
                await this.statusService.saveAIProcessedStatus(
                    status.id,
                    status.status_text,
                    aiResult.formattedText,
                    parsedMessage.senderName,
                    'Groq AI'
                );
            }

            const aiModelInfo = this.statusAIService.getAIModelInfo();

            const response = `📋 *Laporan Status AI untuk Management*

📅 Tanggal: ${date}
🤖 AI Model: ${aiModelInfo.model}
📊 Total Status: ${aiResult.originalCount}
⏱️ Diproses: ${new Date(aiResult.processedAt).toLocaleTimeString('id-ID')}

--- ${aiResult.formattedText} ---

👤 *Generated by:* ${parsedMessage.senderName}
🤖 *Processed by:* ${aiModelInfo.model}
📅 *Tanggal:* ${new Date().toLocaleDateString()}

📋 *Status AI ini tersimpan di database dan dapat diakses kembali.*`;

            return response;

        } catch (error) {
            console.error('Error generating AI status report:', error);

            // Fallback to enhanced text formatting
            const statusList = await this.statusService.getStatusByDate(targetDate);
            if (statusList.length > 0) {
                let response = `📋 *Laporan Status (Enhanced) - ${targetDate}*\n\n`;

                statusList.forEach((status, index) => {
                    const enhancedText = this.statusAIService.enhanceStatusText(status.status_text);
                    response += `${index + 1}. ${enhancedText} (oleh: ${status.created_by})\n`;
                });

                response += `\n\n⚠️ *AI Processing Error - Menampilkan format alternatif*`;
                return response;
            }

            return '❌ Terjadi kesalahan saat memproses laporan status AI. Silakan coba lagi.';
        }
    }

    // Get spam statistics for monitoring
    getSpamStats() {
        return {
            totalRateLimits: this.spamDetector.rateLimits.size,
            totalCooldowns: this.spamDetector.cooldowns.size,
            totalReputations: this.spamDetector.userReputation.size,
            recentMessages: this.spamDetector.recentMessages.length
        };
    }
}

module.exports = WABot;