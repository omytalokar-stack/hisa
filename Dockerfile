FROM mcr.microsoft.com/playwright:v1.65.1-noble

ENV NODE_ENV=production
ENV PORT=7860
ENV HEADLESS=true
ENV HISA_BROWSER_CHANNEL=bundled
WORKDIR /app

USER root
COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY start-space.sh /usr/local/bin/start-space
RUN chmod +x /usr/local/bin/start-space

EXPOSE 7860
ENTRYPOINT ["/usr/local/bin/start-space"]
