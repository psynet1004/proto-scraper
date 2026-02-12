FROM node:20-slim

# Puppeteer에 필요한 Chrome 의존성 설치
RUN apt-get update && apt-get install -y \
  chromium \
  fonts-ipafont-gothic \
  fonts-wqy-zenhei \
  fonts-thai-tlwg \
  fonts-kacst \
  fonts-freefont-ttf \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Puppeteer가 번들된 Chromium 대신 시스템 Chromium 사용
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["node", "server.mjs"]
