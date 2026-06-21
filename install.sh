#!/bin/sh
# DAO CODE 一键安装:自动判平台、下载对应二进制、赋可执行权限、解除 macOS 隔离、放进 PATH。
# 用法:  curl -fsSL https://raw.githubusercontent.com/tigicion/dao-code/master/install.sh | sh
# 可选:  DAO_INSTALL_DIR=/usr/local/bin 指定安装目录(默认 ~/.local/bin)
set -eu

REPO="tigicion/dao-code"
DIR="${DAO_INSTALL_DIR:-$HOME/.local/bin}"

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) os=darwin ;;
  Linux)  os=linux ;;
  *) echo "✗ 不支持的系统:$os(Windows 请用 npm i -g dao-code,或下载 dao-windows-x64.exe)"; exit 1 ;;
esac
case "$arch" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64)  arch=x64 ;;
  *) echo "✗ 不支持的架构:$arch"; exit 1 ;;
esac

asset="dao-${os}-${arch}"
url="https://github.com/${REPO}/releases/latest/download/${asset}"

echo "→ 下载 ${asset} …"
mkdir -p "$DIR"
tmp="$(mktemp)"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$url" -o "$tmp"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$tmp" "$url"
else
  echo "✗ 需要 curl 或 wget"; exit 1
fi

chmod +x "$tmp"
[ "$os" = "darwin" ] && xattr -d com.apple.quarantine "$tmp" 2>/dev/null || true  # 解除 Gatekeeper 隔离
mv "$tmp" "$DIR/dao"

echo "✓ 已安装 → $DIR/dao"
case ":$PATH:" in
  *":$DIR:"*) echo "  直接运行:dao" ;;
  *) echo "  ⚠ $DIR 不在 PATH。加入(按你的 shell):"
     echo "    echo 'export PATH=\"$DIR:\$PATH\"' >> ~/.zshrc && source ~/.zshrc"
     echo "  或直接运行:$DIR/dao" ;;
esac
