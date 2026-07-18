const { MongoClient } = require('mongodb');
const settingsService = require('./settingsService');

class MongoService {
    constructor() {
        this.connections = {}; // Store active MongoClient instances by config ID
    }

    get configs() {
        return this.getConfigs();
    }

    getConfigs() {
        const settings = settingsService.getSettings();
        if (!settings.databases) {
            settings.databases = [];
        }
        return settings.databases;
    }

    async addConfig(config) {
        const id = config.id || `db_${Date.now()}`;
        const newConfig = {
            id,
            name: config.name || 'Unnamed DB',
            uri: config.uri,
            database: config.database || 'admin',
            category: config.category || 'Otros', // 'Usuarios Registros', 'Chat Logs', 'Otros'
            limitMb: parseFloat(config.limitMb) || 512, // Default Atlas M0 limit
        };
        const configs = this.getConfigs();
        configs.push(newConfig);
        settingsService.saveSettings({ databases: configs });
        return newConfig;
    }

    async removeConfig(id) {
        if (this.connections[id]) {
            try {
                await this.connections[id].close();
            } catch (err) {
                console.error(`Error closing connection for ${id}:`, err);
            }
            delete this.connections[id];
        }
        const configs = this.getConfigs().filter(c => c.id !== id);
        settingsService.saveSettings({ databases: configs });
        return true;
    }

    async connectClient(config) {
        if (this.connections[config.id]) {
            return this.connections[config.id];
        }

        try {
            const client = new MongoClient(config.uri, {
                connectTimeoutMS: 5000,
                socketTimeoutMS: 5000,
                tls: true
            });
            await client.connect();
            this.connections[config.id] = client;
            return client;
        } catch (error) {
            console.error(`Failed to connect to MongoDB [${config.name}]:`, error.message);
            throw error;
        }
    }

    async testConnection(uri) {
        try {
            const client = new MongoClient(uri, {
                connectTimeoutMS: 5000,
                socketTimeoutMS: 5000,
                tls: true
            });
            await client.connect();
            // Ping the database
            await client.db('admin').command({ ping: 1 });
            await client.close();
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async getDbStats(id) {
        const config = this.getConfigs().find(c => c.id === id);
        if (!config) {
            throw new Error(`Configuration not found for ID: ${id}`);
        }

        try {
            const client = await this.connectClient(config);
            const db = client.db(config.database);

            // Get dbStats
            const stats = await db.command({ dbStats: 1 });

            // Convert sizes to MB
            // Atlas dbStats returns dataSize and storageSize in bytes
            const dataSizeByte = stats.dataSize || 0;
            const storageSizeByte = stats.storageSize || 0;
            const dataSizeMb = parseFloat((dataSizeByte / (1024 * 1024)).toFixed(2));
            const storageSizeMb = parseFloat((storageSizeByte / (1024 * 1024)).toFixed(2));

            const limitMb = config.limitMb;
            const percentUsed = parseFloat(((storageSizeMb / limitMb) * 100).toFixed(2));

            return {
                id: config.id,
                name: config.name,
                category: config.category,
                database: config.database,
                status: 'Connected',
                storageSizeMb,
                dataSizeMb,
                limitMb,
                percentUsed: percentUsed > 100 ? 100 : percentUsed,
                collections: stats.collections || 0,
                objects: stats.objects || 0
            };
        } catch (error) {
            return {
                id: config.id,
                name: config.name,
                category: config.category,
                database: config.database,
                status: 'Disconnected',
                error: error.message,
                storageSizeMb: 0,
                dataSizeMb: 0,
                limitMb: config.limitMb,
                percentUsed: 0,
                collections: 0,
                objects: 0
            };
        }
    }

    async getAllDbStats() {
        const statsPromises = this.getConfigs().map(config => this.getDbStats(config.id));
        return await Promise.all(statsPromises);
    }

    // Dynamic storage methods based on category and dynamic routing
    async saveUserData(userData) {
        const settings = settingsService.getSettings();
        const routing = settings.databaseRouting || {};
        const dbId = routing.users;

        let config;
        if (dbId) {
            config = this.getConfigs().find(c => c.id === dbId);
        }
        if (!config) {
            config = this.getConfigs().find(c => c.category === 'Usuarios Registros');
        }
        if (!config) return null;

        try {
            const client = await this.connectClient(config);
            const db = client.db(config.database);
            const collection = db.collection('users');

            const result = await collection.updateOne(
                { chatId: userData.chatId },
                {
                    $set: {
                        userName: userData.userName,
                        phoneNumber: userData.phoneNumber,
                        updatedAt: new Date(),
                        data: userData.data || {},
                        tags: userData.tags || []
                    },
                    $setOnInsert: { createdAt: new Date() }
                },
                { upsert: true }
            );
            return result;
        } catch (error) {
            console.error('Error saving user data to MongoDB Atlas:', error.message);
        }
    }

    async saveChatLog(chatLog) {
        const settings = settingsService.getSettings();
        const routing = settings.databaseRouting || {};
        const dbId = routing.chatLogs;

        let config;
        if (dbId) {
            config = this.getConfigs().find(c => c.id === dbId);
        }
        if (!config) {
            config = this.getConfigs().find(c => c.category === 'Chat Logs');
        }
        if (!config) return null;

        try {
            const client = await this.connectClient(config);
            const db = client.db(config.database);
            const collection = db.collection('chat_logs');

            const result = await collection.insertOne({
                messageId: chatLog.messageId,
                chatId: chatLog.chatId,
                senderName: chatLog.senderName,
                messageContent: chatLog.messageContent,
                messageType: chatLog.messageType || 'text',
                responseContent: chatLog.responseContent || null,
                timestamp: new Date()
            });
            return result;
        } catch (error) {
            console.error('Error saving chat log to MongoDB Atlas:', error.message);
        }
    }
}

// Singleton pattern
module.exports = new MongoService();
