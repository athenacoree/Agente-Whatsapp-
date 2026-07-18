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
                this.startNudgeDaemon();
                return true;
            }

            console.log('Checking WAHA connection...');
            const status = await this.wahaService.checkConnection();
            console.log('WAHA connection status:', status);

            // Start the inactivity nudge daemon
            this.startNudgeDaemon();

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

            // 1. Access Control: Check if user is banned
            const settings = global.aiSettings || {};
            const userAccess = settings.userAccess || {};
            const senderAccess = userAccess[parsedMessage.chatId] || 'normal';

            if (senderAccess === 'banned') {
                console.log(`🚫 Banned user attempted to send message: ${parsedMessage.chatId}`);
                if (!parsedMessage.chatId.includes('@g.us')) {
                    await this.wahaService.sendMessage(parsedMessage.chatId, "❌ Lo siento, tu acceso a este sistema ha sido revocado de manera manual por el administrador.");
                }
                return;
            }

            // 2. Administrator Command Interceptor
            const cleanSenderPhone = parsedMessage.chatId.replace('@c.us', '').replace('@g.us', '');
            const adminPhone = (settings.adminPhoneNumber || '').replace('+', '').trim();
            const isAdmin = adminPhone && (cleanSenderPhone === adminPhone || parsedMessage.chatId === settings.adminPhoneNumber);

            if (isAdmin && parsedMessage.content && parsedMessage.content.startsWith('.')) {
                this.isProcessing.add(processingKey);
                try {
                    await this.handleAdminCommand(parsedMessage);
                    return;
                } finally {
                    this.isProcessing.delete(processingKey);
                }
            }

            // Check if this is a bot command OR user is in an active menu state
            const userId = this.getConversationKey(parsedMessage.chatId, parsedMessage.from);

            // Fetch registration and profile info
            const profile = await this.getOrCreateUserProfile(parsedMessage.chatId, parsedMessage.senderName);
            let profileData = {};
            if (profile && profile.data_json) {
                profileData = typeof profile.data_json === 'string' ? JSON.parse(profile.data_json) : profile.data_json;
            }
            const isRegistered = profileData.is_registered === true || senderAccess === 'special';

            // Handle referral tracking before checking registration status
            const refMatch = parsedMessage.content.match(/ref_([a-zA-Z0-9@.-]+)/);
            if (refMatch && !isRegistered) {
                const referrerId = refMatch[1];
                profileData.referred_by = referrerId;
                await this.activeDatabaseService.upsertUserData(parsedMessage.chatId, { data: profileData });
                console.log(`User ${parsedMessage.chatId} was referred by ${referrerId}`);
            }

            // Unregistered user restriction and registration flow handling
            if (!isRegistered) {
                const lowerContent = parsedMessage.content.toLowerCase().trim();
                const isStartingRegistration = lowerContent === 'registrarme' || lowerContent === 'registrar' || lowerContent === 'registro' || lowerContent === 'si' || lowerContent === 'sí' || lowerContent === 'yes' || lowerContent === 'aceptar' || profileData.registration_step;

                if (isStartingRegistration) {
                    this.isProcessing.add(processingKey);
                    global.activeChatsCount = (global.activeChatsCount || 0) + 1;
                    try {
                        await this.handleRegistrationFlow(parsedMessage, profile, parsedMessage.content);
                        return;
                    } finally {
                        this.isProcessing.delete(processingKey);
                        global.activeChatsCount = Math.max(0, (global.activeChatsCount || 1) - 1);
                    }
                }

                // If asking about system capabilities
                const isAskingCapabilities = lowerContent.includes('que puedes hacer') || lowerContent.includes('quien eres') || lowerContent.includes('cómo funciona') || lowerContent.includes('como funciona') || lowerContent.includes('help') || lowerContent.includes('ayuda') || lowerContent.includes('info');

                if (isAskingCapabilities) {
                    this.isProcessing.add(processingKey);
                    global.activeChatsCount = (global.activeChatsCount || 0) + 1;
                    try {
                        await this.sendTypingIndicator(parsedMessage.chatId);
                        const restrictedPrompt = `You are a WhatsApp AI Bot. The user is currently UNREGISTERED. You are only allowed to explain how the system works and what it can do. Under no circumstances should you provide any database records, documents, statuses, or confidential information. You must be polite and encourage the user to register by typing "registrarme" to unlock all features. Answer in the same language as the user: "${parsedMessage.content}".`;

                        let response;
                        if (this.grokService.isEnabled() && this.grokService.getClient()) {
                            response = await this.grokService.chatCompletion([
                                { role: 'system', content: restrictedPrompt },
                                { role: 'user', content: parsedMessage.content }
                            ]);
                        } else {
                            response = await this.groqService.chatCompletion([
                                { role: 'system', content: restrictedPrompt },
                                { role: 'user', content: parsedMessage.content }
                            ]);
                        }

                        if (response.success) {
                            await this.wahaService.sendMessage(parsedMessage.chatId, response.content);
                        } else {
                            await this.wahaService.sendMessage(parsedMessage.chatId, "¡Hola! Soy un bot asistente de IA. Para chatear normalmente y usar mis funciones avanzadas, debes registrarte escribiendo *registrarme*.");
                        }
                        return;
                    } finally {
                        this.isProcessing.delete(processingKey);
                        global.activeChatsCount = Math.max(0, (global.activeChatsCount || 1) - 1);
                    }
                }

                // If any other message, ask them to register
                this.isProcessing.add(processingKey);
                global.activeChatsCount = (global.activeChatsCount || 0) + 1;
                try {
                    const currentPolicies = global.aiSettings?.privacyPolicy || "Políticas de seguridad y privacidad.";
                    await this.wahaService.sendMessage(parsedMessage.chatId, `🤖 *¡Hola! Bienvenido al Bot Asistente de IA.*\n\nPara poder chatear normalmente y utilizar mis herramientas, debes crear una cuenta rápida desde aquí.\n\nPara comenzar, debes aceptar nuestras políticas de privacidad y seguridad:\n\n"${currentPolicies}"\n\n👉 Escribe *ACEPTAR* o *SI* para iniciar el registro.`);
                    return;
                } finally {
                    this.isProcessing.delete(processingKey);
                    global.activeChatsCount = Math.max(0, (global.activeChatsCount || 1) - 1);
                }
            }

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
                const lowerMsg = userMessage.toLowerCase().trim();

                // 1. Check if user is in pending sex change reason state
                if (profileData.awaiting_sex_change_reason) {
                    await this.sendTypingIndicator(parsedMessage.chatId);
                    const pendingNewSex = profileData.pending_new_sex;

                    const evalPrompt = `Evalúa si la siguiente explicación es un motivo válido para cambiar el sexo de un usuario en su perfil a "${pendingNewSex}". La explicación es: "${userMessage}". Sé empático y justo. Si el motivo es razonable (corrección de un error al registrarse, transición de género, etc.), aprueba el cambio. Responde exactamente en el formato: "APROBADO: <explicación amable>" o "RECHAZADO: <explicación amable de por qué no se considera válido>".`;

                    let aiResponse;
                    if (this.grokService.isEnabled() && this.grokService.getClient()) {
                        aiResponse = await this.grokService.chatCompletion([
                            { role: 'system', content: evalPrompt },
                            { role: 'user', content: userMessage }
                        ]);
                    } else {
                        aiResponse = await this.groqService.chatCompletion([
                            { role: 'system', content: evalPrompt },
                            { role: 'user', content: userMessage }
                        ]);
                    }

                    const responseText = aiResponse.success ? aiResponse.content : 'APROBADO: Solicitud procesada automáticamente.';

                    if (responseText.toUpperCase().startsWith('APROBADO')) {
                        profileData.sex = pendingNewSex;
                        const aiMsg = responseText.replace(/^APROBADO:?/i, '').trim();
                        await this.wahaService.sendMessage(parsedMessage.chatId, `✅ *Cambio de Sexo Aprobado*\n\nLa IA ha evaluado y aprobado tu motivo:\n"${aiMsg}"\n\n⚧️ Tu sexo ha sido actualizado a: *${pendingNewSex}*.`);
                    } else {
                        const aiMsg = responseText.replace(/^RECHAZADO:?/i, '').trim();
                        await this.wahaService.sendMessage(parsedMessage.chatId, `❌ *Cambio de Sexo Rechazado*\n\nLa IA ha evaluado tu motivo y lo ha rechazado:\n"${aiMsg}"\n\nNo se realizaron cambios en tu perfil.`);
                    }

                    delete profileData.awaiting_sex_change_reason;
                    delete profileData.pending_new_sex;
                    await this.activeDatabaseService.upsertUserData(parsedMessage.chatId, { data: profileData });
                    return;
                }

                // 2. Profile Alteration and Referral Commands
                if (lowerMsg === 'referido' || lowerMsg === 'recomendar') {
                    // Count referrals
                    let myReferidosCount = 0;
                    try {
                        const allUsers = await this.activeDatabaseService.getAllUserData(1000, 0);
                        const myReferidos = allUsers.filter(u => {
                            let uData = {};
                            try {
                                uData = typeof u.data_json === 'string' ? JSON.parse(u.data_json) : (u.data_json || {});
                            } catch (e) {
                                // Sometimes returned as object or string
                            }
                            return uData.referred_by === parsedMessage.chatId || uData.referred_by === parsedMessage.chatId.replace('@c.us', '');
                        });
                        myReferidosCount = myReferidos.length;
                    } catch (err) {
                        console.error('Error counting referrals:', err);
                    }

                    const botNum = this.getBotNumber();
                    const cleanMyId = parsedMessage.chatId.replace('@c.us', '');
                    const refLink = `https://wa.me/${botNum}?text=ref_${cleanMyId}`;

                    await this.wahaService.sendMessage(parsedMessage.chatId, `🔗 *Tu Enlace de Referido Personalizado:*\n${refLink}\n\n👥 *Estadísticas de Referidos:*\nHas traído a *${myReferidosCount}* usuario(s) a este bot.\n\n¡Comparte este enlace para que se registren bajo tu recomendación! 😊`);
                    return;
                }

                if (lowerMsg.startsWith('cambiar nombre ')) {
                    const newName = userMessage.substring(15).trim();
                    const nameWords = newName.split(/\s+/);

                    if (nameWords.length < 2) {
                        await this.wahaService.sendMessage(parsedMessage.chatId, `⚠️ El nombre de reemplazo debe incluir nombre y apellidos (mínimo dos palabras).`);
                        return;
                    }

                    try {
                        const results = await this.activeDatabaseService.searchUserData(newName, 'name');
                        const isTaken = results.some(u => {
                            const uData = u.data_json || {};
                            return u.chat_id !== parsedMessage.chatId && uData.is_registered && u.user_name.toLowerCase() === newName.toLowerCase();
                        });

                        if (isTaken) {
                            await this.wahaService.sendMessage(parsedMessage.chatId, `⚠️ Lo siento, el nombre *${newName}* ya está registrado por otro usuario.`);
                            return;
                        }

                        profileData.fullName = newName;
                        await this.activeDatabaseService.upsertUserData(parsedMessage.chatId, {
                            userName: newName,
                            data: profileData
                        });

                        await this.wahaService.sendMessage(parsedMessage.chatId, `✅ *Nombre Actualizado*\n\nTu nombre en el bot ha sido cambiado exitosamente a: *${newName}*.`);
                    } catch (err) {
                        console.error('Error changing name:', err);
                        await this.wahaService.sendMessage(parsedMessage.chatId, `❌ Error al cambiar tu nombre. Por favor intenta de nuevo.`);
                    }
                    return;
                }

                if (lowerMsg.startsWith('cambiar sexo ')) {
                    const newSex = userMessage.substring(13).trim();
                    if (!newSex) {
                        await this.wahaService.sendMessage(parsedMessage.chatId, `⚠️ Por favor especifica el nuevo sexo. Ejemplo: *cambiar sexo Femenino*`);
                        return;
                    }

                    profileData.awaiting_sex_change_reason = true;
                    profileData.pending_new_sex = newSex;
                    await this.activeDatabaseService.upsertUserData(parsedMessage.chatId, { data: profileData });

                    await this.wahaService.sendMessage(parsedMessage.chatId, `⚧️ Para cambiar tu sexo a *${newSex}*, por favor responde a este mensaje explicando detalladamente la razón de este cambio.\n\nLa IA evaluará si es un motivo válido antes de actualizar tu perfil.`);
                    return;
                }

                // 3. Live Interaction Matchmaking Flow and Commands
                const isMatchmakingCommand = lowerMsg === 'live interaccion' ||
                                             lowerMsg === 'desactivar live interaccion' ||
                                             lowerMsg === 'ver candidatos' ||
                                             lowerMsg === 'ver candidato' ||
                                             profileData.live_interaction_state ||
                                             profileData.current_candidate;

                if (isMatchmakingCommand) {
                    await this.handleLiveInteraction(parsedMessage, profileData, userMessage);
                    return;
                }

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

                // Check if the message requires tools (long-running background task)
                const needsTools = this.aiChatService.checkIfToolsNeeded(userMessage);

                if (needsTools) {
                    // Send dynamic immediate non-blocking responses
                    if (this.simulationMode) {
                        console.log(`🔧 [SIMULATION] Immediate response 1 to ${parsedMessage.senderName}: Espera un momento...`);
                        console.log(`🔧 [SIMULATION] Immediate response 2 to ${parsedMessage.senderName}: Pero bueno, podemos seguir hablando mientras se completa la tarea.`);
                    } else {
                        await this.wahaService.sendMessage(parsedMessage.chatId, "Espera un momento...");
                        await this.wahaService.sendMessage(parsedMessage.chatId, "Pero bueno, podemos seguir hablando mientras se completa la tarea.");
                    }

                    // Process task in background (non-blocking)
                    this.processBackgroundTask(parsedMessage, userMessage, history, conversationKey, profileData.country);
                    return;
                }

                // Show typing indicator
                await this.sendTypingIndicator(parsedMessage.chatId);

                // Process with AI Chat Service (with MCP tools, passing user country)
                const response = await this.aiChatService.processMessage(userMessage, history, profileData.country);

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
            await this.reportProblemToAdmin(`Error en handleIncomingMessage: ${error.stack || error.message}`);
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

    async getOrCreateUserProfile(chatId, senderName) {
        if (!this.activeDatabaseService) return null;
        try {
            let profile = await this.activeDatabaseService.getUserData(chatId);
            if (profile && typeof profile.data_json === 'string') {
                try {
                    profile.data_json = JSON.parse(profile.data_json);
                } catch (e) {}
            }
            if (!profile) {
                // Initialize as unregistered
                profile = await this.activeDatabaseService.upsertUserData(chatId, {
                    userName: senderName,
                    phoneNumber: chatId.replace('@c.us', '').replace('@g.us', ''),
                    data: {
                        is_registered: false,
                        registration_step: 'awaiting_policies'
                    },
                    tags: ['new-user']
                });
            }
            return profile;
        } catch (error) {
            console.error('Error getting or creating user profile:', error);
            return null;
        }
    }

    async handleRegistrationFlow(parsedMessage, profile, userMessage) {
        const chatId = parsedMessage.chatId;
        const data = profile.data_json || {};
        const step = data.registration_step || 'awaiting_policies';

        // Check if user wants to see policies or skip/cancel
        const lowerMsg = userMessage.toLowerCase().trim();

        // Load Privacy Policy from settings
        const currentPolicies = global.aiSettings?.privacyPolicy || "Políticas de seguridad y privacidad.";

        switch (step) {
            case 'awaiting_policies':
                if (lowerMsg === 'aceptar' || lowerMsg === 'si' || lowerMsg === 'sí' || lowerMsg === 'yes' || lowerMsg === 'ok') {
                    data.registration_step = 'awaiting_name';
                    await this.activeDatabaseService.upsertUserData(chatId, { data });
                    await this.wahaService.sendMessage(chatId, `✅ Has aceptado las políticas de seguridad y privacidad.\n\n👤 Paso 2/6: Por favor, dime tu *Nombre y Apellidos* reales.\n\n💡 _Nota: Es mejor usar tu nombre real para futuras funcionalidades de tu cuenta._`);
                } else {
                    await this.wahaService.sendMessage(chatId, `⚠️ Para utilizar el bot, debes aceptar las políticas de seguridad y privacidad.\n\nEscribe *ACEPTAR* o *SI* para continuar.\n\nPolíticas:\n${currentPolicies}`);
                }
                break;

            case 'awaiting_name':
                // Clean name: should be at least two words (name and surname) as requested: "que sea nombre y apellidos"
                const nameWords = userMessage.trim().split(/\s+/);
                if (nameWords.length < 2) {
                    await this.wahaService.sendMessage(chatId, `⚠️ Por favor, introduce tu nombre y apellidos (mínimo dos palabras).\n\nEjemplo: *Juan Pérez*`);
                    return;
                }

                const fullName = userMessage.trim();

                // Check if name is already taken by a registered user
                try {
                    const results = await this.activeDatabaseService.searchUserData(fullName, 'name');
                    const isTaken = results.some(u => {
                        const uData = u.data_json || {};
                        return u.chat_id !== chatId && uData.is_registered;
                    });

                    if (isTaken) {
                        await this.wahaService.sendMessage(chatId, `⚠️ Lo siento, el nombre *${fullName}* ya está registrado por otro usuario. Por favor, ingresa un nombre diferente o añade tu segundo apellido.`);
                        return;
                    }
                } catch (e) {
                    console.error('Error checking name uniqueness:', e);
                }

                data.fullName = fullName;
                data.registration_step = 'awaiting_country';
                await this.activeDatabaseService.upsertUserData(chatId, {
                    userName: fullName,
                    data
                });

                await this.wahaService.sendMessage(chatId, `👤 ¡Mucho gusto, *${fullName}*!\n\n🌍 Paso 3/6: ¿De qué *país* eres?\n\n💡 _Escribe tu país o escribe *OMITIR* si prefieres no dar este dato._`);
                break;

            case 'awaiting_country':
                if (lowerMsg === 'omitir') {
                    data.country = null;
                    data.registration_step = 'awaiting_age'; // If country is skipped, skip location too
                    await this.wahaService.sendMessage(chatId, `🎂 Paso 5/6: ¿Cuál es tu *edad*?\n\n⚠️ _Nota: Este dato no podrá ser modificado más adelante._`);
                } else {
                    data.country = userMessage.trim();
                    data.registration_step = 'awaiting_location';
                    await this.wahaService.sendMessage(chatId, `🌍 Registrado: *${data.country}*.\n\n📍 Paso 4/6: ¿De qué *provincia, municipio o estado* eres de ese país?\n\n💡 _Escribe tu ubicación o escribe *OMITIR* si prefieres no dar este dato._`);
                }
                await this.activeDatabaseService.upsertUserData(chatId, { data });
                break;

            case 'awaiting_location':
                if (lowerMsg === 'omitir') {
                    data.location = null;
                } else {
                    data.location = userMessage.trim();
                }
                data.registration_step = 'awaiting_age';
                await this.activeDatabaseService.upsertUserData(chatId, { data });
                await this.wahaService.sendMessage(chatId, `🎂 Paso 5/6: ¿Cuál es tu *edad*?\n\n⚠️ _Nota: Este dato no podrá ser modificado más adelante._`);
                break;

            case 'awaiting_age':
                const age = parseInt(userMessage.trim());
                if (isNaN(age) || age <= 0 || age > 120) {
                    await this.wahaService.sendMessage(chatId, `⚠️ Por favor, ingresa una edad válida en números.\n\nEjemplo: *25*`);
                    return;
                }

                data.age = age;
                data.registration_step = 'awaiting_sex';
                await this.activeDatabaseService.upsertUserData(chatId, { data });
                await this.wahaService.sendMessage(chatId, `⚧️ Paso 6/6: ¿Cuál es tu *sexo*?\n\n💡 _Escribe tu sexo (ej: Masculino, Femenino, Otro). Nota: Para cambiar este dato en el futuro, deberás explicarle el motivo a la IA para su aprobación._`);
                break;

            case 'awaiting_sex':
                const sex = userMessage.trim();
                data.sex = sex;
                data.is_registered = true;
                delete data.registration_step;

                await this.activeDatabaseService.upsertUserData(chatId, {
                    data,
                    tags: ['registered']
                });

                await this.wahaService.sendMessage(chatId, `🎉 *¡Felicidades, tu registro se ha completado con éxito!*

👤 Nombre: ${data.fullName}
🌍 País: ${data.country || 'No especificado'}
📍 Ubicación: ${data.location || 'No especificado'}
🎂 Edad: ${data.age}
⚧️ Sexo: ${data.sex}

📲 *IMPORTANTE:* Para asegurar el correcto funcionamiento del bot, *debes guardar mi número de teléfono en tu lista de contactos* de tu celular.

Ahora que estás registrado, puedes chatear conmigo normalmente y usar todas mis funcionalidades avanzadas como la consulta de bases de datos, informes, live interacción, ¡y más! 😊`);
                break;
        }
    }

    async handleLiveInteraction(parsedMessage, profileData, userMessage) {
        const chatId = parsedMessage.chatId;
        const lowerMsg = userMessage.toLowerCase().trim();

        // 1. If not yet in live interaction survey but wants to activate
        if (!profileData.live_interaction_state && !profileData.live_interaction_active) {
            profileData.live_interaction_state = 'survey_intro';
            await this.activeDatabaseService.upsertUserData(chatId, { data: profileData });
            await this.wahaService.sendMessage(chatId, `💞 *Bienvenido a Live Interacción* 💞\n\nEsta funcionalidad te permite emparejarte con personas de tus mismos gustos con tu permiso mutuo.\n\nPara comenzar, debes completar una breve encuesta descriptiva y proporcionar una foto que la IA compartirá únicamente con tus candidatos.\n\n👉 ¿Deseas iniciar la encuesta ahora? Responde con *SI* o *NO*.`);
            return;
        }

        // 2. Survey state machine
        const state = profileData.live_interaction_state;

        if (state === 'survey_intro') {
            if (lowerMsg === 'si' || lowerMsg === 'sí' || lowerMsg === 'yes' || lowerMsg === 'ok') {
                profileData.live_interaction_state = 'awaiting_self_desc';
                await this.activeDatabaseService.upsertUserData(chatId, { data: profileData });
                await this.wahaService.sendMessage(chatId, `📝 *Paso 1/3: Descríbete a ti mismo.*\n\nPor favor, escribe un párrafo describiendo tu personalidad, intereses, pasatiempos y lo que consideres importante de ti.`);
            } else {
                delete profileData.live_interaction_state;
                await this.activeDatabaseService.upsertUserData(chatId, { data: profileData });
                await this.wahaService.sendMessage(chatId, `❌ Se ha cancelado la activación de Live Interacción. Puedes volver a intentarlo escribiendo *live interaccion* cuando quieras.`);
            }
            return;
        }

        if (state === 'awaiting_self_desc') {
            profileData.match_self_desc = userMessage.trim();
            profileData.live_interaction_state = 'awaiting_partner_desc';
            await this.activeDatabaseService.upsertUserData(chatId, { data: profileData });
            await this.wahaService.sendMessage(chatId, `🎯 *Paso 2/3: Describe a tu persona ideal.*\n\n¿Cómo te gustaría que fuera la otra persona? Describe sus cualidades, intereses o gustos afines.`);
            return;
        }

        if (state === 'awaiting_partner_desc') {
            profileData.match_partner_desc = userMessage.trim();
            profileData.live_interaction_state = 'awaiting_photo';
            await this.activeDatabaseService.upsertUserData(chatId, { data: profileData });
            await this.wahaService.sendMessage(chatId, `📸 *Paso 3/3: Proporciona tu fotografía.*\n\nPor favor, sube una foto de perfil o envíala como imagen en este chat.\n\n⚠️ _IMPORTANTE: Al enviar la foto, confirmas y autorizas que la IA la use y se la muestre a otros candidatos para realizar emparejamientos._\n\nEscribe *ACEPTAR FOTO* o envía la imagen para finalizar.`);
            return;
        }

        if (state === 'awaiting_photo') {
            profileData.match_photo_consent = true;
            profileData.live_interaction_active = true;
            delete profileData.live_interaction_state;

            // Initialize viewed and likes tracking
            profileData.viewed_candidates = [];
            profileData.likes_sent = [];

            await this.activeDatabaseService.upsertUserData(chatId, { data: profileData });
            await this.wahaService.sendMessage(chatId, `🎉 *¡Excelente! Tu perfil de Live Interacción está activo.* 🎉\n\nHas completado la encuesta correctamente.\n\n🔍 Para ver candidatos disponibles en tu ubicación, escribe *ver candidatos*.\n\n❌ Si deseas revocar o desactivar esta función en cualquier momento, escribe *desactivar live interaccion*.`);
            return;
        }

        // 3. Candidate actions when live interaction is active
        if (profileData.live_interaction_active) {
            // If they are answering yes/no to a current candidate
            if (profileData.current_candidate) {
                const candidateId = profileData.current_candidate;
                delete profileData.current_candidate; // Clear immediately

                if (lowerMsg === 'si' || lowerMsg === 'sí' || lowerMsg === 'yes' || lowerMsg === 'like') {
                    // Record like
                    profileData.likes_sent = profileData.likes_sent || [];
                    profileData.likes_sent.push({ to: candidateId, time: Date.now() });

                    await this.wahaService.sendMessage(chatId, `💖 ¡Has indicado que te interesa esta persona!`);

                    // Check if it's a mutual match (MASH)
                    let candidateProfile = await this.activeDatabaseService.getUserData(candidateId);
                    let candidateData = candidateProfile ? (candidateProfile.data_json || {}) : {};
                    let candidateLikes = candidateData.likes_sent || [];

                    const hasMutualLike = candidateLikes.some(like => like.to === chatId);

                    if (hasMutualLike) {
                        // MUTUAL MATCH!
                        const now = Date.now();
                        profileData.last_match_time = now;
                        candidateData.last_match_time = now;

                        // Save updated profiles
                        await this.activeDatabaseService.upsertUserData(chatId, { data: profileData });
                        await this.activeDatabaseService.upsertUserData(candidateId, { data: candidateData });

                        // Notify user A
                        const candidateName = candidateData.fullName || candidateProfile.user_name || "Candidato";
                        const candidatePhone = candidateProfile.phone_number || candidateId.replace('@c.us', '');
                        await this.wahaService.sendMessage(chatId, `🎉 *¡Felicidades! ¡Hay MATCH mutuo (MASH)!* 🎉\n\nAmbos han aprobado el emparejamiento. Aquí tienes sus datos de contacto:\n\n👤 Nombre: *${candidateName}*\n📱 WhatsApp: *wa.me/${candidatePhone}*\n\n¡Escríbele para comenzar a hablar! 😉`);

                        // Notify user B
                        const myProfile = await this.activeDatabaseService.getUserData(chatId);
                        const myName = profileData.fullName || myProfile.user_name || "Candidato";
                        const myPhone = myProfile.phone_number || chatId.replace('@c.us', '');
                        await this.wahaService.sendMessage(candidateId, `🎉 *¡Felicidades! ¡Hay MATCH mutuo (MASH)!* 🎉\n\nAmbos han aprobado el emparejamiento. Aquí tienes sus datos de contacto:\n\n👤 Nombre: *${myName}*\n📱 WhatsApp: *wa.me/${myPhone}*\n\n¡Escríbele para comenzar a hablar! 😉`);
                    } else {
                        // Save profile
                        await this.activeDatabaseService.upsertUserData(chatId, { data: profileData });
                        await this.wahaService.sendMessage(chatId, `Esperando a que la otra persona también te apruebe. Si es mutuo, ¡se intercambiarán los contactos! 😊`);
                    }
                } else {
                    await this.wahaService.sendMessage(chatId, `No hay problema, seguiremos buscando más candidatos para ti. Escribe *ver candidatos* para ver al siguiente.`);
                    await this.activeDatabaseService.upsertUserData(chatId, { data: profileData });
                }
                return;
            }

            // Command to fetch next candidate
            if (lowerMsg === 'ver candidatos' || lowerMsg === 'ver candidato') {
                // Check limits: 1 successful match in 24 hours
                const lastMatchTime = profileData.last_match_time || 0;
                if (Date.now() - lastMatchTime < 24 * 60 * 60 * 1000) {
                    await this.wahaService.sendMessage(chatId, `⚠️ *Límite de Matches:* Ya has logrado un emparejamiento exitoso en las últimas 24 horas. Para cuidar las interacciones, puedes tener un máximo de 1 match por día. ¡Intenta mañana de nuevo!`);
                    return;
                }

                // Check limits: 2 candidates viewed in last 24 hours
                profileData.viewed_candidates = profileData.viewed_candidates || [];
                const viewedLast24h = profileData.viewed_candidates.filter(vc => Date.now() - vc.time < 24 * 60 * 60 * 1000);

                if (viewedLast24h.length >= 2) {
                    await this.wahaService.sendMessage(chatId, `⚠️ *Límite de Candidatos:* Has visto tu límite diario de 2 candidatos en las últimas 24 horas. Vuelve en un día para ver más candidatos. ¡Gracias por tu paciencia!`);
                    return;
                }

                // Find candidate matching location (country/location)
                try {
                    const allUsers = await this.activeDatabaseService.getAllUserData(1000, 0);
                    const candidates = [];

                    for (const u of allUsers) {
                        if (u.chat_id === chatId) continue;

                        let uData = {};
                        try {
                            uData = typeof u.data_json === 'string' ? JSON.parse(u.data_json) : (u.data_json || {});
                        } catch (e) {
                            continue;
                        }

                        if (!uData.is_registered || !uData.live_interaction_active) continue;

                        // Check if already viewed in history (even if older than 24h)
                        const alreadyViewed = profileData.viewed_candidates.some(vc => vc.id === u.chat_id);
                        if (alreadyViewed) continue;

                        // Check matching country/location
                        const sameCountry = uData.country && profileData.country && uData.country.toLowerCase() === profileData.country.toLowerCase();

                        candidates.push({
                            id: u.chat_id,
                            data: uData,
                            score: sameCountry ? 2 : 1
                        });
                    }

                    // Sort candidates by match quality
                    candidates.sort((a, b) => b.score - a.score);

                    if (candidates.length === 0) {
                        await this.wahaService.sendMessage(chatId, `🔍 No hemos encontrado nuevos candidatos disponibles en tu zona por el momento. ¡Intenta de nuevo más tarde!`);
                        return;
                    }

                    const match = candidates[0];
                    profileData.current_candidate = match.id;
                    profileData.viewed_candidates.push({ id: match.id, time: Date.now() });

                    await this.activeDatabaseService.upsertUserData(chatId, { data: profileData });

                    await this.wahaService.sendMessage(chatId, `💞 *¡Candidato Encontrado!* 💞

📍 Ubicación: ${match.data.location || 'No especificado'}, ${match.data.country || 'No especificado'}
🎂 Edad: ${match.data.age || 'No especificada'}
⚧️ Sexo: ${match.data.sex || 'No especificado'}

📝 *Descripción personal:*
"${match.data.match_self_desc}"

🎯 *Lo que busca:*
"${match.data.match_partner_desc}"

📸 [Imagen de perfil compartida]

👉 ¿Te gustaría emparejarte con esta persona? Responde con *SI* o *NO*.`);
                } catch (err) {
                    console.error('Error finding candidate:', err);
                    await this.wahaService.sendMessage(chatId, `❌ Ocurrió un error al buscar candidatos.`);
                }
                return;
            }

            // Command to deactivate live interaction
            if (lowerMsg === 'desactivar live interaccion') {
                profileData.live_interaction_active = false;
                delete profileData.current_candidate;
                await this.activeDatabaseService.upsertUserData(chatId, { data: profileData });
                await this.wahaService.sendMessage(chatId, `❌ *Live Interacción Desactivado*\n\nHas desactivado el matchmaking. Ya no aparecerás en las búsquedas de otros candidatos ni recibirás sugerencias.\n\nPuedes reactivarlo en cualquier momento escribiendo *live interaccion*.`);
                return;
            }
        }
    }

    getBotNumber() {
        const envPhone = process.env.BOT_PHONE;
        if (envPhone) return envPhone;
        const settingsPhone = global.aiSettings?.botPhone;
        if (settingsPhone) return settingsPhone;
        return 'bot_phone';
    }

    async processBackgroundTask(parsedMessage, userMessage, history, conversationKey, country = null) {
        try {
            const response = await this.aiChatService.processMessage(userMessage, history, country);
            if (response.success) {
                let responseText = response.content;
                if (response.usedTools) {
                    responseText += '\n\n🔧 *Processed with AI tools*';
                }

                if (this.simulationMode) {
                    console.log(`🔧 [SIMULATION] Background task result to ${parsedMessage.senderName}: ${responseText}`);
                } else {
                    await this.wahaService.sendMessage(parsedMessage.chatId, responseText);
                }

                // Update history
                this.addToHistory(conversationKey, 'user', userMessage);
                this.addToHistory(conversationKey, 'assistant', responseText);

                // Log to database
                await this.logMessageToDatabase(parsedMessage, responseText);
            } else {
                const errMsg = `⚠️ Disculpa, hubo un problema al completar la tarea de fondo: ${response.error}`;
                if (this.simulationMode) {
                    console.log(`🔧 [SIMULATION] Background task error: ${errMsg}`);
                } else {
                    await this.wahaService.sendMessage(parsedMessage.chatId, errMsg);
                }
            }
        } catch (error) {
            console.error('Error processing background task:', error);
        }
    }

    async handleAdminCommand(parsedMessage) {
        const text = parsedMessage.content.trim();
        const parts = text.split(/\s+/);
        const command = parts[0].toLowerCase();
        const settings = global.aiSettings || {};

        let response = '';
        try {
            switch (command) {
                case '.verconfig':
                    response = `⚙️ *Configuración Actual de la IA:*\n\n` +
                               `• *Admin Phone:* ${settings.adminPhoneNumber || 'No establecido'}\n` +
                               `• *Grok enabled:* ${!!global.grokConfig?.enabled}\n` +
                               `• *Privacy Policy:* "${settings.privacyPolicy ? settings.privacyPolicy.substring(0, 100) + '...' : ''}"\n` +
                               `• *Dictionary:* [${(settings.personality?.dictionary || []).join(', ')}]\n` +
                               `• *Rules Count:* ${(settings.rules || []).length}\n` +
                               `• *Banned Users:* ${Object.entries(settings.userAccess || {}).filter(([_, status]) => status === 'banned').map(([id]) => id).join(', ') || 'Ninguno'}`;
                    break;

                case '.setconfig':
                    if (parts.length < 3) {
                        response = `⚠️ *Uso:* \`.setconfig <adminPhoneNumber|privacyPolicy> <nuevo_valor>\``;
                    } else {
                        const key = parts[1];
                        const val = parts.slice(2).join(' ');
                        const updatedPayload = {};
                        if (key === 'adminPhoneNumber' || key === 'privacyPolicy') {
                            updatedPayload[key] = val;
                            const settingsService = require('./settingsService');
                            settingsService.saveSettings(updatedPayload);
                            response = `✅ Configuración actualizada: *${key}* cambiado a: "${val}"`;
                        } else {
                            response = `⚠️ Llave no modificable directamente o no válida. Solo puedes modificar: *adminPhoneNumber*, *privacyPolicy*.`;
                        }
                    }
                    break;

                case '.ban':
                    if (parts.length < 2) {
                        response = `⚠️ *Uso:* \`.ban <tel_sin_mas_ni_arroba>\``;
                    } else {
                        let target = parts[1];
                        if (!target.includes('@')) target += '@c.us';
                        settings.userAccess = settings.userAccess || {};
                        settings.userAccess[target] = 'banned';
                        const settingsService = require('./settingsService');
                        settingsService.saveSettings({ userAccess: settings.userAccess });
                        response = `🚫 El usuario *${target}* ha sido *PROHIBIDO* (banned) exitosamente.`;
                    }
                    break;

                case '.unban':
                case '.unvip':
                    if (parts.length < 2) {
                        response = `⚠️ *Uso:* \`.unban <tel_sin_mas>\``;
                    } else {
                        let target = parts[1];
                        if (!target.includes('@')) target += '@c.us';
                        settings.userAccess = settings.userAccess || {};
                        settings.userAccess[target] = 'normal';
                        const settingsService = require('./settingsService');
                        settingsService.saveSettings({ userAccess: settings.userAccess });
                        response = `✅ El usuario *${target}* ha sido restablecido a estado *NORMAL* de acceso.`;
                    }
                    break;

                case '.vip':
                    if (parts.length < 2) {
                        response = `⚠️ *Uso:* \`.vip <tel_sin_mas>\``;
                    } else {
                        let target = parts[1];
                        if (!target.includes('@')) target += '@c.us';
                        settings.userAccess = settings.userAccess || {};
                        settings.userAccess[target] = 'special';
                        const settingsService = require('./settingsService');
                        settingsService.saveSettings({ userAccess: settings.userAccess });
                        response = `⭐ El usuario *${target}* ha sido promovido a *ACCESO ESPECIAL* (VIP) exitosamente.`;
                    }
                    break;

                case '.stats':
                    const dbStats = this.activeDatabaseService ? await this.activeDatabaseService.getMessageStats() : { totalMessages: 0, todayMessages: 0, uniqueUsers: 0 };
                    response = `📊 *Estadísticas de Live Interacción y Mensajes:*\n\n` +
                               `• Mensajes Totales: ${dbStats.totalMessages}\n` +
                               `• Mensajes Hoy: ${dbStats.todayMessages}\n` +
                               `• Conexiones WAHA: Activa\n` +
                               `• Uptime: ${Math.floor(process.uptime() / 60)} min`;
                    break;

                default:
                    response = `🤖 *Comandos de Administrador Disponibles:*\n\n` +
                               `• \`.verconfig\` - Ver estado de configuración\n` +
                               `• \`.setconfig <key> <value>\` - Modificar parámetro\n` +
                               `• \`.ban <tel>\` - Prohibir acceso\n` +
                               `• \`.unban <tel>\` - Desbloquear o unban\n` +
                               `• \`.vip <tel>\` - Otorgar acceso especial\n` +
                               `• \`.stats\` - Ver estadísticas rápidas`;
            }
        } catch (err) {
            response = `❌ Error procesando comando admin: ${err.message}`;
        }

        await this.wahaService.sendMessage(parsedMessage.chatId, response);
    }

    async reportProblemToAdmin(problemDetails) {
        try {
            const settings = global.aiSettings || {};
            const adminPhone = settings.adminPhoneNumber;
            if (adminPhone) {
                let adminChatId = adminPhone;
                if (!adminChatId.includes('@')) adminChatId += '@c.us';
                await this.wahaService.sendMessage(adminChatId, `⚠️ *REPORTE DE PROBLEMA / EXCEPCIÓN DEL SISTEMA* ⚠️\n\n🕒 Fecha: ${new Date().toISOString()}\n\n📝 Detalles:\n${problemDetails}`);
                console.log(`📬 Problem report forwarded to admin: ${adminChatId}`);
            }
        } catch (err) {
            console.error('Failed to forward problem report to admin:', err.message);
        }
    }

    startNudgeDaemon(intervalMs = 60 * 1000) {
        // Run nudge check immediately on start, then periodically
        const check = async () => {
            try {
                if (!this.activeDatabaseService || !this.activeDatabaseService.initialized) return;

                const users = await this.activeDatabaseService.getAllUserData(1000, 0);
                const now = Date.now();

                for (const u of users) {
                    let uData = {};
                    try {
                        uData = typeof u.data_json === 'string' ? JSON.parse(u.data_json) : (u.data_json || {});
                    } catch (e) {
                        continue;
                    }

                    // Check for inactivity in registration or matchmaking survey
                    const regStep = uData.registration_step;
                    const isRegistered = uData.is_registered === true;
                    const liveStep = uData.live_interaction_state;

                    const lastUpdated = new Date(u.updated_at).getTime();
                    const inactiveDuration = now - lastUpdated;

                    // Nudge after 5 minutes of inactivity (300,000 ms) and haven't nudged yet
                    if (inactiveDuration > 5 * 60 * 1000 && !uData.nudge_sent) {
                        if (regStep && !isRegistered) {
                            uData.nudge_sent = true;
                            await this.activeDatabaseService.upsertUserData(u.chat_id, { data: uData });

                            if (this.simulationMode) {
                                console.log(`🔧 [SIMULATION] Sending registration nudge to ${u.chat_id}`);
                            } else {
                                await this.wahaService.sendMessage(u.chat_id, `👋 ¡Hola! He notado que te quedaste a medias en el proceso de registro.\n\nSi deseas continuar, solo responde a este mensaje para completar tu cuenta de IA. 😊`);
                            }
                        } else if (liveStep) {
                            uData.nudge_sent = true;
                            await this.activeDatabaseService.upsertUserData(u.chat_id, { data: uData });

                            if (this.simulationMode) {
                                console.log(`🔧 [SIMULATION] Sending matchmaking nudge to ${u.chat_id}`);
                            } else {
                                await this.wahaService.sendMessage(u.chat_id, `👋 ¡Hola! Noté que no completaste tu encuesta de Live Interacción.\n\nResponde a este chat para terminar de activar tu perfil de parejas. 💞`);
                            }
                        }
                    }

                    // Reset nudge flag if they became active again (any message logs update their updated_at)
                    if (inactiveDuration < 1 * 60 * 1000 && uData.nudge_sent) {
                        delete uData.nudge_sent;
                        await this.activeDatabaseService.upsertUserData(u.chat_id, { data: uData });
                    }
                }
            } catch (err) {
                console.error('Error in nudge daemon check:', err.message);
            }
        };

        setInterval(check, intervalMs);
        setTimeout(check, 5000); // Trigger first check after 5s
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