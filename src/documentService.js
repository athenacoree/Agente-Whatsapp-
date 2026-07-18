class DocumentService {
    constructor(databaseService) {
        this.db = databaseService;
        this.initialized = false;
    }

    async initialize() {
        try {
            await this.createDocumentTables();
            this.initialized = true;
            console.log('✅ Document Service initialized successfully with MongoDB');
            return true;
        } catch (error) {
            console.error('❌ Document Service initialization failed:', error);
            return false;
        }
    }

    async createDocumentTables() {
        try {
            const documents = this.db.db.collection('documents');
            await documents.createIndex({ pt_name: 1 });
            await documents.createIndex({ document_type: 1 });
            await documents.createIndex({ status: 1 });
            await documents.createIndex({ tags: 1 });

            const accessLogs = this.db.db.collection('document_access_logs');
            await accessLogs.createIndex({ pt_name: 1 });
            await accessLogs.createIndex({ access_time: 1 });

            console.log('✅ MongoDB document collections and indexes initialized successfully');
        } catch (error) {
            console.error('❌ Error creating document collections/indexes:', error);
            throw error;
        }
    }

    // Add document to database
    async addDocument(ptName, documentData) {
        if (!this.initialized) throw new Error('Document Service not initialized');
        const collection = this.db.db.collection('documents');

        const doc = {
            pt_name: ptName,
            document_type: documentData.documentType,
            document_name: documentData.documentName,
            file_path: documentData.filePath || null,
            description: documentData.description || null,
            status: 'active',
            created_at: new Date(),
            updated_at: new Date(),
            created_by: documentData.createdBy,
            tags: documentData.tags || []
        };

        try {
            const result = await collection.insertOne(doc);
            return {
                id: result.insertedId.toString(),
                ...doc
            };
        } catch (error) {
            console.error('Error adding document in MongoDB:', error);
            throw error;
        }
    }

    // Search documents by PT name
    async searchDocuments(ptName) {
        if (!this.initialized) throw new Error('Document Service not initialized');

        // Log the search
        await this.logDocumentAccess(ptName, 'search', ptName);

        const collection = this.db.db.collection('documents');
        const regex = new RegExp(ptName, 'i');

        try {
            const results = await collection.find({ pt_name: { $regex: regex } })
                .sort({ document_name: 1 })
                .toArray();

            return results.map(row => ({
                id: row._id.toString(),
                ...row
            }));
        } catch (error) {
            console.error('Error searching documents in MongoDB:', error);
            throw error;
        }
    }

    // Get all PT names available
    async getAllPTNames() {
        if (!this.initialized) throw new Error('Document Service not initialized');
        const collection = this.db.db.collection('documents');

        try {
            const results = await collection.aggregate([
                { $match: { status: 'active' } },
                {
                    $group: {
                        _id: '$pt_name',
                        document_count: { $sum: 1 }
                    }
                },
                { $sort: { _id: 1 } },
                {
                    $project: {
                        _id: 0,
                        pt_name: '$_id',
                        document_count: 1
                    }
                }
            ]).toArray();
            return results;
        } catch (error) {
            console.error('Error getting PT names in MongoDB:', error);
            throw error;
        }
    }

    // Get documents statistics
    async getDocumentStats() {
        if (!this.initialized) throw new Error('Document Service not initialized');
        const docsCollection = this.db.db.collection('documents');
        const logsCollection = this.db.db.collection('document_access_logs');

        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        try {
            const totalDocuments = await docsCollection.countDocuments({ status: 'active' });

            const distinctPTs = await docsCollection.distinct('pt_name', { status: 'active' });
            const totalPT = distinctPTs.length;

            const recentSearches = await logsCollection.aggregate([
                { $match: { access_time: { $gte: sevenDaysAgo } } },
                {
                    $group: {
                        _id: '$pt_name',
                        search_count: { $sum: 1 }
                    }
                },
                { $sort: { search_count: -1 } },
                { $limit: 5 },
                {
                    $project: {
                        _id: 0,
                        pt_name: '$_id',
                        search_count: 1
                    }
                }
            ]).toArray();

            const documentTypes = await docsCollection.aggregate([
                { $match: { status: 'active' } },
                {
                    $group: {
                        _id: '$document_type',
                        count: { $sum: 1 }
                    }
                },
                { $sort: { count: -1 } },
                {
                    $project: {
                        _id: 0,
                        document_type: '$_id',
                        count: 1
                    }
                }
            ]).toArray();

            return {
                totalDocuments,
                totalPT,
                recentSearches,
                documentTypes
            };
        } catch (error) {
            console.error('Error getting document stats in MongoDB:', error);
            throw error;
        }
    }

    // Log document access
    async logDocumentAccess(ptName, action, accessedBy, searchTerm = null) {
        if (!this.initialized) return;
        const collection = this.db.db.collection('document_access_logs');

        try {
            await collection.insertOne({
                pt_name: ptName,
                accessed_by: accessedBy,
                action: action,
                access_time: new Date(),
                search_term: searchTerm
            });
        } catch (error) {
            console.error('Error logging document access in MongoDB:', error);
        }
    }

    // Format document for display
    formatDocumentForDisplay(doc, index) {
        if (!doc) return '';

        const tags = doc.tags && doc.tags.length > 0 ? doc.tags.join(', ') : 'Tidak ada tags';
        const description = doc.description ? (doc.description.length > 100 ? doc.description.substring(0, 100) + '...' : doc.description) : 'Tidak ada deskripsi';

        return `*${index}. ${doc.document_name}*
📋 Tipe: ${doc.document_type}
🏢 PT: ${doc.pt_name}
📄 Deskripsi: ${description}
🏷️ Tags: ${tags}
📅 Ditambahkan: ${new Date(doc.created_at).toLocaleDateString()}
---`;
    }

    // Close database connection
    async close() {
        // Managed by DatabaseService
    }
}

module.exports = DocumentService;