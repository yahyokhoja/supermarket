#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="$ROOT_DIR/certs"
KEY_PATH="$CERT_DIR/dev-key.pem"
CERT_PATH="$CERT_DIR/dev-cert.pem"
CONF_PATH="$CERT_DIR/openssl-dev.cnf"

mkdir -p "$CERT_DIR"

SAN_LIST="DNS:localhost,IP:127.0.0.1,IP:::1"
if [[ -n "${DEV_HTTPS_IP:-}" ]]; then
  SAN_LIST="$SAN_LIST,IP:${DEV_HTTPS_IP}"
fi

cat > "$CONF_PATH" <<EOF
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = supermarket-local

[v3_req]
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = ${SAN_LIST}
EOF

openssl req \
  -x509 \
  -nodes \
  -newkey rsa:2048 \
  -keyout "$KEY_PATH" \
  -out "$CERT_PATH" \
  -days 825 \
  -config "$CONF_PATH" \
  -extensions v3_req

echo "Created:"
echo "  $KEY_PATH"
echo "  $CERT_PATH"
if [[ -n "${DEV_HTTPS_IP:-}" ]]; then
  echo "SAN includes IP: ${DEV_HTTPS_IP}"
fi
