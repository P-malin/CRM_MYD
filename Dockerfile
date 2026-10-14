FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY scripts ./scripts

# ฐานข้อมูลเก็บที่ /data — บน Railway ให้ mount Volume ไว้ที่ path นี้
ENV DB_FILE=/data/crm.db
RUN mkdir -p /data

EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
