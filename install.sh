#!/usr/bin/env bash
set -euo pipefail

REPO="evantahler/icloud-backup"
INSTALL_DIR="${ICLOUD_BACKUP_INSTALL_DIR:-/usr/local/bin}"

OS="$(uname -s)"
if [ "$OS" != "Darwin" ]; then
  echo "error: icloud-backup is macOS-only (got $OS)" >&2
  exit 1
fi

ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *)
    echo "error: unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

ARTIFACT="icloud-backup-darwin-${arch}"

echo "Fetching latest release..."
TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)

if [ -z "$TAG" ]; then
  echo "error: could not determine latest release" >&2
  exit 1
fi

URL="https://github.com/${REPO}/releases/download/${TAG}/${ARTIFACT}"

echo "Downloading icloud-backup ${TAG} (darwin/${arch})..."
TMP="$(mktemp)"
curl -fsSL "$URL" -o "$TMP"
chmod +x "$TMP"

if [ -w "$INSTALL_DIR" ]; then
  mv "$TMP" "${INSTALL_DIR}/icloud-backup"
else
  echo "Installing to ${INSTALL_DIR} (requires sudo)..."
  sudo mv "$TMP" "${INSTALL_DIR}/icloud-backup"
fi

echo "icloud-backup ${TAG} installed to ${INSTALL_DIR}/icloud-backup"
