FROM devlikeapro/waha:latest

# Set working directory for the bot
WORKDIR /app/bot

# Copy package files
COPY package*.json ./

# Install bot dependencies
RUN npm ci --only=production

# Copy source code and assets
COPY src/ ./src/
COPY public/ ./public/

# Expose bot port (Render uses PORT env var, typically 3010)
EXPOSE 3010

# Start the bot
CMD ["npm", "start"]
