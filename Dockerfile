FROM mcr.microsoft.com/playwright:v1.65.1-noble

ENV NODE_ENV=production
ENV PORT=7860
ENV DISPLAY=:99
ENV HEADLESS=false
ENV HISA_BROWSER_CHANNEL=bundled
ENV HISA_AUTO_LOGIN=true
ENV ENABLE_VNC_PROXY=true
WORKDIR /app

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY start-space.sh /usr/local/bin/start-space
RUN chmod +x /usr/local/bin/start-space

EXPOSE 7860
ENTRYPOINT ["/usr/local/bin/start-space"]
