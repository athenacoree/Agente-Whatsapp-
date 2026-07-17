const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

class DatabaseService {
    constructor(config) {
        this.config = config;
        this.pool = null;
        this.initialized = false;
    }

    async initialize() {
        try {
            // PostgreSQL connection
            this.pool = new Pool({
                host: process.env.DB_HOST || 'localhost',
                port: process.env.DB_PORT || 5432,
                database: process.env.DB_NAME || 'wa_bot',
                user: process.env.DB_USER || 'postgres',
                password: process.env.DB_PASSWORD || 'password',
                max: 20,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 2000,
            });

            // Test connection
            const client = await this.pool.connect();
            await client.query('SELECT NOW()');
            client.release();

            console.log('✅ PostgreSQL connected successfully');

            // Initialize tables
            await this.createTables();

            this.initialized = true;
            console.log('✅ Database initialized successfully');
            return true;
        } catch (error) {
            console.error('❌ Database initialization failed:', error);
            return false;
        }
    }

    async createTables() {
        const createTablesQuery = `
            -- User data table
            CREATE TABLE IF NOT EXISTS user_data (
                id SERIAL PRIMARY KEY,
                chat_id VARCHAR(255) NOT NULL,
                user_name VARCHAR(255),
                phone_number VARCHAR(50),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                data_json JSONB,
                tags TEXT[],
                UNIQUE(chat_id)
            );

            -- Message logs table
            CREATE TABLE IF NOT EXISTS message_logs (
                id SERIAL PRIMARY KEY,
                message_id VARCHAR(255) UNIQUE,
                chat_id VARCHAR(255) NOT NULL,
                sender_name VARCHAR(255),
                message_content TEXT,
                message_type VARCHAR(50) DEFAULT 'text',
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                processed BOOLEAN DEFAULT FALSE,
                response_content TEXT
            );

            -- Bot commands table
            CREATE TABLE IF NOT EXISTS bot_commands (
                id SERIAL PRIMARY KEY,
                chat_id VARCHAR(255) NOT NULL,
                command_type VARCHAR(100) NOT NULL,
                command_data JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                processed BOOLEAN DEFAULT FALSE
            );

            -- Create indexes for better performance
            CREATE INDEX IF NOT EXISTS idx_user_data_chat_id ON user_data(chat_id);
            CREATE INDEX IF NOT EXISTS idx_message_logs_chat_id ON message_logs(chat_id);
            CREATE INDEX IF NOT EXISTS idx_message_logs_timestamp ON message_logs(timestamp);
            CREATE INDEX IF NOT EXISTS idx_bot_commands_chat_id ON bot_commands(chat_id);
            CREATE INDEX IF NOT EXISTS idx_user_data_tags ON user_data USING GIN(tags);
            CREATE INDEX IF NOT EXISTS idx_user_data_data_json ON user_data USING GIN(data_json);
        `;

        try {
            await this.pool.query(createTablesQuery);
            console.log('✅ Database tables created successfully');
        } catch (error) {
            console.error('❌ Error creating tables:', error);
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

        const query = `
            INSERT INTO user_data (chat_id, user_name, phone_number, data_json, tags)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (chat_id)
            DO UPDATE SET
                user_name = EXCLUDED.user_name,
                phone_number = EXCLUDED.phone_number,
                data_json = EXCLUDED.data_json,
                tags = EXCLUDED.tags,
                updated_at = CURRENT_TIMESTAMP
            RETURNING *
        `;

        const values = [
            chatId,
            finalName,
            finalPhone,
            JSON.stringify(mergedData),
            mergedTags
        ];

        try {
            const result = await this.pool.query(query, values);
            return result.rows[0];
        } catch (error) {
            console.error('Error upserting user data:', error);
            throw error;
        }
    }

    async getUserData(chatId) {
        if (!this.initialized) throw new Error('Database not initialized');

        const query = 'SELECT * FROM user_data WHERE chat_id = $1';

        try {
            const result = await this.pool.query(query, [chatId]);
            return result.rows[0] || null;
        } catch (error) {
            console.error('Error getting user data:', error);
            throw error;
        }
    }

    async getAllUserData(limit = 50, offset = 0) {
        if (!this.initialized) throw new Error('Database not initialized');

        const query = `
            SELECT chat_id, user_name, phone_number, created_at, updated_at, tags
            FROM user_data
            ORDER BY updated_at DESC
            LIMIT $1 OFFSET $2
        `;

        try {
            const result = await this.pool.query(query, [limit, offset]);
            return result.rows;
        } catch (error) {
            console.error('Error getting all user data:', error);
            throw error;
        }
    }

    async searchUserData(searchTerm, searchField = 'all') {
        if (!this.initialized) throw new Error('Database not initialized');

        let query;
        let values = [];

        switch (searchField) {
            case 'name':
                query = `SELECT * FROM user_data WHERE user_name ILIKE $1 ORDER BY updated_at DESC`;
                values = [`%${searchTerm}%`];
                break;
            case 'phone':
                query = `SELECT * FROM user_data WHERE phone_number ILIKE $1 ORDER BY updated_at DESC`;
                values = [`%${searchTerm}%`];
                break;
            case 'tags':
                query = `SELECT * FROM user_data WHERE $1 = ANY(tags) ORDER BY updated_at DESC`;
                values = [searchTerm];
                break;
            default: // all
                query = `
                    SELECT * FROM user_data
                    WHERE user_name ILIKE $1 OR phone_number ILIKE $1 OR $1 = ANY(tags)
                    ORDER BY updated_at DESC
                `;
                values = [`%${searchTerm}%`];
        }

        try {
            const result = await this.pool.query(query, values);
            return result.rows;
        } catch (error) {
            console.error('Error searching user data:', error);
            throw error;
        }
    }

    // Message logs operations
    async logMessage(messageData) {
        if (!this.initialized) throw new Error('Database not initialized');

        const query = `
            INSERT INTO message_logs (message_id, chat_id, sender_name, message_content, message_type, response_content)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (message_id) DO NOTHING
            RETURNING *
        `;

        const values = [
            messageData.messageId,
            messageData.chatId,
            messageData.senderName,
            messageData.messageContent,
            messageData.messageType || 'text',
            messageData.responseContent || null
        ];

        try {
            const result = await this.pool.query(query, values);
            return result.rows[0];
        } catch (error) {
            console.error('Error logging message:', error);
            throw error;
        }
    }

    async getMessageStats() {
        if (!this.initialized) throw new Error('Database not initialized');

        const queries = {
            totalMessages: 'SELECT COUNT(*) as count FROM message_logs',
            todayMessages: 'SELECT COUNT(*) as count FROM message_logs WHERE DATE(timestamp) = CURRENT_DATE',
            uniqueUsers: 'SELECT COUNT(DISTINCT chat_id) as count FROM message_logs',
            topChatters: `
                SELECT chat_id, COUNT(*) as message_count
                FROM message_logs
                WHERE DATE(timestamp) = CURRENT_DATE
                GROUP BY chat_id
                ORDER BY message_count DESC
                LIMIT 5
            `
        };

        try {
            const stats = {};
            for (const [key, query] of Object.entries(queries)) {
                const result = await this.pool.query(query);
                if (key === 'topChatters') {
                    stats[key] = result.rows;
                } else {
                    stats[key] = result.rows[0].count;
                }
            }
            return stats;
        } catch (error) {
            console.error('Error getting message stats:', error);
            throw error;
        }
    }

    // Command operations
    async logCommand(chatId, commandType, commandData) {
        if (!this.initialized) throw new Error('Database not initialized');

        const query = `
            INSERT INTO bot_commands (chat_id, command_type, command_data)
            VALUES ($1, $2, $3)
            RETURNING *
        `;

        const values = [chatId, commandType, JSON.stringify(commandData)];

        try {
            const result = await this.pool.query(query, values);
            return result.rows[0];
        } catch (error) {
            console.error('Error logging command:', error);
            throw error;
        }
    }

    // Helper method to format data for display
    formatUserDataForDisplay(userData, index) {
        if (!userData) return '';

        const tags = userData.tags && userData.tags.length > 0 ? userData.tags.join(', ') : 'No tags';
        const data = userData.data_json || {};

        return `*${index}. ${userData.user_name || 'Unknown'}*
📱 ${userData.chatId}
📞 ${userData.phoneNumber || 'No phone'}
🏷️ Tags: ${tags}
📅 Last updated: ${new Date(userData.updated_at).toLocaleDateString()}
📊 Data: ${Object.keys(data).length > 0 ? JSON.stringify(data, null, 2).substring(0, 200) + '...' : 'No additional data'}

---`;
    }

    // Close database connection
    async close() {
        if (this.pool) {
            await this.pool.end();
            console.log('✅ Database connection closed');
        }
    }
}

module.exports = DatabaseService;