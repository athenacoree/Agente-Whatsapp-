const sqlite3 = require('sqlite3').verbose();
const path = require('path');

class DatabaseServiceSQLite {
    constructor(config) {
        this.config = config;
        this.db = null;
        this.initialized = false;
        this.dbPath = path.join(__dirname, '..', 'data', 'wa_bot.sqlite');
    }

    async initialize() {
        try {
            // Ensure data directory exists
            const fs = require('fs');
            const dataDir = path.dirname(this.dbPath);
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }

            // SQLite connection
            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    console.error('❌ SQLite connection error:', err.message);
                    throw err;
                } else {
                    console.log('✅ SQLite connected successfully');
                }
            });

            // Initialize tables
            await this.createTables();

            this.initialized = true;
            console.log('✅ SQLite database initialized successfully');
            return true;
        } catch (error) {
            console.error('❌ SQLite database initialization failed:', error);
            return false;
        }
    }

    async createTables() {
        const createTablesQuery = `
            -- User data table
            CREATE TABLE IF NOT EXISTS user_data (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id TEXT UNIQUE NOT NULL,
                user_name TEXT,
                phone_number TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                data_json TEXT,
                tags TEXT
            );

            -- Message logs table
            CREATE TABLE IF NOT EXISTS message_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id TEXT UNIQUE,
                chat_id TEXT NOT NULL,
                sender_name TEXT,
                message_content TEXT,
                message_type TEXT DEFAULT 'text',
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                processed INTEGER DEFAULT 0,
                response_content TEXT
            );

            -- Bot commands table
            CREATE TABLE IF NOT EXISTS bot_commands (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id TEXT NOT NULL,
                command_type TEXT NOT NULL,
                command_data TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                processed INTEGER DEFAULT 0
            );

            -- Bot config table for storing persistent bot-specific configuration (like registered bot number)
            CREATE TABLE IF NOT EXISTS bot_config (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key TEXT UNIQUE NOT NULL,
                value TEXT,
                verified INTEGER DEFAULT 0,
                registered_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            -- Create indexes for better performance
            CREATE INDEX IF NOT EXISTS idx_bot_config_key ON bot_config(key);
            CREATE INDEX IF NOT EXISTS idx_user_data_chat_id ON user_data(chat_id);
            CREATE INDEX IF NOT EXISTS idx_message_logs_chat_id ON message_logs(chat_id);
            CREATE INDEX IF NOT EXISTS idx_message_logs_timestamp ON message_logs(timestamp);
            CREATE INDEX IF NOT EXISTS idx_bot_commands_chat_id ON bot_commands(chat_id);
        `;

        return new Promise((resolve, reject) => {
            this.db.exec(createTablesQuery, (err) => {
                if (err) {
                    console.error('❌ Error creating tables:', err);
                    reject(err);
                } else {
                    console.log('✅ Database tables created successfully');
                    resolve();
                }
            });
        });
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
            console.error('Error fetching existing SQLite user data for merge:', err);
        }

        const mergedData = { ...existingData, ...(userData.data || {}) };
        const mergedTags = [...new Set([...existingTags, ...(userData.tags || [])])];
        const finalName = userData.userName || existingName;
        const finalPhone = userData.phoneNumber || existingPhone;

        const query = `
            INSERT INTO user_data (chat_id, user_name, phone_number, data_json, tags)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(chat_id) DO UPDATE SET
                user_name = excluded.user_name,
                phone_number = excluded.phone_number,
                data_json = excluded.data_json,
                tags = excluded.tags,
                updated_at = CURRENT_TIMESTAMP
        `;

        const values = [
            chatId,
            finalName,
            finalPhone,
            JSON.stringify(mergedData),
            JSON.stringify(mergedTags)
        ];

        return new Promise((resolve, reject) => {
            const self = this;
            this.db.run(query, values, function(err) {
                if (err) {
                    console.error('Error upserting user data:', err);
                    reject(err);
                } else {
                    // Return the inserted/updated record
                    const selectQuery = 'SELECT * FROM user_data WHERE chat_id = ?';
                    self.db.get(selectQuery, [chatId], (err, row) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(row);
                        }
                    });
                }
            });
        });
    }

    async getUserData(chatId) {
        if (!this.initialized) throw new Error('Database not initialized');

        const query = 'SELECT * FROM user_data WHERE chat_id = ?';

        return new Promise((resolve, reject) => {
            this.db.get(query, [chatId], (err, row) => {
                if (err) {
                    console.error('Error getting user data:', err);
                    reject(err);
                } else {
                    if (row) {
                        // Parse JSON fields
                        row.data_json = JSON.parse(row.data_json || '{}');
                        row.tags = JSON.parse(row.tags || '[]');
                    }
                    resolve(row || null);
                }
            });
        });
    }

    async getAllUserData(limit = 50, offset = 0) {
        if (!this.initialized) throw new Error('Database not initialized');

        const query = `
            SELECT chat_id, user_name, phone_number, created_at, updated_at, tags
            FROM user_data
            ORDER BY updated_at DESC
            LIMIT ? OFFSET ?
        `;

        return new Promise((resolve, reject) => {
            this.db.all(query, [limit, offset], (err, rows) => {
                if (err) {
                    console.error('Error getting all user data:', err);
                    reject(err);
                } else {
                    // Parse JSON fields
                    rows.forEach(row => {
                        row.tags = JSON.parse(row.tags || '[]');
                    });
                    resolve(rows);
                }
            });
        });
    }

    async searchUserData(searchTerm, searchField = 'all') {
        if (!this.initialized) throw new Error('Database not initialized');

        let query;
        let values = [searchTerm];

        switch (searchField) {
            case 'name':
                query = `SELECT * FROM user_data WHERE user_name LIKE ? ORDER BY updated_at DESC`;
                values = [`%${searchTerm}%`];
                break;
            case 'phone':
                query = `SELECT * FROM user_data WHERE phone_number LIKE ? ORDER BY updated_at DESC`;
                values = [`%${searchTerm}%`];
                break;
            case 'tags':
                query = `SELECT * FROM user_data WHERE tags LIKE ? ORDER BY updated_at DESC`;
                values = [`%"${searchTerm}"%`];
                break;
            default: // all
                query = `
                    SELECT * FROM user_data
                    WHERE user_name LIKE ? OR phone_number LIKE ? OR tags LIKE ?
                    ORDER BY updated_at DESC
                `;
                values = [`%${searchTerm}%`, `%${searchTerm}%`, `%"${searchTerm}"%`];
        }

        return new Promise((resolve, reject) => {
            this.db.all(query, values, (err, rows) => {
                if (err) {
                    console.error('Error searching user data:', err);
                    reject(err);
                } else {
                    // Parse JSON fields
                    rows.forEach(row => {
                        row.data_json = JSON.parse(row.data_json || '{}');
                        row.tags = JSON.parse(row.tags || '[]');
                    });
                    resolve(rows);
                }
            });
        });
    }

    // Message logs operations
    async logMessage(messageData) {
        if (!this.initialized) throw new Error('Database not initialized');

        const query = `
            INSERT OR IGNORE INTO message_logs (message_id, chat_id, sender_name, message_content, message_type, response_content)
            VALUES (?, ?, ?, ?, ?, ?)
        `;

        const values = [
            messageData.messageId,
            messageData.chatId,
            messageData.senderName,
            messageData.messageContent,
            messageData.messageType || 'text',
            messageData.responseContent || null
        ];

        return new Promise((resolve, reject) => {
            const self = this;
            this.db.run(query, values, function(err) {
                if (err) {
                    console.error('Error logging message:', err);
                    reject(err);
                } else {
                    // Return the inserted record
                    const selectQuery = 'SELECT * FROM message_logs WHERE rowid = ?';
                    self.db.get(selectQuery, [this.lastID], (err, row) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(row);
                        }
                    });
                }
            });
        });
    }

    async getMessageStats() {
        if (!this.initialized) throw new Error('Database not initialized');

        const queries = {
            totalMessages: 'SELECT COUNT(*) as count FROM message_logs',
            todayMessages: 'SELECT COUNT(*) as count FROM message_logs WHERE DATE(timestamp) = DATE("now")',
            uniqueUsers: 'SELECT COUNT(DISTINCT chat_id) as count FROM message_logs',
            topChatters: `
                SELECT chat_id, COUNT(*) as message_count
                FROM message_logs
                WHERE DATE(timestamp) = DATE("now")
                GROUP BY chat_id
                ORDER BY message_count DESC
                LIMIT 5
            `
        };

        const stats = {};

        for (const [key, query] of Object.entries(queries)) {
            try {
                const result = await new Promise((resolve, reject) => {
                    if (key === 'topChatters') {
                        this.db.all(query, (err, rows) => {
                            if (err) reject(err);
                            else resolve(rows);
                        });
                    } else {
                        this.db.get(query, (err, row) => {
                            if (err) reject(err);
                            else resolve(row);
                        });
                    }
                });
                stats[key] = key === 'topChatters' ? result : result.count;
            } catch (error) {
                console.error(`Error getting ${key}:`, error);
                stats[key] = key === 'topChatters' ? [] : 0;
            }
        }

        return stats;
    }

    // Command operations
    async logCommand(chatId, commandType, commandData) {
        if (!this.initialized) throw new Error('Database not initialized');

        const query = `
            INSERT INTO bot_commands (chat_id, command_type, command_data)
            VALUES (?, ?, ?)
        `;

        const values = [chatId, commandType, JSON.stringify(commandData)];

        return new Promise((resolve, reject) => {
            const self = this;
            this.db.run(query, values, function(err) {
                if (err) {
                    console.error('Error logging command:', err);
                    reject(err);
                } else {
                    // Return the inserted record
                    const selectQuery = 'SELECT * FROM bot_commands WHERE rowid = ?';
                    self.db.get(selectQuery, [this.lastID], (err, row) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(row);
                        }
                    });
                }
            });
        });
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

    // Bot config operations
    async getBotConfig(key) {
        if (!this.initialized) throw new Error('Database not initialized');
        const query = 'SELECT * FROM bot_config WHERE key = ?';
        return new Promise((resolve, reject) => {
            this.db.get(query, [key], (err, row) => {
                if (err) {
                    console.error('Error getting bot config:', err);
                    reject(err);
                } else {
                    if (row) {
                        row.verified = !!row.verified;
                    }
                    resolve(row || null);
                }
            });
        });
    }

    async setBotConfig(key, value, verified = false) {
        if (!this.initialized) throw new Error('Database not initialized');
        const query = `
            INSERT INTO bot_config (key, value, verified, registered_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                verified = excluded.verified,
                registered_at = CURRENT_TIMESTAMP
        `;
        const values = [key, value, verified ? 1 : 0];
        return new Promise((resolve, reject) => {
            const self = this;
            this.db.run(query, values, function(err) {
                if (err) {
                    console.error('Error setting bot config:', err);
                    reject(err);
                } else {
                    self.db.get('SELECT * FROM bot_config WHERE key = ?', [key], (err, row) => {
                        if (err) {
                            reject(err);
                        } else {
                            if (row) {
                                row.verified = !!row.verified;
                            }
                            resolve(row);
                        }
                    });
                }
            });
        });
    }

    // Close database connection
    async close() {
        if (this.db) {
            return new Promise((resolve) => {
                this.db.close((err) => {
                    if (err) {
                        console.error('Error closing database:', err);
                    } else {
                        console.log('✅ Database connection closed');
                    }
                    resolve();
                });
            });
        }
    }
}

module.exports = DatabaseServiceSQLite;