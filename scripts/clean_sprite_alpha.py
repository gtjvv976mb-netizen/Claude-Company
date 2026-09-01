#!/usr/bin/env python3
"""Clean low-alpha WebP debris without changing sprite geometry or frame layout."""
from pathlib import Path
import argparse
from PIL import Image


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("source", type=Path)
    ap.add_argument("output", type=Path)
    ap.add_argument("--cut", type=int, default=24)
    args = ap.parse_args()
    im = Image.open(args.source).convert("RGBA")
    out = Image.new("RGBA", im.size, (0, 0, 0, 0))
    src, dst = im.load(), out.load()
    removed = 0
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = src[x, y]
            if a < args.cut:
                if a:
                    removed += 1
                continue
            # Expand the remaining alpha range after the cut so silhouettes stay crisp at mobile
            # scale while retaining antialiasing above the threshold.
            na = round((a - args.cut) * 255 / (255 - args.cut))
            dst[x, y] = (r, g, b, na)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    out.save(args.output, lossless=True, quality=100, method=6)
    print(f"{args.source.name}: {im.size[0]}x{im.size[1]}, removed={removed}, saved={args.output}")


if __name__ == "__main__":
    main()
