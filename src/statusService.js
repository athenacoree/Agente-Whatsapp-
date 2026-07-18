class StatusService {
    constructor(databaseService) {
        this.db = databaseService;
        this.initialized = false;
    }

    async initialize() {
        try {
            if (!this.db || !this.db.initialized || !this.db.db) {
                console.warn('⚠️ MongoDB DatabaseService is not initialized or connected. Status Service running in degraded/disabled mode.');
                this.initialized = false;
                return false;
            }
            await this.createStatusTables();
            this.initialized = true;
            console.log('✅ Status Service initialized successfully with MongoDB');
            return true;
        } catch (error) {
            console.error('❌ Status Service initialization failed:', error);
            this.initialized = false;
            return false;
        }
    }

    async createStatusTables() {
        try {
            const statusCollection = this.db.db.collection('status_pekerjaan');
            await statusCollection.createIndex({ date_added: 1 });
            await statusCollection.createIndex({ created_by: 1 });
            await statusCollection.createIndex({ created_at: 1 });

            const logsCollection = this.db.db.collection('status_logs');
            await logsCollection.createIndex({ status_id: 1 });

            const aiCollection = this.db.db.collection('status_ai_processed');
            await aiCollection.createIndex({ status_id: 1 });
            await aiCollection.createIndex({ processed_at: 1 });

            console.log('✅ MongoDB status collections and indexes initialized successfully');
        } catch (error) {
            console.error('❌ Error creating status collections/indexes:', error);
            throw error;
        }
    }

    // Add new status pekerjaan
    async addStatus(statusText, createdBy, tags = []) {
        if (!this.initialized) throw new Error('Status Service not initialized');
        const collection = this.db.db.collection('status_pekerjaan');

        const doc = {
            status_text: statusText,
            created_by: createdBy,
            created_at: new Date(),
            updated_at: new Date(),
            date_added: new Date().toISOString().split('T')[0], // YYYY-MM-DD
            tags: tags
        };

        try {
            const result = await collection.insertOne(doc);
            return {
                id: result.insertedId.toString(),
                ...doc
            };
        } catch (error) {
            console.error('Error adding status in MongoDB:', error);
            throw error;
        }
    }

    // Get status pekerjaan for specific date (default today)
    async getStatusByDate(date = null) {
        if (!this.initialized) throw new Error('Status Service not initialized');

        const targetDate = date || new Date().toISOString().split('T')[0];
        const collection = this.db.db.collection('status_pekerjaan');

        try {
            const results = await collection.find({ date_added: targetDate })
                .sort({ created_at: 1 })
                .toArray();

            return results.map(row => ({
                id: row._id.toString(),
                ...row
            }));
        } catch (error) {
            console.error('Error getting status by date in MongoDB:', error);
            throw error;
        }
    }

    // Get status pekerjaan for date range
    async getStatusByDateRange(startDate, endDate) {
        if (!this.initialized) throw new Error('Status Service not initialized');
        const collection = this.db.db.collection('status_pekerjaan');

        try {
            const results = await collection.find({
                date_added: { $gte: startDate, $lte: endDate }
            })
            .sort({ date_added: 1, created_at: 1 })
            .toArray();

            return results.map(row => ({
                id: row._id.toString(),
                ...row
            }));
        } catch (error) {
            console.error('Error getting status by date range in MongoDB:', error);
            throw error;
        }
    }

    // Get today's status (alias for getStatusByDate with no date)
    async getTodayStatus() {
        return await this.getStatusByDate();
    }

    // Save AI processed status
    async saveAIProcessedStatus(statusId, originalText, formattedText, processedBy, aiModel) {
        if (!this.initialized) throw new Error('Status Service not initialized');
        const collection = this.db.db.collection('status_ai_processed');

        const doc = {
            status_id: statusId,
            original_text: originalText,
            formatted_text: formattedText,
            processed_by: processedBy,
            processed_at: new Date(),
            ai_model: aiModel,
            is_final: false
        };

        try {
            const result = await collection.insertOne(doc);
            return {
                id: result.insertedId.toString(),
                ...doc
            };
        } catch (error) {
            console.error('Error saving AI processed status in MongoDB:', error);
            throw error;
        }
    }

    // Get AI processed status for a date
    async getAIProcessedStatusByDate(date = null) {
        if (!this.initialized) throw new Error('Status Service not initialized');

        const targetDateStr = date || new Date().toISOString().split('T')[0];
        const targetDateStart = new Date(targetDateStr);
        targetDateStart.setHours(0, 0, 0, 0);
        const targetDateEnd = new Date(targetDateStr);
        targetDateEnd.setHours(23, 59, 59, 999);

        const collection = this.db.db.collection('status_ai_processed');

        try {
            const results = await collection.aggregate([
                {
                    $match: {
                        processed_at: { $gte: targetDateStart, $lte: targetDateEnd }
                    }
                },
                {
                    $addFields: {
                        statusObjectId: {
                            $cond: {
                                if: { $eq: [{ $type: "$status_id" }, "string"] },
                                then: { $toObjectId: "$status_id" },
                                else: "$status_id"
                            }
                        }
                    }
                },
                {
                    $lookup: {
                        from: 'status_pekerjaan',
                        localField: 'statusObjectId',
                        foreignField: '_id',
                        as: 'statusInfo'
                    }
                },
                {
                    $unwind: {
                        path: '$statusInfo',
                        preserveNullAndEmptyArrays: true
                    }
                },
                {
                    $sort: { processed_at: 1 }
                },
                {
                    $project: {
                        _id: 0,
                        id: { $toString: '$_id' },
                        status_id: 1,
                        original_text: 1,
                        formatted_text: 1,
                        processed_by: 1,
                        processed_at: 1,
                        ai_model: 1,
                        is_final: 1,
                        status_text: '$statusInfo.status_text',
                        created_at: '$statusInfo.created_at'
                    }
                }
            ]).toArray();

            return results;
        } catch (error) {
            console.error('Error getting AI processed status by date in MongoDB:', error);
            throw error;
        }
    }

    // Format status for display
    formatStatusForDisplay(status, index) {
        if (!status) return '';

        const tags = status.tags && status.tags.length > 0 ? status.tags.join(', ') : 'Tidak ada tags';
        const formattedTime = new Date(status.created_at).toLocaleString('id-ID');

        return `${index}. *${status.status_text.substring(0, 100)}${status.status_text.length > 100 ? '...' : ''}*
📝 Oleh: ${status.created_by}
🕐 ${formattedTime}
🏷️ Tags: ${tags}
---`;
    }

    // Format AI processed status for display
    formatAIStatusForDisplay(aiStatus, index) {
        if (!aiStatus) return '';

        const formattedTime = new Date(aiStatus.processed_at).toLocaleString('id-ID');

        return `${index}. *${aiStatus.formatted_text.substring(0, 150)}${aiStatus.formatted_text.length > 150 ? '...' : ''}*
📝 Asli: ${aiStatus.original_text.substring(0, 50)}${aiStatus.original_text.length > 50 ? '...' : ''}
🤖 Diproses oleh: ${aiStatus.processed_by}
🕐 ${formattedTime}
🤖 AI Model: ${aiStatus.ai_model}
---`;
    }

    // Get statistics
    async getStatusStats() {
        if (!this.initialized) throw new Error('Status Service not initialized');
        const collection = this.db.db.collection('status_pekerjaan');

        const todayStr = new Date().toISOString().split('T')[0];
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const sevenDaysAgoStr = sevenDaysAgo.toISOString().split('T')[0];

        try {
            const totalStatus = await collection.countDocuments({});
            const todayStatus = await collection.countDocuments({ date_added: todayStr });

            const uniqueUsersList = await collection.distinct('created_by');
            const uniqueUsers = uniqueUsersList.length;

            const topUsers = await collection.aggregate([
                {
                    $match: {
                        date_added: { $gte: sevenDaysAgoStr }
                    }
                },
                {
                    $group: {
                        _id: '$created_by',
                        status_count: { $sum: 1 }
                    }
                },
                { $sort: { status_count: -1 } },
                { $limit: 5 },
                {
                    $project: {
                        _id: 0,
                        created_by: '$_id',
                        status_count: 1
                    }
                }
            ]).toArray();

            return {
                totalStatus,
                todayStatus,
                uniqueUsers,
                topUsers
            };
        } catch (error) {
            console.error('Error getting status stats in MongoDB:', error);
            throw error;
        }
    }

    // Close database connection
    async close() {
        // Managed by DatabaseService
    }
}

module.exports = StatusService;