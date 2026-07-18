const GroqService = require('./groqService');
const grokService = require('./grokService');
const MCPServer = require('./mcpServer');

class AIChatService {
    constructor(groqApiKey, databaseService, documentService, statusService) {
        this.groqService = new GroqService(groqApiKey);
        this.mcpServer = new MCPServer(databaseService, documentService, statusService);

        // Store services for tool execution
        this.databaseService = databaseService;
        this.documentService = documentService;
        this.statusService = statusService;

        // System prompt that explains the AI assistant's capabilities
        this.systemPrompt = `You are a helpful AI assistant for a WhatsApp bot that can help users with various database and document management tasks. You have access to tools that can:

1. **User Data Management:**
   - Search for users by name, phone number, or general query
   - Get all users with pagination
   - Browse users by tags
   - Get message statistics

2. **Document Management:**
   - Check document shortages for companies (PT)
   - Add document shortage information

3. **Work Status Management:**
   - Get work status reports for specific dates
   - Add new work status updates
   - Generate AI-formatted reports for management

When users ask questions or make requests in natural language (Indonesian or English), use the appropriate tools to help them. Always be helpful, polite, and provide clear responses.

**Guidelines:**
- If users ask for data searches, use the search_users tool
- If users ask for statistics, use the get_message_statistics tool
- If users mention checking "kekurangan" (shortages) for a PT, use check_document_shortage
- If users want to add shortages, use add_document_shortage
- If users ask for status reports or "laporan", use get_work_status or generate_ai_report
- If users want to add status updates, use add_work_status
- Always explain what you're doing in simple terms
- If tools are not available, suggest alternative solutions

**Common Indonesian phrases to recognize:**
- "cari data" / "search data" → use search_users
- "lihat statistik" / "tampilkan statistik" → use get_message_statistics
- "cek kekurangan PT [nama]" / "apa kekurangan PT [nama]" / "tampilkan kekurangan PT [nama]" → use check_document_shortage
- "tambah kekurangan" / "update kekurangan" / "tambahkan kekurangan" / "tambah update kekurangan" → use add_document_shortage
- "berikut kekurangan" / "ikut kekurangan" / "ini kekurangan" / "dibawah ini kekurangan" → use add_document_shortage
- "laporan status" / "lihat laporan" → use get_work_status
- "tambah status" → use add_work_status
- "tag" / "tags" → use browse_by_tags

Respond in the same language as the user (Indonesian or English). Be conversational and helpful!`;
    }

    getDynamicSystemPrompt(country = null) {
        const settings = global.aiSettings || {
            personality: {
                centralPrompt: "Eres un asistente de IA amigable y empático para WhatsApp. Te adaptas al tono de conversación del usuario.",
                tones: {
                    smiling: "Responde de manera alegre, entusiasta, con emojis sonrientes 😊 y palabras positivas.",
                    angry: "Mantén un tono serio, directo y firme, pero respetuoso. Evita rodeos.",
                    sad: "Responde con empatía profunda, tono suave y consolador, demostrando comprensión y apoyo.",
                    formal: "Sé extremadamente formal, profesional y educado en tu respuesta."
                },
                countryPersonalities: [],
                dictionary: [],
                rules: []
            }
        };

        let central = settings.personality.centralPrompt;
        const tones = settings.personality.tones || {};

        // 1. Incorporate country-specific personality if matched
        if (country && settings.personality && settings.personality.countryPersonalities && settings.personality.countryPersonalities.length > 0) {
            const matchedCP = settings.personality.countryPersonalities.find(cp =>
                cp.country && cp.country.toLowerCase() === country.toLowerCase()
            );
            if (matchedCP) {
                central += `\n\nCOUNTRY-SPECIFIC ADAPTATION FOR ${country.toUpperCase()}:\n${matchedCP.prompt}`;
            }
        }

        // 2. Incorporate dictionary/vocabulary rules
        let dictionaryPrompt = "";
        if (settings.personality && settings.personality.dictionary && settings.personality.dictionary.length > 0) {
            dictionaryPrompt = `\n\nVOCABULARY AND LOCAL PHRASES: You can and should enrich your messages with these terms/phrases where appropriate: ${settings.personality.dictionary.join(', ')}`;
        }

        // 3. Incorporate rules & laws variants
        let rulesPrompt = "";
        if (settings.rules && settings.rules.length > 0) {
            rulesPrompt = `\n\nRULES AND LAWS FOR BUSINESS LOGIC:\n`;
            settings.rules.forEach(rule => {
                if (rule.variants && rule.variants.length > 0) {
                    rule.variants.forEach(variant => {
                        rulesPrompt += `- [Section: ${rule.fieldName}] (${variant.name}): ${variant.text}\n`;
                    });
                }
            });
        }

        return `SYSTEM DIRECTIVES & PERSONALITY:
${central}
${dictionaryPrompt}
${rulesPrompt}

DYNAMIC TONE ADAPTATION INSTRUCTIONS:
Analyze the user's message tone or emotional state. You must adopt the matching sub-personality tone below for your reply:
- If the user is expressing anger, frustration, or severe directness: Adhere to the ANGRY/SERIOUS tone: "${tones.angry || ''}"
- If the user is expressing sadness, grief, vulnerability, or hurt: Adhere to the SAD/EMPATHETIC tone: "${tones.sad || ''}"
- If the user is speaking in a very formal, business, or strictly professional manner: Adhere to the FORMAL tone: "${tones.formal || ''}"
- For all other friendly, neutral, or enthusiastic conversations: Adhere to the SMILING/HAPPY tone: "${tones.smiling || ''}"

Ensure your core helpfulness, capabilities, and language preference are preserved.

${this.systemPrompt}`;
    }

    async processMessage(userMessage, conversationHistory = [], country = null) {
        try {
            const dynamicPrompt = this.getDynamicSystemPrompt(country);

            // Prepare conversation history with system prompt
            const messages = [
                { role: 'system', content: dynamicPrompt },
                ...conversationHistory.slice(-10), // Keep last 10 messages for context
                { role: 'user', content: userMessage }
            ];

            // Check if the message seems to require database operations
            const needsTools = this.checkIfToolsNeeded(userMessage);

            if (needsTools) {
                return await this.processWithTools(userMessage, messages);
            } else {
                let response;
                // Dynamically route between Grok xAI and Groq
                if (grokService.isEnabled() && grokService.getClient()) {
                    console.log('🤖 Routing chat request to Grok xAI with custom personality...');
                    response = await grokService.chatCompletion(messages);
                } else {
                    console.log('🤖 Routing chat request to Groq API with custom personality...');
                    response = await this.groqService.chatCompletion(messages);
                }

                if (response.success) {
                    return {
                        success: true,
                        content: response.content,
                        usedTools: false
                    };
                } else {
                    return {
                        success: false,
                        error: response.error,
                        usedTools: false
                    };
                }
            }
        } catch (error) {
            console.error('Error in AI chat service:', error);
            return {
                success: false,
                error: 'Maaf, terjadi kesalahan saat memproses pesan Anda. Silakan coba lagi.',
                usedTools: false
            };
        }
    }

    checkIfToolsNeeded(message) {
        const toolKeywords = [
            // Indonesian keywords - comprehensive
            'cari', 'search', 'data', 'pengguna', 'user', 'statistik', 'statistics',
            'kekurangan', 'document', 'dokumen', 'pt', 'perusahaan', 'company',
            'laporan', 'report', 'status', 'kerja', 'work',
            'tambah', 'tambahkan', 'update', 'tambah update', 'insert', 'add',
            'berikut', 'ikut', 'ini', 'dibawah ini', 'berikut adalah', 'missing', 'hilang',
            'cek', 'check', 'apa', 'tampilkan', 'lihat', 'show',
            'tag', 'tags', 'pesan', 'message', 'semua', 'all',

            // English keywords
            'find', 'show', 'get', 'list', 'check', 'update', 'create', 'missing', 'what'
        ];

        const lowerMessage = message.toLowerCase();
        return toolKeywords.some(keyword => lowerMessage.includes(keyword));
    }

    async processWithTools(userMessage, conversationHistory) {
        try {
            // For now, we'll simulate tool usage by parsing the message and calling appropriate methods
            // In a full MCP implementation, this would involve the actual MCP protocol

            const toolResult = await this.parseAndExecuteTool(userMessage);

            if (toolResult.success) {
                // Format the tool result into a natural language response
                const formattedResponse = await this.formatToolResponse(userMessage, toolResult.data);

                return {
                    success: true,
                    content: formattedResponse,
                    usedTools: true,
                    toolData: toolResult.data
                };
            } else {
                return {
                    success: false,
                    error: toolResult.error,
                    usedTools: true
                };
            }
        } catch (error) {
            console.error('Error processing with tools:', error);
            return {
                success: false,
                error: 'Maaf, terjadi kesalahan saat menggunakan alat. Silakan coba lagi.',
                usedTools: true
            };
        }
    }

    async parseAndExecuteTool(message) {
        const lowerMessage = message.toLowerCase();

        try {
            // ADD DOCUMENT SHORTAGE - Check this first to prioritize "tambah" over "cek"
            // Comprehensive patterns for adding documents
            const addPatterns = [
                // Direct patterns
                (lowerMessage.includes('tambah') || lowerMessage.includes('tambahkan') || lowerMessage.includes('update') || lowerMessage.includes('insert') || lowerMessage.includes('add')) &&
                (lowerMessage.includes('kekurangan') || lowerMessage.includes('document') || lowerMessage.includes('dokumen')),

                // "Berikut kekurangan" patterns
                (lowerMessage.includes('berikut') || lowerMessage.includes('ikut') || lowerMessage.includes('ini') || lowerMessage.includes('dibawah ini')) &&
                (lowerMessage.includes('kekurangan') || lowerMessage.includes('document') || lowerMessage.includes('dokumen')),

                // "Missing" patterns
                lowerMessage.includes('missing') || lowerMessage.includes('hilang')
            ];

            if (addPatterns.some(pattern => pattern)) {
                const parsedData = this.parseAndAddDocumentShortage(message);
                if (parsedData.success) {
                    return await this.executeTool('add_document_shortage', parsedData.data);
                } else {
                    return parsedData;
                }
            }

            // CHECK DOCUMENT SHORTAGE - Comprehensive patterns for checking documents
            const checkPatterns = [
                // Question patterns
                (lowerMessage.includes('apa') || lowerMessage.includes('what')) &&
                (lowerMessage.includes('kekurangan') || lowerMessage.includes('missing')),

                // Direct check patterns
                (lowerMessage.includes('cek') || lowerMessage.includes('check') || lowerMessage.includes('tampilkan') || lowerMessage.includes('lihat') || lowerMessage.includes('show')) &&
                lowerMessage.includes('kekurangan'),

                // PT + kekurangan pattern (general)
                lowerMessage.includes('pt') && lowerMessage.includes('kekurangan')
            ];

            if (checkPatterns.some(pattern => pattern)) {
                const ptMatch = message.match(/pt\s+([a-zA-Z\s0-9]+)/i);
                if (ptMatch) {
                    const ptName = ptMatch[1].trim();
                    return await this.executeTool('check_document_shortage', { ptName });
                }
            }

            // Search users
            if (lowerMessage.includes('cari') || lowerMessage.includes('search')) {
                const searchMatch = message.match(/cari\s+(.+)|search\s+(.+)/i);
                if (searchMatch) {
                    const query = (searchMatch[1] || searchMatch[2]).trim();
                    return await this.executeTool('search_users', { query });
                }
            }

            // Get statistics
            if (lowerMessage.includes('statistik') || lowerMessage.includes('statistics')) {
                return await this.executeTool('get_message_statistics', {});
            }

            // Get work status
            if (lowerMessage.includes('laporan') || lowerMessage.includes('status') || lowerMessage.includes('report')) {
                let date = 'today';
                if (lowerMessage.includes('kemarin') || lowerMessage.includes('yesterday')) {
                    date = 'kemarin';
                } else if (lowerMessage.includes('besok') || lowerMessage.includes('tomorrow')) {
                    date = 'besok';
                }

                const dateMatch = message.match(/(\d{2}\/\d{2}\/\d{4})/);
                if (dateMatch) {
                    date = dateMatch[1];
                }

                return await this.executeTool('get_work_status', { date });
            }

            // Add work status
            if ((lowerMessage.includes('tambah') && lowerMessage.includes('status')) ||
                (lowerMessage.includes('add') && lowerMessage.includes('status'))) {
                return this.parseAndAddWorkStatus(message);
            }

            // Browse by tags
            if (lowerMessage.includes('tag')) {
                const tagMatch = message.match(/tag\s+([a-zA-Z]+)/i);
                if (tagMatch) {
                    const tagName = tagMatch[1].trim();
                    return await this.executeTool('browse_by_tags', { tagName });
                } else {
                    return await this.executeTool('browse_by_tags', {});
                }
            }

            // Get all users
            if ((lowerMessage.includes('semua') && lowerMessage.includes('user')) ||
                (lowerMessage.includes('lihat') && (lowerMessage.includes('semua') || lowerMessage.includes(' semua '))) ||
                lowerMessage.includes('show all users') ||
                lowerMessage.includes('get all users')) {
                return await this.executeTool('get_all_users', { limit: 20 });
            }

            return {
                success: false,
                error: 'Saya tidak mengerti permintaan Anda. Silakan coba dengan kata kunci seperti: "cari data", "lihat statistik", "cek kekurangan PT", "laporan status", dll.'
            };

        } catch (error) {
            console.error('Error executing tool:', error);
            return {
                success: false,
                error: 'Terjadi kesalahan saat mengeksekusi permintaan Anda.'
            };
        }
    }

    parseAndAddDocumentShortage(message) {
        // Parse message for PT name, work type, and shortage items
        // Support multiple formats:
        // 1. "!p tambahkan kekurangan PT merdeka 1. KTP 2.NPWP"
        // 2. "update kekurangan PT [nama]: [jenis]: [item1], [item2]"
        // 3. "berikut kekurangan PT [nama]: KTP, NPWP, Passport"
        // 4. "PT Maju Bersama kekurangan: 1. KTP 2. Paspor 3. SK"
        // 5. "missing documents PT Test: KTP, NPWP"
        // 6. "ikut kekurangan PT Contoh - KTP - Paspor - Visa"

        // Remove command prefix first
        let cleanMessage = message.replace(/^!p\s+/i, '');

        // Remove common prefixes
        cleanMessage = cleanMessage.replace(/^(tambah|tambahkan|update|insert|add)\s+/i, '');
        cleanMessage = cleanMessage.replace(/^(berikut|ikut|ini|dibawah\s+ini)\s+/i, '');

        const ptMatch = cleanMessage.match(/pt\s+([a-zA-Z\s0-9]+?)(?=\s*(?:kekurangan|:|;|$|\d\.|[-,]))/i);

        if (!ptMatch) {
            return {
                success: false,
                error: 'Format tidak valid. Gunakan: "Tambah kekurangan PT [nama] [daftar item]"'
            };
        }

        const ptName = ptMatch[1].trim();

        // Extract everything after PT name
        const afterPT = cleanMessage.substring(cleanMessage.indexOf(ptName) + ptName.length).trim();

        // Remove any separator words
        let processedAfterPT = afterPT
            .replace(/^kekurangan\s*/i, '')
            .replace(/^kekurangan:\s*/i, '')
            .replace(/^:\s*/, '');

        let kekurangan = [];
        let jenisPekerjaan = 'Tidak Spesifik';

        // Try different parsing methods in order of preference

        // Method 1: Colon format - "PT [nama]: [jenis]: [item1], [item2]"
        if (processedAfterPT.includes(':')) {
            const parts = processedAfterPT.split(':').map(part => part.trim());

            if (parts.length >= 2) {
                // Check if first part looks like a work type (common work types)
                const workTypes = ['ppiU', 'umroh', 'haji', 'visa', 'tiket', 'paspor', 'passport'];
                const firstPart = parts[0].toLowerCase();

                if (workTypes.some(type => firstPart.includes(type)) || parts.length > 2) {
                    jenisPekerjaan = parts[0] || 'Tidak Spesifik';
                    const kekuranganText = parts.slice(1).join(':').trim();
                    kekurangan = this.parseKekuranganItems(kekuranganText);
                } else {
                    // All parts are kekurangan items
                    const kekuranganText = processedAfterPT;
                    kekurangan = this.parseKekuranganItems(kekuranganText);
                }
            } else {
                kekurangan = this.parseKekuranganItems(processedAfterPT);
            }
        }
        // Method 2: Numbered format - "PT [nama] 1. KTP 2. NPWP"
        else if (processedAfterPT.match(/\d+\./)) {
            const numberedItems = processedAfterPT.match(/\d+\.\s*([^0-9]+)/g);
            if (numberedItems && numberedItems.length > 0) {
                kekurangan = numberedItems.map(item =>
                    item.replace(/^\d+\.\s*/, '').trim()
                ).filter(item => item.length > 0);
            }
        }
        // Method 3: Dash format - "PT [nama] - KTP - NPWP - Passport"
        else if (processedAfterPT.includes('-')) {
            kekurangan = processedAfterPT
                .split(/[-]\s*/)
                .map(item => item.trim())
                .filter(item => item.length > 0);
        }
        // Method 4: Comma format - "PT [nama] KTP, NPWP, Passport"
        else if (processedAfterPT.includes(',')) {
            kekurangan = processedAfterPT
                .split(/[,]\s*/)
                .map(item => item.trim())
                .filter(item => item.length > 0);
        }
        // Method 5: Space separated - "PT [nama] KTP NPWP Passport"
        else {
            kekurangan = processedAfterPT
                .split(/\s+/)
                .map(item => item.trim())
                .filter(item => item.length > 0 && !item.toLowerCase().includes('kekurangan'));
        }

        if (kekurangan.length === 0) {
            return {
                success: false,
                error: 'Item kekurangan harus diisi. Contoh: "PT merdeka 1. KTP 2. NPWP"'
            };
        }

        return {
            success: true,
            tool: 'add_document_shortage',
            data: {
                ptName,
                jenisPekerjaan,
                kekurangan,
                reportedBy: 'User' // This would be passed from the actual user
            }
        };
    }

    // Helper method to parse kekurangan items from text
    parseKekuranganItems(text) {
        if (!text) return [];

        // Handle multiple separators: comma, semicolon, numbered list
        let items = text
            .split(/[,;]|\d+\.\s*/)
            .map(item => item.trim())
            .filter(item => item.length > 0);

        // If no items found, try splitting by spaces for simple formats
        if (items.length === 1) {
            items = text
                .split(/\s+/)
                .map(item => item.trim())
                .filter(item => item.length > 0);
        }

        // Clean up each item
        return items.map(item => {
            // Remove leading symbols
            item = item.replace(/^[-:•]\s*/, '');
            // Remove trailing symbols
            item = item.replace(/[-:•]$/, '');
            return item.trim();
        }).filter(item => item.length > 0);
    }

    parseAndAddWorkStatus(message) {
        // Extract status text after "tambah status" or "add status"
        const statusMatch = message.match(/(?:tambah|add)\s+status\s+(.+)/i);

        if (!statusMatch) {
            return {
                success: false,
                error: 'Format tidak valid. Gunakan: "Tambah status [teks status]"'
            };
        }

        const statusText = statusMatch[1].trim();

        return {
            success: true,
            tool: 'add_work_status',
            data: {
                statusText,
                reportedBy: 'User' // This would be passed from the actual user
            }
        };
    }

    async executeTool(toolName, args) {
        console.log(`Executing tool: ${toolName} with args:`, args);

        try {
            switch (toolName) {
                case 'search_users':
                    return await this.executeSearchUsers(args);

                case 'get_all_users':
                    return await this.executeGetAllUsers(args);

                case 'get_message_statistics':
                    return await this.executeGetMessageStatistics(args);

                case 'browse_by_tags':
                    return await this.executeBrowseByTags(args);

                case 'check_document_shortage':
                    return await this.executeCheckDocumentShortage(args);

                case 'add_document_shortage':
                    return await this.executeAddDocumentShortage(args);

                case 'get_work_status':
                    return await this.executeGetWorkStatus(args);

                case 'add_work_status':
                    return await this.executeAddWorkStatus(args);

                case 'generate_ai_report':
                    return await this.executeGenerateAIReport(args);

                default:
                    return {
                        success: false,
                        error: `Unknown tool: ${toolName}`
                    };
            }
        } catch (error) {
            console.error(`Error executing tool ${toolName}:`, error);
            return {
                success: false,
                error: `Error executing ${toolName}: ${error.message}`
            };
        }
    }

    async executeSearchUsers(args) {
        if (!this.databaseService || !this.databaseService.initialized) {
            return {
                success: false,
                error: 'Database service is not available. Please try again later.'
            };
        }

        const results = await this.databaseService.searchUserData(args.query, args.searchType || 'all');

        if (results.length === 0) {
            return {
                success: true,
                tool: 'search_users',
                data: {
                    message: `No users found for "${args.query}".`,
                    results: []
                }
            };
        }

        let response = `Found ${results.length} user(s) for "${args.query}":\n\n`;

        results.forEach((user, index) => {
            const tags = user.tags && user.tags.length > 0 ? user.tags.join(', ') : 'No tags';
            const data = user.data_json || {};
            response += `${index + 1}. ${user.user_name || 'Unknown'}\n`;

            if (user.phone_number && !user.phone_number.includes('@')) {
                response += `   Phone: ${user.phone_number}\n`;
            }

            if (data.department) {
                response += `   Department: ${data.department}\n`;
            }

            response += `   Tags: ${tags}\n\n`;
        });

        return {
            success: true,
            tool: 'search_users',
            data: {
                message: response,
                results: results
            }
        };
    }

    async executeGetAllUsers(args) {
        if (!this.databaseService || !this.databaseService.initialized) {
            return {
                success: false,
                error: 'Database service is not available. Please try again later.'
            };
        }

        const users = await this.databaseService.getAllUserData(args.limit || 20, args.offset || 0);

        if (users.length === 0) {
            return {
                success: true,
                tool: 'get_all_users',
                data: {
                    message: 'No users found in the database.',
                    results: []
                }
            };
        }

        let response = `Showing ${users.length} user(s):\n\n`;

        users.forEach((user, index) => {
            const tags = user.tags && user.tags.length > 0 ? user.tags.join(', ') : 'No tags';
            const data = user.data_json || {};
            response += `${index + 1}. ${user.user_name || 'Unknown'}\n`;

            if (user.phone_number && !user.phone_number.includes('@')) {
                response += `   Phone: ${user.phone_number}\n`;
            }

            if (data.department) {
                response += `   Department: ${data.department}\n`;
            }

            response += `   Tags: ${tags}\n\n`;
        });

        return {
            success: true,
            tool: 'get_all_users',
            data: {
                message: response,
                results: users
            }
        };
    }

    async executeGetMessageStatistics(args) {
        if (!this.databaseService || !this.databaseService.initialized) {
            return {
                success: false,
                error: 'Database service is not available. Please try again later.'
            };
        }

        const stats = await this.databaseService.getMessageStats();

        let response = `Message Statistics:\n\n`;
        response += `Total Messages: ${stats.totalMessages}\n`;
        response += `Messages Today: ${stats.todayMessages}\n`;
        response += `Unique Users: ${stats.uniqueUsers}\n\n`;

        if (stats.topChatters && stats.topChatters.length > 0) {
            response += `Top Chatters Today:\n`;
            stats.topChatters.forEach((user, index) => {
                response += `${index + 1}. ${user.chat_id}: ${user.message_count} messages\n`;
            });
        }

        return {
            success: true,
            tool: 'get_message_statistics',
            data: {
                message: response,
                stats: stats
            }
        };
    }

    async executeBrowseByTags(args) {
        if (!this.databaseService || !this.databaseService.initialized) {
            return {
                success: false,
                error: 'Database service is not available. Please try again later.'
            };
        }

        if (args.tagName) {
            const results = await this.databaseService.searchUserData(args.tagName, 'tags');

            if (results.length === 0) {
                return {
                    success: true,
                    tool: 'browse_by_tags',
                    data: {
                        message: `No users found with tag "${args.tagName}".`,
                        results: []
                    }
                };
            }

            let response = `Found ${results.length} user(s) with tag "${args.tagName}":\n\n`;

            results.forEach((user, index) => {
                const tags = user.tags && user.tags.length > 0 ? user.tags.join(', ') : 'No tags';
                response += `${index + 1}. ${user.user_name || 'Unknown'}\n`;
                response += `   Tags: ${tags}\n\n`;
            });

            return {
                success: true,
                tool: 'browse_by_tags',
                data: {
                    message: response,
                    results: results
                }
            };
        } else {
            const users = await this.databaseService.getAllUserData(100, 0);
            const tagCounts = {};

            users.forEach(user => {
                if (user.tags && Array.isArray(user.tags)) {
                    user.tags.forEach(tag => {
                        if (tag && tag.trim()) {
                            tagCounts[tag] = (tagCounts[tag] || 0) + 1;
                        }
                    });
                }
            });

            const sortedTags = Object.entries(tagCounts)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 20);

            if (sortedTags.length === 0) {
                return {
                    success: true,
                    tool: 'browse_by_tags',
                    data: {
                        message: 'No tags found in the database.',
                        results: []
                    }
                };
            }

            let response = `Popular Tags:\n\n`;

            sortedTags.forEach(([tag, count], index) => {
                response += `${index + 1}. ${tag} (${count} users)\n`;
            });

            return {
                success: true,
                tool: 'browse_by_tags',
                data: {
                    message: response,
                    results: sortedTags
                }
            };
        }
    }

    async executeCheckDocumentShortage(args) {
        if (!this.documentService || !this.documentService.initialized) {
            return {
                success: false,
                error: 'Document service is not available. Please try again later.'
            };
        }

        const results = await this.documentService.searchDocuments(args.ptName.trim());

        if (results.length === 0) {
            return {
                success: true,
                tool: 'check_document_shortage',
                data: {
                    message: `No documents found for PT "${args.ptName}".`,
                    results: []
                }
            };
        }

        const kekuranganDocs = results.filter(doc => doc.document_type === 'Kekurangan Dokumen');

        let response = `Document shortage for "${args.ptName}":\n\n`;

        if (kekuranganDocs.length > 0) {
            kekuranganDocs.forEach((doc, index) => {
                response += `${index + 1}. ${doc.description}\n`;
                response += `   Reported by: ${doc.created_by}\n`;
                response += `   Date: ${new Date(doc.created_at).toLocaleDateString()}\n\n`;
            });
        } else {
            response += 'No document shortages found.\n\n';
            response += 'Available documents:\n';
            results.forEach((doc, index) => {
                response += `${index + 1}. ${doc.document_type}: ${doc.document_name}\n`;
            });
        }

        return {
            success: true,
            tool: 'check_document_shortage',
            data: {
                message: response,
                results: kekuranganDocs
            }
        };
    }

    async executeAddDocumentShortage(args) {
        if (!this.documentService || !this.documentService.initialized) {
            return {
                success: false,
                error: 'Document service is not available. Please try again later.'
            };
        }

        const documentData = {
            documentType: 'Kekurangan Dokumen',
            documentName: `Kekurangan ${args.jenisPekerjaan || 'Tidak Spesifik'} - ${new Date().toLocaleDateString()}`,
            description: `Jenis Pekerjaan: ${args.jenisPekerjaan || 'Tidak Spesifik'}\nKekurangan: ${args.kekurangan.join('; ')}`,
            createdBy: args.reportedBy,
            tags: ['kekurangan', 'update', (args.jenisPekerjaan || '').toLowerCase(), args.reportedBy.toLowerCase()]
        };

        await this.documentService.addDocument(args.ptName, documentData);

        const response = `Document shortage added successfully for "${args.ptName}":\n\n` +
            `Type: Kekurangan Dokumen\n` +
            `Work Type: ${args.jenisPekerjaan || 'Tidak Spesifik'}\n` +
            `Missing Items: ${args.kekurangan.join(', ')}\n` +
            `Reported by: ${args.reportedBy}\n` +
            `Date: ${new Date().toLocaleDateString()}`;

        return {
            success: true,
            tool: 'add_document_shortage',
            data: {
                message: response
            }
        };
    }

    async executeGetWorkStatus(args) {
        if (!this.statusService || !this.statusService.initialized) {
            return {
                success: false,
                error: 'Status service is not available. Please try again later.'
            };
        }

        let targetDate;
        try {
            if (args.date.toLowerCase() === 'today' || args.date === 'today') {
                targetDate = new Date().toISOString().split('T')[0];
            } else if (args.date.toLowerCase() === 'kemarin') {
                const yesterday = new Date();
                yesterday.setDate(yesterday.getDate() - 1);
                targetDate = yesterday.toISOString().split('T')[0];
            } else if (args.date.toLowerCase() === 'besok') {
                const tomorrow = new Date();
                tomorrow.setDate(tomorrow.getDate() + 1);
                targetDate = tomorrow.toISOString().split('T')[0];
            } else {
                const parts = args.date.split('/');
                if (parts.length === 3) {
                    targetDate = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
                } else {
                    throw new Error('Invalid date format');
                }
            }
        } catch (error) {
            return {
                success: false,
                error: 'Invalid date format. Use DD/MM/YYYY or "today", "kemarin", "besok".'
            };
        }

        const statusList = await this.statusService.getStatusByDate(targetDate);

        if (statusList.length === 0) {
            return {
                success: true,
                tool: 'get_work_status',
                data: {
                    message: `No work status found for ${targetDate}.`,
                    results: []
                }
            };
        }

        let response = `Work Status for ${targetDate}:\n\n`;

        statusList.forEach((status, index) => {
            response += `${index + 1}. ${status.status_text}\n`;
            response += `   By: ${status.created_by}\n`;
            response += `   Time: ${new Date(status.created_at).toLocaleTimeString()}\n\n`;
        });

        return {
            success: true,
            tool: 'get_work_status',
            data: {
                message: response,
                results: statusList
            }
        };
    }

    async executeAddWorkStatus(args) {
        if (!this.statusService || !this.statusService.initialized) {
            return {
                success: false,
                error: 'Status service is not available. Please try again later.'
            };
        }

        const status = await this.statusService.addStatus(
            args.statusText,
            args.reportedBy,
            ['user-added', 'manual-update']
        );

        const response = `Work status added successfully:\n\n` +
            `Status: ${status.status_text}\n` +
            `Reported by: ${args.reportedBy}\n` +
            `Date: ${new Date().toLocaleDateString()}\n` +
            `Time: ${new Date().toLocaleTimeString()}`;

        return {
            success: true,
            tool: 'add_work_status',
            data: {
                message: response
            }
        };
    }

    async executeGenerateAIReport(args) {
        return {
            success: true,
            tool: 'generate_ai_report',
            data: {
                message: `AI report generation requested by ${args.requestedBy} for ${args.date}. This feature would integrate with your existing StatusAIService to generate formatted reports for management.`
            }
        };
    }

    async formatToolResponse(originalMessage, toolData) {
        // Format the tool result into a natural, helpful response
        const toolName = toolData.tool;
        const result = toolData.data?.message || toolData.message || 'No data available';

        switch (toolName) {
            case 'check_document_shortage':
                return `📋 **Hasil Pencarian Kekurangan Dokumen**\n\n${result}`;

            case 'add_document_shortage':
                return `✅ **Kekurangan Dokumen Berhasil Ditambahkan**\n\n${result}`;

            case 'search_users':
                return `🔍 **Hasil Pencarian Pengguna**\n\n${result}`;

            case 'get_message_statistics':
                return `📊 **Statistik Pesan**\n\n${result}`;

            case 'get_work_status':
                return `📋 **Laporan Status Pekerjaan**\n\n${result}`;

            case 'add_work_status':
                return `✅ **Status Berhasil Ditambahkan**\n\n${result}`;

            case 'browse_by_tags':
                return `🏷️ **Hasil Pencarian berdasarkan Tag**\n\n${result}`;

            case 'get_all_users':
                return `👥 **Daftar Pengguna**\n\n${result}`;

            case 'generate_ai_report':
                return `📊 **Laporan AI**\n\n${result}`;

            default:
                return result; // Just return the result directly for better flow
        }
    }

    // Helper method to get conversation context for better AI responses
    getContextualPrompt(userMessage, conversationHistory) {
        const recentContext = conversationHistory.slice(-3).map(msg =>
            `${msg.role}: ${msg.content}`
        ).join('\n');

        return `${this.systemPrompt}\n\nRecent conversation:\n${recentContext}\n\nUser: ${userMessage}`;
    }
}

module.exports = AIChatService;