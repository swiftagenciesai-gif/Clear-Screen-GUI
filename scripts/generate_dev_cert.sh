#!/usr/bin/env bash
# Generates a self-signed HTTPS certificate for running the backend over
# TLS locally. This is required to use the camera from any device other
# than the machine running the server -- browsers (iOS Safari in
# particular, with zero exceptions) only allow getUserMedia() on a "secure
# context", which means either https:// or the literal hostname
# "localhost". Visiting the server's plain http://<lan-ip>:8000 from a
# phone will silently fail to get camera access; there is no way around
# needing TLS for that.
#
# Usage: bash scripts/generate_dev_cert.sh
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p certs

if ! command -v openssl &>/dev/null; then
  echo "openssl not found. It ships with macOS and most Linux distros by default;"
  echo "install it via your package manager if missing, then re-run this script."
  exit 1
fi

# Best-effort LAN IP detection so the cert's SAN list covers whatever
# address your phone will actually connect to. Not load-bearing if it
# fails -- an IP-mismatched self-signed cert still works, it just shows the
# same "not trusted" warning as any self-signed cert would anyway.
LAN_IP=""
if command -v ipconfig &>/dev/null; then
  LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
elif command -v hostname &>/dev/null; then
  LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
fi

SAN="DNS:localhost,IP:127.0.0.1"
if [ -n "$LAN_IP" ]; then
  SAN="$SAN,IP:$LAN_IP"
  echo "Detected LAN IP: $LAN_IP (will be included in the certificate)"
else
  echo "Could not auto-detect a LAN IP -- the cert will still work, you'll just"
  echo "see the usual self-signed warning regardless of which address you use."
fi

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout certs/dev-key.pem \
  -out certs/dev-cert.pem \
  -days 365 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=$SAN"

echo
echo "Done. Run the server with:"
echo "  uvicorn app:app --host 0.0.0.0 --port 8000 --ssl-keyfile=../certs/dev-key.pem --ssl-certfile=../certs/dev-cert.pem"
echo "(paths are relative to backend/, since that's where you run uvicorn from)"
echo
if [ -n "$LAN_IP" ]; then
  echo "Then from your phone (same WiFi network), visit:"
  echo "  https://$LAN_IP:8000/index.html"
fi
echo
echo "Your phone's browser will warn that the certificate isn't trusted -- that's"
echo "expected for a self-signed cert. Tap through it (Safari: 'Show Details' ->"
echo "'visit this website'); the page still loads over a real encrypted"
echo "connection and the camera will work normally once you accept it."
