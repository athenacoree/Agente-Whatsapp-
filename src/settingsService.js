const fs = require('fs');
const path = require('path');

class SettingsService {
    constructor() {
        this.filePath = path.join(__dirname, '..', 'data', 'settings.json');
        this.settings = {
            personality: {
                centralPrompt: "Eres un asistente de IA amigable y empático para WhatsApp. Te adaptas al tono de conversación del usuario.",
                tones: {
                    smiling: "Responde de manera alegre, entusiasta, con emojis sonrientes 😊 y palabras positivas.",
                    angry: "Mantén un tono serio, directo y firme, pero respetuoso. Evita rodeos.",
                    sad: "Responde con empatía profunda, tono suave y consolador, demostrando comprensión y apoyo.",
                    formal: "Sé extremadamente formal, profesional y educado en tu respuesta."
                },
                countryPersonalities: [], // [{ country: string, prompt: string }]
                dictionary: [], // [string]
                rules: [] // [{ fieldName: string, variants: [{ name: string, text: string }] }]
            },
            rules: [], // Top-level [{ fieldName: string, variants: [{ name: string, text: string }] }]
            privacyPolicy: "Acepto las políticas de seguridad y privacidad del sistema para crear mi cuenta y chatear normalmente.",
            outbound: {
                numbers: [],
                messageTemplate: "Hola, soy tu asistente virtual de IA. ¡Me encantaría ayudarte a comenzar! ¿Deseas registrarte con nosotros hoy?"
            },
            adminPhoneNumber: "",
            primarySessionName: "default",
            primaryPhoneNumber: "",
            userAccess: {}, // { [chatId]: "normal" | "banned" | "special" }
            databases: [], // [{ id, name, uri, database, category, limitMb }]
            databaseRouting: {
                users: "",
                chatLogs: ""
            }
        };
        this.init();
    }

    init() {
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            if (fs.existsSync(this.filePath)) {
                const data = fs.readFileSync(this.filePath, 'utf8');
                const loaded = JSON.parse(data);
                this.settings = {
                    ...this.settings,
                    ...loaded,
                    personality: {
                        ...this.settings.personality,
                        ...(loaded.personality || {})
                    }
                };
                if (!this.settings.personality.countryPersonalities) this.settings.personality.countryPersonalities = [];
                if (!this.settings.personality.dictionary) this.settings.personality.dictionary = [];
                if (!this.settings.personality.rules) this.settings.personality.rules = [];
                if (!this.settings.rules) this.settings.rules = [];
                if (!this.settings.adminPhoneNumber) this.settings.adminPhoneNumber = "";
                if (!this.settings.primarySessionName) this.settings.primarySessionName = "default";
                if (!this.settings.primaryPhoneNumber) this.settings.primaryPhoneNumber = "";
                if (!this.settings.userAccess) this.settings.userAccess = {};
                if (!this.settings.databases) this.settings.databases = [];
                if (!this.settings.databaseRouting) {
                    this.settings.databaseRouting = { users: "", chatLogs: "" };
                }
            } else {
                this.save();
            }
        } catch (error) {
            console.error("Error initializing SettingsService:", error);
        }
    }

    getSettings() {
        return this.settings;
    }

    saveSettings(newSettings) {
        this.settings = { ...this.settings, ...newSettings };
        this.save();
        // Expose globally for index.js and bot.js access
        global.aiSettings = this.settings;
        return this.settings;
    }

    save() {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.settings, null, 2), 'utf8');
        } catch (error) {
            console.error("Error saving settings to file:", error);
        }
    }
}

const service = new SettingsService();
global.aiSettings = service.getSettings();

module.exports = service;
