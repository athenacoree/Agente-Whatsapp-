const axios = require('axios');

class GrokService {
    constructor() {
        // Dynamic credentials mapped directly to the global configuration store
        this.client = null;
        this.lastApiKey = null;
    }

    getClient() {
        const apiKey = global.grokConfig?.apiKey || process.env.GROK_API_KEY;
        if (!apiKey) {
            return null;
        }

        // Re-create axios client only when API key changes
        if (!this.client || this.lastApiKey !== apiKey) {
            this.lastApiKey = apiKey;
            this.client = axios.create({
                baseURL: 'https://api.x.ai/v1',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            });
        }

        return this.client;
    }

    isEnabled() {
        return !!global.grokConfig?.enabled;
    }

    getModel() {
        return global.grokConfig?.model || 'grok-2-1212';
    }

    async chatCompletion(messages) {
        const client = this.getClient();
        if (!client) {
            return {
                success: false,
                error: 'Grok xAI API Key is missing or not configured.'
            };
        }

        const model = this.getModel();

        try {
            const response = await client.post('/chat/completions', {
                model: model,
                messages: messages,
                temperature: 0.7,
                max_tokens: 1024,
                top_p: 1,
                stream: false
            });

            return {
                success: true,
                content: response.data.choices[0].message.content,
                usage: response.data.usage
            };
        } catch (error) {
            console.error('Error calling Grok xAI API:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.error?.message || error.message
            };
        }
    }

    async chatWithContext(history, userMessage, maxHistory = 5) {
        const messages = [];

        // Add system message
        messages.push({
            role: 'system',
            content: 'You are a helpful AI assistant. Be concise, friendly, and helpful. Respond in a natural conversational style.'
        });

        // Add recent conversation history
        const recentHistory = history.slice(-maxHistory * 2);
        for (const msg of recentHistory) {
            messages.push({
                role: msg.role,
                content: msg.content
            });
        }

        // Add current user message
        messages.push({
            role: 'user',
            content: userMessage
        });

        return await this.chatCompletion(messages);
    }
}

// Export a singleton instance
module.exports = new GrokService();
