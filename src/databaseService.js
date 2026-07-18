const { MongoClient } = require('mongodb');

class DatabaseService {
    constructor(config) {
        this.config = config;
        this.client = null;
        this.db = null;
        this.initialized = false;
    }

    async initialize() {
        try {
            const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/wa_bot';

            // Extract dbName from URI or default to 'wa_bot'
            let dbName = 'wa_bot';
            try {
                const parsedUri = new URL(uri);
                if (parsedUri.pathname && parsedUri.pathname !== '/') {
                    dbName = parsedUri.pathname.substring(1).split('?')[0];
                }
            } catch (e) {
                const match = uri.match(/\/([^/?]+)(\?|$)/);
                if (match && match[1]) {
                    dbName = match[1];
                }
            }

            this.client = new MongoClient(uri, {
                connectTimeoutMS: 5000,
                socketTimeoutMS: 5000
            });
            await this.client.connect();
            this.db = this.client.db(dbName);

            console.log(`✅ MongoDB connected successfully to database: ${dbName}`);

            // Initialize collections and indexes
            await this.createTables();

            this.initialized = true;
            console.log('✅ Database initialized successfully with MongoDB');
            return true;
        } catch (error) {
            console.error('❌ Database initialization failed with MongoDB:', error);
            return false;
        }
    }

    async createTables() {
        try {
            const userData = this.db.collection('user_data');
            await userData.createIndex({ chat_id: 1 }, { unique: true });
            await userData.createIndex({ tags: 1 });
            await userData.createIndex({ updated_at: -1 });

            const messageLogs = this.db.collection('message_logs');
            await messageLogs.createIndex({ message_id: 1 }, { unique: true });
            await messageLogs.createIndex({ chat_id: 1 });
            await messageLogs.createIndex({ timestamp: 1 });

            const botCommands = this.db.collection('bot_commands');
            await botCommands.createIndex({ chat_id: 1 });

            console.log('✅ MongoDB collections and indexes initialized successfully');
        } catch (error) {
            console.error('❌ Error creating indexes in MongoDB:', error);
            throw error;
        }
    }

    // User data operations
    async upsertUserData(chatId, userData) {
        if (!this.initialized) throw new Error('Database not initialized');

        // Retrieve existing user data to perform a safe merge
        let existingData = {};
        let existingTags = [];
        let existingName = null;
        let existingPhone = null;
        try {
            const existing = await this.getUserData(chatId);
            if (existing) {
                existingData = existing.data_json || {};
                existingTags = existing.tags || [];
                existingName = existing.user_name;
                existingPhone = existing.phone_number;
            }
        } catch (err) {
            console.error('Error fetching existing user data for merge:', err);
        }

        const mergedData = { ...existingData, ...(userData.data || {}) };
        const mergedTags = [...new Set([...existingTags, ...(userData.tags || [])])];
        const finalName = userData.userName || existingName;
        const finalPhone = userData.phoneNumber || existingPhone;

        const collection = this.db.collection('user_data');
        try {
            await collection.updateOne(
                { chat_id: chatId },
                {
                    $set: {
                        user_name: finalName,
                        phone_number: finalPhone,
                        data_json: mergedData,
                        tags: mergedTags,
                        updated_at: new Date()
                    },
                    $setOnInsert: {
                        created_at: new Date()
                    }
                },
                { upsert: true }
            );
            return await this.getUserData(chatId);
        } catch (error) {
            console.error('Error upserting user data in MongoDB:', error);
            throw error;
        }
    }

    async getUserData(chatId) {
        if (!this.initialized) throw new Error('Database not initialized');
        const collection = this.db.collection('user_data');
        try {
            const user = await collection.findOne({ chat_id: chatId });
            if (user) {
                // Ensure field naming is fully compatible
                user.chatId = user.chat_id;
                user.phoneNumber = user.phone_number;
            }
            return user;
        } catch (error) {
            console.error('Error getting user data in MongoDB:', error);
            throw error;
        }
    }

    async getAllUserData(limit = 50, offset = 0) {
        if (!this.initialized) throw new Error('Database not initialized');
        const collection = this.db.collection('user_data');
        try {
            const users = await collection.find({})
                .sort({ updated_at: -1 })
                .skip(offset)
                .limit(limit)
                .toArray();

            return users.map(user => {
                user.chatId = user.chat_id;
                user.phoneNumber = user.phone_number;
                return user;
            });
        } catch (error) {
            console.error('Error getting all user data in MongoDB:', error);
            throw error;
        }
    }

    async searchUserData(searchTerm, searchField = 'all') {
        if (!this.initialized) throw new Error('Database not initialized');
        const collection = this.db.collection('user_data');
        let query = {};
        const regex = new RegExp(searchTerm, 'i');

        switch (searchField) {
            case 'name':
                query = { user_name: { $regex: regex } };
                break;
            case 'phone':
                query = { phone_number: { $regex: regex } };
                break;
            case 'tags':
                query = { tags: searchTerm };
                break;
            default: // all
                query = {
                    $or: [
                        { user_name: { $regex: regex } },
                        { phone_number: { $regex: regex } },
                        { tags: searchTerm }
                    ]
                };
        }

        try {
            const users = await collection.find(query).sort({ updated_at: -1 }).toArray();
            return users.map(user => {
                user.chatId = user.chat_id;
                user.phoneNumber = user.phone_number;
                return user;
            });
        } catch (error) {
            console.error('Error searching user data in MongoDB:', error);
            throw error;
        }
    }

    // Message logs operations
    async logMessage(messageData) {
        if (!this.initialized) throw new Error('Database not initialized');
        const collection = this.db.collection('message_logs');

        const doc = {
            message_id: messageData.messageId,
            chat_id: messageData.chatId,
            sender_name: messageData.senderName,
            message_content: messageData.messageContent,
            message_type: messageData.messageType || 'text',
            response_content: messageData.responseContent || null,
            timestamp: new Date(),
            processed: false
        };

        try {
            await collection.updateOne(
                { message_id: messageData.messageId },
                { $setOnInsert: doc },
                { upsert: true }
            );
            return await collection.findOne({ message_id: messageData.messageId });
        } catch (error) {
            console.error('Error logging message in MongoDB:', error);
            throw error;
        }
    }

    async getMessageStats() {
        if (!this.initialized) throw new Error('Database not initialized');
        const collection = this.db.collection('message_logs');

        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date();
        todayEnd.setHours(23, 59, 59, 999);

        try {
            const totalMessages = await collection.countDocuments({});
            const todayMessages = await collection.countDocuments({
                timestamp: { $gte: todayStart, $lte: todayEnd }
            });

            const uniqueUsersList = await collection.distinct('chat_id');
            const uniqueUsers = uniqueUsersList.length;

            const topChattersResult = await collection.aggregate([
                {
                    $match: {
                        timestamp: { $gte: todayStart, $lte: todayEnd }
                    }
                },
                {
                    $group: {
                        _id: '$chat_id',
                        message_count: { $sum: 1 }
                    }
                },
                {
                    $sort: { message_count: -1 }
                },
                {
                    $limit: 5
                },
                {
                    $project: {
                        _id: 0,
                        chat_id: '$_id',
                        message_count: 1
                    }
                }
            ]).toArray();

            return {
                totalMessages,
                todayMessages,
                uniqueUsers,
                topChatters: topChattersResult
            };
        } catch (error) {
            console.error('Error getting message stats in MongoDB:', error);
            throw error;
        }
    }

    // Command operations
    async logCommand(chatId, commandType, commandData) {
        if (!this.initialized) throw new Error('Database not initialized');
        const collection = this.db.collection('bot_commands');

        const doc = {
            chat_id: chatId,
            command_type: commandType,
            command_data: commandData,
            created_at: new Date(),
            processed: false
        };

        try {
            const result = await collection.insertOne(doc);
            return {
                _id: result.insertedId,
                ...doc
            };
        } catch (error) {
            console.error('Error logging command in MongoDB:', error);
            throw error;
        }
    }

    // Helper method to format data for display
    formatUserDataForDisplay(userData, index) {
        if (!userData) return '';

        const tags = userData.tags && userData.tags.length > 0 ? userData.tags.join(', ') : 'No tags';
        const data = userData.data_json || {};

        return `*${index}. ${userData.user_name || 'Unknown'}*
📱 ${userData.chat_id || userData.chatId}
📞 ${userData.phone_number || userData.phoneNumber || 'No phone'}
🏷️ Tags: ${tags}
📅 Last updated: ${new Date(userData.updated_at).toLocaleDateString()}
📊 Data: ${Object.keys(data).length > 0 ? JSON.stringify(data, null, 2).substring(0, 200) + '...' : 'No additional data'}

---`;
    }

    // Close database connection
    async close() {
        if (this.client) {
            await this.client.close();
            console.log('✅ MongoDB connection closed');
        }
    }
}

module.exports = DatabaseService;