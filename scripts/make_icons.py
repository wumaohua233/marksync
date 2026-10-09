#!/usr/bin/env python3
"""生成扩展图标：圆角方形 + 白色书签 + 环形同步箭头。

三个设计决定：

1. **4× 超采样再降采样做抗锯齿。** 上一版是逐像素硬判定，所有斜边都是锯齿。

2. **形状 = 书签 + 开口圆环。** 书签是「mark」，环绕的开口圆环是「sync」。
   缺口留在正上方，箭头在缺口左侧、指向顺时针方向，读起来就是「在转」。

3. **16px 用简化版本，只画书签，不画环。** 环在 16px 下的笔画只有 1.3px，
   抗锯齿之后和书签糊成一团。与其在工具栏里显示一坨红白相间的噪点，
   不如让书签撑满、清清楚楚。32px 以上才上完整版。

无第三方依赖，手写 PNG 编码。
"""
import math
import os
import struct
import zlib

SS = 4  # 超采样倍数

RED_TOP = (255, 78, 100)   # #FF4E64
RED_BOT = (238, 24, 62)    # #EE183E

CORNER = 0.2237            # iOS 圆角比例（22.37%）

# 同步环
R_OUT, R_IN = 0.408, 0.326
R_MID = (R_OUT + R_IN) / 2
GAP0, GAP1 = 236.0, 302.0  # 缺口（270° = 正上方）
A_HEAD = 0.085             # 箭头伸出长度
A_WIDE = 0.044             # 箭头比环宽略宽，才看得出是箭头

# 两套几何：完整版 / 16px 简化版
FULL = dict(ring=True, bx0=0.354, bx1=0.646, by0=0.292, by1=0.702, br=0.048, notch=0.548)
SIMPLE = dict(ring=False, bx0=0.256, bx1=0.744, by0=0.194, by1=0.794, br=0.068, notch=0.552)


def geo_for(size):
    return SIMPLE if size <= 16 else FULL


def pt(a, r):
    """角度（度）+ 半径 → 归一化坐标。0° 向右，90° 向下（屏幕坐标）。"""
    t = math.radians(a)
    return (0.5 + r * math.cos(t), 0.5 + r * math.sin(t))


def arrow_triangle():
    """缺口左侧那端的箭头。切线方向 = 角度增大方向（屏幕上就是顺时针）。

    底边刻意往弧内退 5°，让箭头和弧端有重叠——否则小尺寸下箭头和圆环之间
    会露出一道缝，看起来像断开的两个东西。
    """
    t = math.radians(GAP0)
    tx, ty = -math.sin(t), math.cos(t)
    mx, my = pt(GAP0, R_MID)
    tip = (mx + tx * A_HEAD, my + ty * A_HEAD)
    return tip, pt(GAP0 - 5, R_OUT + A_WIDE), pt(GAP0 - 5, R_IN - A_WIDE)


TRI = arrow_triangle()


def in_squircle(x, y):
    cx = min(max(x, CORNER), 1 - CORNER)
    cy = min(max(y, CORNER), 1 - CORNER)
    return (x - cx) ** 2 + (y - cy) ** 2 <= CORNER ** 2


def in_ring(x, y):
    dx, dy = x - 0.5, y - 0.5
    d = math.hypot(dx, dy)
    if not (R_IN <= d <= R_OUT):
        return False
    a = math.degrees(math.atan2(dy, dx)) % 360
    return not (GAP0 <= a <= GAP1)


def in_tri(px, py, tri):
    a, b, c = tri

    def sign(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])

    d1, d2, d3 = sign((px, py), a, b), sign((px, py), b, c), sign((px, py), c, a)
    return not ((d1 < 0 or d2 < 0 or d3 < 0) and (d1 > 0 or d2 > 0 or d3 > 0))


def in_bookmark(x, y, g):
    x0, x1, y0, y1, r, ny = g["bx0"], g["bx1"], g["by0"], g["by1"], g["br"], g["notch"]
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    if y < y0 + r:                                  # 顶部两角圆角
        cx = x0 + r if x < x0 + r else x1 - r
        if (x - cx) ** 2 + (y - (y0 + r)) ** 2 > r ** 2:
            return False
    if y > ny:                                      # 底部 V 形缺口
        half = ((x1 - x0) / 2) * ((y - ny) / (y1 - ny))
        if abs(x - 0.5) < half:
            return False
    return True


def sample(x, y, g):
    if not in_squircle(x, y):
        return (0, 0, 0, 0)
    white = (255, 255, 255, 255)
    if in_bookmark(x, y, g):
        return white
    if g["ring"] and (in_ring(x, y) or in_tri(x, y, TRI)):
        return white
    t = y                                            # 上亮下深，避免大色块发闷
    return tuple(round(RED_TOP[i] + (RED_BOT[i] - RED_TOP[i]) * t) for i in range(3)) + (255,)


def make_png(size, path, ss=SS):
    g = geo_for(size)
    S = size * ss
    hi = bytearray()
    for gy in range(S):
        for gx in range(S):
            hi.append(1 if sample((gx + 0.5) / S, (gy + 0.5) / S, g)[3] else 0)

    rows = []
    n = ss * ss
    for y in range(size):
        row = bytearray()
        for x in range(size):
            acc = [0, 0, 0, 0]
            for dy in range(ss):
                base = (y * ss + dy) * S + x * ss
                for dx in range(ss):
                    if hi[base + dx]:
                        c = sample((x * ss + dx + 0.5) / S, (y * ss + dy + 0.5) / S, g)
                        for i in range(4):
                            acc[i] += c[i]
            row.extend(bytes(round(v / n) for v in acc))
        rows.append(b"\x00" + bytes(row))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)


if __name__ == "__main__":
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
    os.makedirs(out, exist_ok=True)
    for s in (16, 32, 48, 128):
        p = os.path.join(out, f"{s}.png")
        make_png(s, p)
        print(f"  {s:>3}px  {os.path.getsize(p):>5} bytes  {'简化版（无环）' if not geo_for(s)['ring'] else '完整版'}")
