#!/usr/bin/env python3
"""Convert a 4x5 generated character grid into a clean production sprite sheet.

The generator occasionally renders a checkerboard instead of alpha.  Background removal is
edge-connected and near-neutral, so white details inside a character (beard, eyes, highlights)
survive.  Every frame is fitted independently but grounded to one baseline per animation row.
"""
from collections import deque
from pathlib import Path
import argparse

from PIL import Image


def clear_connected_backdrop(im: Image.Image) -> Image.Image:
    px = im.convert("RGBA")
    w, h = px.size
    data = px.load()
    seen = bytearray(w * h)
    q: deque[tuple[int, int]] = deque()

    def backdrop(x: int, y: int) -> bool:
        r, g, b, _ = data[x, y]
        # Generated checkerboards range from white down to medium gray after antialiasing.
        # Connectivity, rather than brightness alone, protects the wizard's beard and highlights.
        return max(r, g, b) >= 168 and max(r, g, b) - min(r, g, b) <= 28

    for x in range(w):
        q.extend(((x, 0), (x, h - 1)))
    for y in range(h):
        q.extend(((0, y), (w - 1, y)))
    while q:
        x, y = q.popleft()
        i = y * w + x
        if seen[i] or not backdrop(x, y):
            continue
        seen[i] = 1
        r, g, b, _ = data[x, y]
        data[x, y] = (r, g, b, 0)
        if x: q.append((x - 1, y))
        if x + 1 < w: q.append((x + 1, y))
        if y: q.append((x, y - 1))
        if y + 1 < h: q.append((x, y + 1))

    # Feather only the remaining near-white fringe directly touching transparency.
    src = px.copy().load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = src[x, y]
            if a == 0:
                continue
            adjacent_clear = any(
                0 <= nx < w and 0 <= ny < h and src[nx, ny][3] == 0
                for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1))
            )
            if adjacent_clear and max(r, g, b) > 225 and max(r, g, b) - min(r, g, b) < 20:
                data[x, y] = (r, g, b, 0)
    return px


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("source", type=Path)
    ap.add_argument("output", type=Path)
    ap.add_argument("--cell-width", type=int, default=120)
    ap.add_argument("--cell-height", type=int, default=96)
    args = ap.parse_args()

    src = Image.open(args.source).convert("RGBA")
    sw, sh = src.size
    cols, rows = 4, 5
    frames: list[list[Image.Image]] = []
    boxes: list[list[tuple[int, int, int, int]]] = []
    for row in range(rows):
        frame_row, box_row = [], []
        for col in range(cols):
            crop = src.crop((round(col * sw / cols), round(row * sh / rows),
                             round((col + 1) * sw / cols), round((row + 1) * sh / rows)))
            clean = clear_connected_backdrop(crop)
            alpha_box = clean.getchannel("A").getbbox()
            if alpha_box is None:
                alpha_box = (0, 0, 1, 1)
            frame_row.append(clean)
            box_row.append(alpha_box)
        frames.append(frame_row)
        boxes.append(box_row)

    out = Image.new("RGBA", (args.cell_width * cols, args.cell_height * rows), (0, 0, 0, 0))
    for row in range(rows):
        # One scale per row prevents size pumping during animation. Leave a 5 px safety margin.
        max_w = max(b[2] - b[0] for b in boxes[row])
        max_h = max(b[3] - b[1] for b in boxes[row])
        scale = min((args.cell_width - 8) / max_w, (args.cell_height - 8) / max_h)
        for col in range(cols):
            b = boxes[row][col]
            art = frames[row][col].crop(b)
            nw = max(1, round(art.width * scale))
            nh = max(1, round(art.height * scale))
            art = art.resize((nw, nh), Image.Resampling.LANCZOS)
            # All frames share a row baseline at y=91; center horizontally.
            x = col * args.cell_width + (args.cell_width - nw) // 2
            y = row * args.cell_height + 91 - nh
            out.alpha_composite(art, (x, y))

    args.output.parent.mkdir(parents=True, exist_ok=True)
    out.save(args.output, lossless=True, quality=100, method=6)
    print(f"saved {args.output} {out.size} alpha={out.mode}")


if __name__ == "__main__":
    main()
