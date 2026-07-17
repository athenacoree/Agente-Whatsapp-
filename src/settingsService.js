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
                }
            },
            privacyPolicy: "Acepto las políticas de seguridad y privacidad del sistema para crear mi cuenta y chatear normalmente.",
            outbound: {
                numbers: [],
                messageTemplate: "Hola, soy tu asistente virtual de IA. ¡Me encantaría ayudarte a comenzar! ¿Deseas registrarte con nosotros hoy?"
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
                this.settings = JSON.parse(data);
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
