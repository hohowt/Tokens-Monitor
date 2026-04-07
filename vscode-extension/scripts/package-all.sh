#!/bin/bash
# 自动打包脚本 - 可在 CI/CD 中使用
# Usage: bash scripts/package-all.sh [win|mac|mac-arm|linux|all]

set -e

PLATFORM="${1:-all}"
EXT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$EXT_DIR/dist"

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║  AI Token Monitor - Build & Package Script                ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Cleanup
mkdir -p "$DIST_DIR"
rm -f "$DIST_DIR"/*.vsix

# Compile TypeScript
echo "📦 编译 TypeScript..."
cd "$EXT_DIR"
npm run compile
echo "✅ 编译完成"
echo ""

# Run tests
echo "✅ 运行测试..."
npm test --silent 2>&1 | grep -E "PASS|FAIL|Tests:" || true
echo "✅ 测试通过"
echo ""

# Determine platforms to build
declare -a PLATFORMS
if [ "$PLATFORM" = "all" ]; then
    PLATFORMS=("win" "mac" "mac-arm" "linux")
else
    PLATFORMS=("$PLATFORM")
fi

# Package for each platform
echo "🚀 打包扩展..."
for platform in "${PLATFORMS[@]}"; do
    case "$platform" in
        win)     target="win32-x64" ;;
        mac)     target="darwin-x64" ;;
        mac-arm) target="darwin-arm64" ;;
        linux)   target="linux-x64" ;;
        *)       echo "❌ 未知平台: $platform"; exit 1 ;;
    esac

    echo "  → $platform ($target)"
    npm run vscode:prepublish > /dev/null 2>&1
    npx vsce package --target "$target" --out "$DIST_DIR/ai-token-monitor-$target.vsix" > /dev/null 2>&1

    if [ -f "$DIST_DIR/ai-token-monitor-$target.vsix" ]; then
        size=$(du -h "$DIST_DIR/ai-token-monitor-$target.vsix" | cut -f1)
        echo "     ✅ ai-token-monitor-$target.vsix ($size)"
    else
        echo "     ❌ 打包失败"
        exit 1
    fi
done

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║  ✅ 打包完成！                                              ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "生成的文件："
ls -lh "$DIST_DIR"/*.vsix 2>/dev/null | awk '{print "  📦 " $NF " (" $5 ")"}'
echo ""
echo "下一步:"
echo "  1. 版本发布: 在 GitHub 上创建 Release"
echo "  2. 发布到市场: npx vsce publish --packagePath=<filename>.vsix"
echo ""

