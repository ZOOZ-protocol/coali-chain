# Coali node image. Build from the repository root:
#   docker build -f deploy/Dockerfile -t coali-node:testnet .
FROM rust:1-bookworm AS builder
RUN apt-get update \
 && apt-get install -y --no-install-recommends clang libclang-dev protobuf-compiler \
 && rm -rf /var/lib/apt/lists/*
RUN rustup target add wasm32-unknown-unknown wasm32v1-none && rustup component add rust-src
WORKDIR /build
COPY . .
# .cargo/config.toml holds macOS-only paths (libclang, protoc).
RUN rm -f .cargo/config.toml && cargo build --release --locked -p coali-node

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -u 1000 -U -s /bin/sh -d /coali coali \
 && mkdir -p /data /spec && chown -R coali:coali /data
COPY --from=builder /build/target/release/coali-node /usr/local/bin/coali-node
USER coali
EXPOSE 30333 9944 9615
VOLUME ["/data"]
ENTRYPOINT ["/usr/local/bin/coali-node"]
