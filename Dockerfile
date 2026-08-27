FROM node:20-bookworm

WORKDIR /app

COPY package*.json ./

RUN npm install

RUN npx playwright install --with-deps chromium

COPY . .

ENV NODE_ENV=production
ENV PORT=10000

EXPOSE 10000

CMD ["node", "server.js"]
