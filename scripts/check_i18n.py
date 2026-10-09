#!/usr/bin/env python3
"""校验 _locales 与代码引用的一致性。

抓两类问题：
  1. 代码里 t("x") / data-i18n="x" / __MSG_x__ 用到的 key，语言包里没有 → 运行时显示成裸 key
  2. 三种语言的 key 集合或 $1 $2 占位符对不上 → 某语言下文案错位

同时报告语言包里没人引用的冗余 key。

退出码非 0 = 校验失败，供 CI 使用。
"""
import glob
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

LOCALES = sorted(glob.glob("_locales/*/messages.json"))
SOURCE_LOCALES = ["zh_CN", "en", "ja"]

# 代码里动态拼接的 key 前缀（store.js 里 t("plat_" + platform) 这种）
DYNAMIC_PREFIXES = ("plat_", "src_", "srcs_")

# 通过查表引用的 key，静态扫不出来。例如 onboarding.js 里的 t(FREQ_KEY[m])。
# 新增这类写法时记得往这里加，否则会被误报成「没人用」。
LOOKUP_KEYS = {"freq30m", "freq1h", "freq3h", "freq6h", "freq12h", "freq1d"}

# 匹配 t("x") / msg("x") / tTime("x") / getMessage("x")
RE_CALL = re.compile(r'\b(?:t|msg|tTime|tWithHtml|getMessage)\(\s*"([A-Za-z_]\w*)"')
RE_ATTR = re.compile(r'data-i18n(?:-title|-placeholder)?="([A-Za-z_]\w*)"')
RE_MSG = re.compile(r"__MSG_([A-Za-z_]\w*)__")
RE_SUB = re.compile(r"\$(\d)")

# Chrome 把「$ + 纯 ASCII 字母数字下划线 + $」当作**具名占位符** $name$，
# 没在 placeholders 里声明就报 "Variable $1$ used but not defined"，
# 而且会让**整个扩展加载失败**（Chrome 校验所有 message，包括没人引用的——已实测）。
#
# 实测（Chrome --pack-extension）：
#   ❌ $1$2   $5$9   $1a$   $name$        → 两个 $ 之间只有 ASCII 标识符字符
#   ✅ $1，$2  $1 $2  $1文本$2  $5 和 $9   → 中间有空格/标点/中文
#
# 所以规则很简单：两个 $ 之间不能是纯 ASCII 标识符。要写两个替换项，
# 就在 JS 里先拼好再作为一个 $1 传入。
RE_BAD_PLACEHOLDER = re.compile(r"\$[A-Za-z0-9_]+\$")


def fail(msg):
    print(f"\033[31m✗ {msg}\033[0m")


def ok(msg):
    print(f"\033[32m✓\033[0m {msg}")


def strip_comments(src):
    """去掉 JS/HTML 注释，避免把注释里的示例代码当成真引用。

    要处理字符串里的 //（https://... 到处都是），所以不能简单地按 // 切。
    状态机：引号内原样保留，遇反引号/单引号/双引号就进字符串态。
    """
    out, i, n = [], 0, len(src)
    quote = None
    while i < n:
        c = src[i]
        if quote:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(src[i + 1])
                i += 2
                continue
            if c == quote:
                quote = None
            i += 1
            continue
        if c in "\"'`":
            quote = c
            out.append(c)
            i += 1
            continue
        if c == "/" and i + 1 < n:
            if src[i + 1] == "/":
                while i < n and src[i] != "\n":
                    i += 1
                continue
            if src[i + 1] == "*":
                i += 2
                while i + 1 < n and not (src[i] == "*" and src[i + 1] == "/"):
                    i += 1
                i += 2
                continue
        out.append(c)
        i += 1
    return re.sub(r"<!--.*?-->", " ", "".join(out), flags=re.S)


def main():
    errors = []

    # ── 1. 语言包本身：JSON 合法 + 必备字段 ──
    locales = {}
    for path in LOCALES:
        try:
            data = json.load(io.open(path, encoding="utf-8"))
        except Exception as e:
            errors.append(f"{path} JSON 解析失败: {e}")
            continue
        bad = [k for k, v in data.items() if not isinstance(v, dict) or "message" not in v]
        if bad:
            errors.append(f"{path} 缺少 message 字段: {bad}")

        # 会导致整个扩展加载失败的占位符写法
        for k, v in data.items():
            msg = v.get("message", "") if isinstance(v, dict) else ""
            hits = RE_BAD_PLACEHOLDER.findall(msg)
            if hits and "placeholders" not in v:
                errors.append(
                    f"{path} [{k}] 含未声明的具名占位符 {hits}，"
                    f"Chrome 会拒绝加载**整个扩展**。"
                    f"改成单个 $1（在 JS 里先拼好），或在键之间加空格/标点。"
                )

        locales[path] = data
        ok(f"{path}  {len(data)} keys")

    if not locales:
        fail("没有找到任何语言包")
        return 1

    # ── 2. 语言包之间：key 集合一致 ──
    names = {os.path.basename(os.path.dirname(p)): d for p, d in locales.items()}
    base_name = SOURCE_LOCALES[0] if SOURCE_LOCALES[0] in names else sorted(names)[0]
    base = set(names[base_name])
    for name, d in names.items():
        miss, extra = base - set(d), set(d) - base
        if miss:
            errors.append(f"{name} 缺少 key: {sorted(miss)}")
        if extra:
            errors.append(f"{name} 多出 key: {sorted(extra)}")
    if not any("key" in e for e in errors):
        ok(f"三种语言 key 集合一致（{len(base)} 个）")

    # ── 3. 语言包之间：占位符一致 ──
    mismatched = []
    for k in sorted(base):
        sigs = {
            name: tuple(sorted(set(RE_SUB.findall(d[k]["message"]))))
            for name, d in names.items()
            if k in d
        }
        if len(set(sigs.values())) > 1:
            mismatched.append((k, sigs))
    if mismatched:
        for k, sigs in mismatched:
            errors.append(f"占位符不一致 {k}: {sigs}")
    else:
        ok("全部 key 的 $1/$2 占位符跨语言一致")

    # ── 4. 代码引用 vs 语言包 ──
    used = {}
    scan = (
        glob.glob("**/*.js", recursive=True)
        + glob.glob("**/*.html", recursive=True)
        + ["manifest.json"]
    )
    for f in scan:
        # dist/ 是上一轮 pack.sh 的产物，内容滞后一轮，扫它只会误报
        if (
            f.startswith("docs" + os.sep)
            or f.startswith("dist" + os.sep)
            or (os.sep + "dist" + os.sep) in f
            or "node_modules" in f
        ):
            continue
        s = strip_comments(io.open(f, encoding="utf-8").read())
        for rx in (RE_CALL, RE_ATTR, RE_MSG):
            for m in rx.finditer(s):
                used.setdefault(m.group(1), set()).add(f)

    # t("plat_" + platform) 这类动态拼接：捕获到的是前缀（甚至只有一个下划线），
    # 不是完整 key，不能当缺失处理
    is_dynamic = lambda k: k in DYNAMIC_PREFIXES or any(
        k and p.startswith(k) for p in DYNAMIC_PREFIXES
    )
    missing = sorted(k for k in used if k not in base and not is_dynamic(k))
    # 只统计真正被引用的 key，把动态拼接前缀排掉
    referenced = {k for k in used if not is_dynamic(k)}
    dynamic = {k for k in base if k.startswith(DYNAMIC_PREFIXES)}
    unused = sorted(k for k in base - referenced - dynamic - LOOKUP_KEYS)

    if missing:
        for k in missing:
            errors.append(f"代码引用了不存在的 key: {k}  ← {', '.join(sorted(used[k]))}")
    else:
        ok(f"代码引用的 {len(used)} 个 key 全部存在")

    if unused:
        print(f"\033[33m!\033[0m 语言包里没被引用的 key（{len(unused)}）: {', '.join(unused)}")

    # ── 汇总 ──
    print()
    if errors:
        for e in errors:
            fail(e)
        print(f"\n\033[31m{len(errors)} 项校验失败\033[0m")
        return 1
    print("\033[32m全部校验通过\033[0m")
    return 0


if __name__ == "__main__":
    sys.exit(main())
