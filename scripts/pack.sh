#!/usr/bin/env bash
# 把扩展打成一个干净的可分发 zip。
#
# 为什么不用 GitHub 的源码归档（archive/refs/heads/main.zip）：
#   1. 它把 docs/ scripts/ .github/ 全塞进去，用户解压后一脸茫然
#   2. 顶层是 marksync-main/，版本号无处体现
#   3. 每次 push 内容都变，但用户毫无感知
# 这个脚本只挑运行必需的文件，并把它们放进同名顶层目录，
# 用户解压后直接得到「在 chrome://extensions 里要选的那个文件夹」。
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
NAME="marksync"
STAGE="dist/${NAME}"
OUT="marksync-v${VERSION}.zip"

# manifest.json 里实际引用到的资源目录
INCLUDE=(manifest.json background.js lib content popup options icons _locales)
# GPL-3.0 要求分发时附带许可证
EXTRA=(LICENSE)

missing=()
for p in "${INCLUDE[@]}" "${EXTRA[@]}"; do
  [ -e "$p" ] || missing+=("$p")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "✗ manifest 引用的路径不存在：${missing[*]}" >&2
  exit 1
fi

# 打包前先跑一遍 i18n 校验，别把漏翻的版本发出去
if [ -f scripts/check_i18n.py ]; then
  echo "→ 校验语言包"
  python3 scripts/check_i18n.py || { echo "✗ 语言包校验未通过，已中止打包" >&2; exit 1; }
  echo
fi

rm -rf dist && mkdir -p "$STAGE"
cp -R "${INCLUDE[@]}" "${EXTRA[@]}" "$STAGE/"
find "$STAGE" -name '.DS_Store' -delete
find "$STAGE" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true

( cd dist && zip -rq "$OUT" "$NAME" )

echo
echo "✓ v${VERSION} 打包完成"
echo "  dist/${OUT}  ($(du -h "dist/$OUT" | cut -f1))"
echo "  顶层目录：${NAME}/  ← 用户在 chrome://extensions 里选这个"
