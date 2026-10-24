# Stage 1: Build Go binary (native platform, cross-compile for target)
FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS builder
ARG TARGETOS
ARG TARGETARCH
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN GOOS=${TARGETOS} GOARCH=${TARGETARCH} CGO_ENABLED=0 go build -ldflags="-s -w" -o /app/momo-backend ./main.go

# Stage 2: Runtime
FROM alpine:3.21
RUN apk --no-cache add ca-certificates tzdata
WORKDIR /app

# Copy binary
COPY --from=builder /app/momo-backend .

# Copy dashboard static files (injected by CI)
COPY public ./public

# Data and config directories (mount volumes here)
RUN mkdir -p /app/data /app/config

EXPOSE 3000

# 容器健康探测：打公开的 /health（同时检查 SQLite 连接）。
# 用 busybox wget（alpine 自带）；PORT 可被运行时环境变量覆盖，默认 3000。
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3000}/health" || exit 1

VOLUME ["/app/data", "/app/config"]

CMD ["./momo-backend"]
