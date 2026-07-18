FROM node:24-slim
WORKDIR /app/backend
COPY packages/backend/package*.json ./
RUN npm ci
COPY packages/backend/src ./src
COPY packages/backend/migrations ./migrations
WORKDIR /app/frontend
COPY packages/frontend/package.json packages/frontend/server.js packages/frontend/archive.js packages/frontend/cloudflare.js ./
COPY packages/frontend/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
