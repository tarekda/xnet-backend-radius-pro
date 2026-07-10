# Use Node.js LTS version
FROM node:20-alpine

# Set working directory
WORKDIR /app

# MySQL client tools (provides `mysqldump` on Alpine)
RUN apk add --no-cache mysql-client freeradius-client

# Copy package.json and lock file
COPY package*.json ./

# Force clean install
RUN npm ci

# Ensure node-routeros is available
RUN npm list node-routeros || npm install node-routeros

# Copy the rest of the app
COPY . .

# Build TypeScript
RUN npm run build

# Entrypoint runs migrations then starts the API
COPY docker/entrypoint.sh /entrypoint.sh
COPY docker/worker-entrypoint.sh /worker-entrypoint.sh
# Strip Windows CRLF so Alpine can exec the shebang
RUN tr -d '\r' < /entrypoint.sh > /entrypoint.sh.tmp && mv /entrypoint.sh.tmp /entrypoint.sh && chmod +x /entrypoint.sh \
 && tr -d '\r' < /worker-entrypoint.sh > /worker-entrypoint.sh.tmp && mv /worker-entrypoint.sh.tmp /worker-entrypoint.sh && chmod +x /worker-entrypoint.sh

# Expose app port
EXPOSE 3000

# Run the app
CMD ["sh", "/entrypoint.sh"]
