# syntax=docker/dockerfile:1

FROM node:22-bookworm AS frontend
ARG PANEL_REF=main
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@9.15.9
WORKDIR /src
RUN git clone --depth 1 --branch "$PANEL_REF" https://github.com/BigDaddy3334/olcrtc-manager-panel.git . \
    || (git clone https://github.com/BigDaddy3334/olcrtc-manager-panel.git . && git checkout "$PANEL_REF")
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM golang:1.24-bookworm AS panel-builder
WORKDIR /src
COPY --from=frontend /src /src
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/olcrtc-manager ./cmd/olcrtc-manager

FROM golang:1.26-alpine3.22 AS olcrtc-builder
ARG OLCRTC_REF=master
RUN apk add --no-cache git
WORKDIR /src
RUN git clone --depth 1 --branch "$OLCRTC_REF" https://github.com/openlibrecommunity/olcrtc.git . \
    || (git clone https://github.com/openlibrecommunity/olcrtc.git . && git checkout "$OLCRTC_REF")
RUN go mod download
RUN go build -trimpath -ldflags="-s -w" -o /out/olcrtc ./cmd/olcrtc

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      iproute2 iptables ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=panel-builder /out/olcrtc-manager /usr/local/bin/olcrtc-manager
COPY --from=olcrtc-builder /out/olcrtc /usr/local/bin/olcrtc
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
ENV OLCRTC_PATH=/usr/local/bin/olcrtc
VOLUME /etc/olcrtc-manager
ENTRYPOINT ["/app/entrypoint.sh"]
