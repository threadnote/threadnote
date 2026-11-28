FROM golang:1.25.7-alpine3.23@sha256:f6751d823c26342f9506c03797d2527668d095b0a15f1862cddb4d927a7a4ced AS gateway-build

WORKDIR /src
COPY infra/telemetry-gateway/go.mod ./go.mod
COPY infra/telemetry-gateway/go.sum ./go.sum
RUN go mod download
COPY infra/telemetry-gateway/gateway.go ./gateway.go
COPY infra/telemetry-gateway/gateway_test.go ./gateway_test.go
COPY infra/telemetry-gateway/schema.go ./schema.go
COPY infra/telemetry-gateway/telemetry-schema-v1.json ./telemetry-schema-v1.json
COPY infra/telemetry-gateway/telemetry-schema-v2.json ./telemetry-schema-v2.json
COPY infra/telemetry-gateway/telemetry-schema-v3.json ./telemetry-schema-v3.json
COPY infra/telemetry-gateway/telemetry-schema-v4.json ./telemetry-schema-v4.json
COPY infra/telemetry-gateway/telemetry-schema-v5.json ./telemetry-schema-v5.json
COPY infra/telemetry-gateway/telemetry-schema-v6.json ./telemetry-schema-v6.json
COPY infra/telemetry-gateway/telemetry-schema-v7.json ./telemetry-schema-v7.json
COPY infra/telemetry-gateway/cmd ./cmd
COPY infra/telemetry-gateway/internal ./internal
RUN go test ./... && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w' -o /out/threadnote-gateway .

FROM otel/opentelemetry-collector-contrib:0.158.0@sha256:c5918f78992ee73b0d6f0e599423ac5ec52dd5d9726733114d6eca53d5a32ed5

COPY --from=gateway-build --chown=10001:10001 /out/threadnote-gateway /threadnote-gateway
COPY --chown=10001:10001 infra/telemetry-gateway/collector.yaml /etc/otelcol-contrib/config.yaml

EXPOSE 8080
USER 10001:10001
ENTRYPOINT ["/threadnote-gateway"]
