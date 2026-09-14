#!/bin/bash
# 将 PS 插件打包为 .ccx 安装包，用户可在 PS 里直接安装
# 用法：双击 package.command（或在终端执行 bash package.command）

set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
NAME="NOVAI-画布工具"
VERSION=$(python3 -c "import json; print(json.load(open('$DIR/manifest.json'))['version'])" 2>/dev/null || echo "0.3.0")
CCX="$DIR/${NAME}-v${VERSION}.ccx"

# .ccx 就是 zip，但扩展名不同
echo "正在打包 ${NAME} v${VERSION} ..."

# 清理旧包
rm -f "$CCX"

# 打包（排除 .DS_Store 和脚本自身）
cd "$DIR"
zip -r "$CCX" \
  manifest.json \
  index.html \
  style.css \
  js/ \
  -x "*.DS_Store" "package.command"

SIZE=$(du -h "$CCX" | cut -f1)
echo ""
echo "✅ 打包完成：$CCX ($SIZE)"
echo ""
echo "安装方式（Mac）："
echo "  1. 确保 Photoshop 已启用开发者模式："
echo "     Photoshop → 首选项 → 插件 → 启用开发者模式 → 重启 PS"
echo "  2. 打开 Photoshop → 增效工具 → 管理增效工具"
echo "  3. 点击右上角 ⚙ → 从文件安装增效工具"
echo "  4. 选择 ${NAME}-v${VERSION}.ccx"
echo "  5. 在「增效工具」菜单打开「NOVAI画布工具」"
echo ""
echo "如果面板空白，请检查："
echo "  - 是否已开启开发者模式（最常见原因）"
echo "  - 系统设置 → 隐私与安全性 是否阻止了未签名插件"
