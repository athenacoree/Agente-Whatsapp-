FROM devlikeapro/waha:latest

# Modify OpenSSL configuration to support MongoDB Atlas TLS compatibility (SECLEVEL=1)
RUN sed -i 's/\[openssl_init\]/\[openssl_init\]\nssl_conf = ssl_sect/' /etc/ssl/openssl.cnf && \
    printf "\n[ssl_sect]\nsystem_default = system_default_sect\n\n[system_default_sect]\nCipherString = DEFAULT@SECLEVEL=1\n" >> /etc/ssl/openssl.cnf

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
