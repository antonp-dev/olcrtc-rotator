# syntax=docker/dockerfile:1
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

RUN apt-get update \
  && apt-get install -y --no-install-recommends xvfb \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev

COPY rotate.js .
COPY entrypoint.sh .
RUN chmod +x /app/entrypoint.sh

ENV STATE_PATH=/data/state.json
ENV DEBUG_SCREENSHOT_PATH=/data/last-failure.png
VOLUME /data

CMD ["/app/entrypoint.sh"]
