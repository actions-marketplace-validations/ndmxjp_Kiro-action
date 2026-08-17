#!/usr/bin/env python3
"""Generate the animated "working" indicator used in the tracking comment.

Writes RGBA PNG frames and hands them to ffmpeg to assemble an APNG (which keeps
the alpha channel, so the icon sits on either GitHub theme) and a GIF fallback.

Two modes:

    --mode arc              a rotating violet arc, owing nothing to anyone
    --mode pulse --logo P   an existing icon, breathing

`pulse` exists so the Kiro mark can be used without being altered: every frame
holds the source pixels exactly as they are and only the overall alpha changes, so
the mark is never rotated, cropped, recoloured, or resampled. At the ~14px the
comment renders it at, a ring around the mark would collapse to less than a pixel,
which is why the motion is a fade rather than a spinner.

Usage:
    python3 scripts/make-working-indicator.py --mode arc
    python3 scripts/make-working-indicator.py --mode pulse --logo assets/kiro-mark.png

Requires ffmpeg on PATH. No Python dependencies — the PNG encoder is inline, and
decoding is handed to ffmpeg, because the machines this runs on have no imaging
library.
"""

from __future__ import annotations

import argparse
import math
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

FRAMES = 12
FRAME_DELAY_MS = 80
# Violet, legible on GitHub's light and dark themes alike.
ARC_RGB = (124, 58, 237)
TRACK_RGB = (124, 58, 237)
TRACK_ALPHA = 60
# Supersampling factor: the icon renders at ~14px, so edges need the help.
SS = 4


def write_png(path: Path, width: int, height: int, pixels: bytes) -> None:
    """Minimal RGBA PNG writer (filter type 0, one IDAT)."""

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)  # no per-scanline filtering
        raw += pixels[y * stride : (y + 1) * stride]

    header = struct.pack(">2I5B", width, height, 8, 6, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def render_frame(size: int, turn: float) -> bytes:
    """One frame of a rotating arc, supersampled then boxed down."""
    big = size * SS
    centre = (big - 1) / 2
    outer = big * 0.46
    inner = big * 0.30

    # Accumulate coverage and colour at the supersampled resolution.
    coverage = [0.0] * (big * big)
    colours: list[tuple[int, int, int]] = [(0, 0, 0)] * (big * big)

    sweep = math.pi * 1.35  # how much of the ring the moving arc covers
    start = turn * math.tau

    for y in range(big):
        dy = y - centre
        for x in range(big):
            dx = x - centre
            distance = math.hypot(dx, dy)
            if not (inner <= distance <= outer):
                continue

            angle = (math.atan2(dy, dx) - start) % math.tau
            index = y * big + x
            if angle <= sweep:
                # Fade the arc along its length so it reads as motion.
                falloff = 1.0 - (angle / sweep) ** 1.5
                coverage[index] = 0.15 + 0.85 * falloff
                colours[index] = ARC_RGB
            else:
                coverage[index] = TRACK_ALPHA / 255
                colours[index] = TRACK_RGB

    # Box-filter down to the requested size.
    out = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            alpha_sum = 0.0
            r_sum = g_sum = b_sum = 0.0
            for sy in range(SS):
                row = (y * SS + sy) * big
                for sx in range(SS):
                    index = row + x * SS + sx
                    alpha = coverage[index]
                    if alpha <= 0:
                        continue
                    r, g, b = colours[index]
                    alpha_sum += alpha
                    r_sum += r * alpha
                    g_sum += g * alpha
                    b_sum += b * alpha
            samples = SS * SS
            alpha = alpha_sum / samples
            offset = (y * size + x) * 4
            if alpha_sum > 0:
                out[offset] = round(r_sum / alpha_sum)
                out[offset + 1] = round(g_sum / alpha_sum)
                out[offset + 2] = round(b_sum / alpha_sum)
            out[offset + 3] = round(max(0.0, min(1.0, alpha)) * 255)
    return bytes(out)


# How far the mark fades at the dimmest point of the cycle.
PULSE_FLOOR = 0.35


def read_rgba(path: Path) -> tuple[int, int, bytes]:
    """Decode an image to raw RGBA via ffmpeg, since there is no decoder here."""
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0", str(path)],
        check=True, capture_output=True, text=True,
    )
    width, height = (int(value) for value in probe.stdout.strip().split(",")[:2])
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-frames:v", "1",
         "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
        check=True, capture_output=True,
    )
    return width, height, raw.stdout


def render_pulse_frame(pixels: bytes, factor: float) -> bytes:
    """The source image with its alpha scaled — colour channels untouched."""
    out = bytearray(pixels)
    for offset in range(3, len(out), 4):
        out[offset] = round(out[offset] * factor)
    return bytes(out)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out-dir", default="assets", type=Path)
    parser.add_argument("--size", default=48, type=int)
    parser.add_argument("--mode", default="arc", choices=("arc", "pulse"))
    parser.add_argument("--logo", type=Path, help="source icon for --mode pulse")
    parser.add_argument("--name", default=None, help="output basename")
    args = parser.parse_args()

    if args.mode == "pulse" and not args.logo:
        print("--mode pulse needs --logo", file=sys.stderr)
        return 1

    if not shutil.which("ffmpeg"):
        print("ffmpeg is required and was not found on PATH", file=sys.stderr)
        return 1

    args.out_dir.mkdir(parents=True, exist_ok=True)
    stem = args.name or ("kiro-working" if args.mode == "arc" else "kiro-mark-working")
    apng = args.out_dir / f"{stem}.png"
    gif = args.out_dir / f"{stem}.gif"

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        if args.mode == "arc":
            width = height = args.size
            for index in range(FRAMES):
                frame = render_frame(args.size, index / FRAMES)
                write_png(tmp_path / f"frame{index:03d}.png", width, height, frame)
        else:
            width, height, source = read_rgba(args.logo)
            for index in range(FRAMES):
                # Smooth in and out, so there is no visible seam on loop.
                phase = 0.5 + 0.5 * math.cos(math.tau * index / FRAMES)
                factor = PULSE_FLOOR + (1 - PULSE_FLOOR) * phase
                frame = render_pulse_frame(source, factor)
                write_png(tmp_path / f"frame{index:03d}.png", width, height, frame)
        print(f"rendered {FRAMES} {args.mode} frames at {width}x{height}")

        fps = 1000 / FRAME_DELAY_MS
        common = ["-y", "-framerate", f"{fps:g}", "-i", str(tmp_path / "frame%03d.png")]

        subprocess.run(
            ["ffmpeg", *common, "-plays", "0", "-f", "apng", str(apng)],
            check=True,
            capture_output=True,
        )
        # GIF has one transparent index rather than an alpha channel, so reserve
        # one and dither nothing, which keeps the arc's edges from speckling.
        subprocess.run(
            [
                "ffmpeg", *common, "-loop", "0",
                "-filter_complex",
                "[0:v]split[a][b];[a]palettegen=reserve_transparent=1[p];"
                "[b][p]paletteuse=dither=none:alpha_threshold=128",
                str(gif),
            ],
            check=True,
            capture_output=True,
        )

    for path in (apng, gif):
        print(f"{path}: {path.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
