FROM node:24-slim

WORKDIR /app/backend

COPY packages/backend/package*.json ./
RUN npm ci

COPY packages/backend/src ./src
COPY packages/backend/migrations ./migrations
COPY packages/backend/test ./test
COPY packages/backend/tsconfig.json packages/backend/wrangler.toml ./

EXPOSE 8787

CMD ["sh", "-c", "npm run db:migrate:local && exec npm run dev -- --ip 0.0.0.0"]
