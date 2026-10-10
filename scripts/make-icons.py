#!/usr/bin/env python3
"""从 build/icon.png 生成 electron-builder 需要的多尺寸图标（build/icons/*.png）。"""

import os
import sys

from PIL import Image

SIZES = (16, 32, 48, 64, 128, 256, 512)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "build", "icon.png")
TARGET = os.path.join(ROOT, "build", "icons")


def main() -> int:
    if not os.path.isfile(SOURCE):
        print(f"缺少源图标：{SOURCE}", file=sys.stderr)
        return 1
    image = Image.open(SOURCE).convert("RGBA")
    os.makedirs(TARGET, exist_ok=True)
    for size in SIZES:
        image.resize((size, size), Image.LANCZOS).save(os.path.join(TARGET, f"{size}x{size}.png"))
    print(f"已生成 {len(SIZES)} 个尺寸到 {TARGET}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
