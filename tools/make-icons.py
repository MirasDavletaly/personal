#!/usr/bin/env python3
"""Draws the home-screen icons (PNG) with the standard library only, matching
src/web/public/favicon.svg: blue square, green corner, white "TK".

  python -I tools/make-icons.py src/web/public
"""
import math
import struct
import sys
import zlib

SKY = (0x1D, 0x5F, 0x9E)
STEPPE = (0x1C, 0x7A, 0x50)
WHITE = (255, 255, 255)


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def letter(u, v):
    """True if (u, v) in 64-unit coordinates is inside the white letters."""
    if 13 <= u <= 31 and 20 <= v <= 25.5:  # T bar
        return True
    if 19.4 <= u <= 24.6 and 20 <= v <= 44:  # T stem
        return True
    if 34 <= u <= 39.2 and 20 <= v <= 44:  # K stem
        return True
    if seg_dist(u, v, 38, 33.5, 49.5, 21) <= 2.7:  # K upper arm
        return True
    if seg_dist(u, v, 40.5, 30.5, 50, 43) <= 2.7:  # K lower leg
        return True
    return False


def render(size, rounded):
    ss = 4
    radius = 14 / 64 * size if rounded else 0
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            r = g = b = a = 0.0
            for sy in range(ss):
                for sx in range(ss):
                    px, py = x + (sx + 0.5) / ss, y + (sy + 0.5) / ss
                    if radius:
                        cx = min(max(px, radius), size - radius)
                        cy = min(max(py, radius), size - radius)
                        if math.hypot(px - cx, py - cy) > radius:
                            continue
                    u, v = px / size * 64, py / size * 64
                    col = WHITE if letter(u, v) else STEPPE if u + v > 90 else SKY
                    r, g, b, a = r + col[0], g + col[1], b + col[2], a + 1
            n = ss * ss
            if a:
                row += bytes((round(r / a), round(g / a), round(b / a), round(255 * a / n)))
            else:
                row += bytes((0, 0, 0, 0))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main():
    out = sys.argv[1]
    for name, size, rounded in [("apple-touch-icon.png", 180, False), ("icon-192.png", 192, True), ("icon-512.png", 512, True)]:
        with open(f"{out}/{name}", "wb") as f:
            f.write(render(size, rounded))
        print(name, size)


if __name__ == "__main__":
    main()
