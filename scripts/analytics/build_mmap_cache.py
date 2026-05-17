#!/usr/bin/env python3
"""2026-05-17 Memory-mapped Candle Cache Builder.

Converts JSON-cache to fixed-stride binary `.dat` files for memory-mapped
zero-copy reads. Layout per candle (56 bytes, packed):
  open_time: i64 (8b)
  close_time: i64 (8b)
  open: f64 (8b)
  high: f64 (8b)
  low: f64 (8b)
  close: f64 (8b)
  volume: f64 (8b)

Header (32 bytes):
  magic: 4b = b'FTMC'
  version: u32 = 1
  n_candles: u64
  stride: u32 = 56
  reserved: 12b

Total file size = 32 + n × 56 bytes.

Usage:
  python3 scripts/analytics/build_mmap_cache.py \\
      --in scripts/cache_bakeoff/BTCUSDT_30m.json \\
      --out scripts/cache_bakeoff_mmap/BTCUSDT_30m.dat
"""
import argparse
import json
import struct
from pathlib import Path

MAGIC = b"FTMC"
VERSION = 1
STRIDE = 56  # 7 × 8 bytes
HEADER_SIZE = 32

def build(in_path, out_path):
    data = json.loads(Path(in_path).read_text())
    n = len(data)
    print(f"  {in_path.name}: {n} candles → {out_path.name}")
    with open(out_path, "wb") as f:
        # Header
        f.write(MAGIC)
        f.write(struct.pack("<I", VERSION))
        f.write(struct.pack("<Q", n))
        f.write(struct.pack("<I", STRIDE))
        f.write(b"\x00" * 12)  # reserved
        # Candles
        for c in data:
            f.write(struct.pack("<qqddddd",
                int(c.get("open_time", c.get("openTime", 0))),
                int(c.get("close_time", c.get("closeTime", 0))),
                float(c["open"]), float(c["high"]),
                float(c["low"]), float(c["close"]), float(c["volume"])))
    file_size = out_path.stat().st_size
    expected = HEADER_SIZE + n * STRIDE
    assert file_size == expected, f"size mismatch: {file_size} != {expected}"
    return n

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in-dir", default="scripts/cache_bakeoff")
    ap.add_argument("--out-dir", default="scripts/cache_bakeoff_mmap")
    ap.add_argument("--pattern", default="*_30m.json")
    args = ap.parse_args()
    in_dir = Path(args.in_dir)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    inputs = sorted(in_dir.glob(args.pattern))
    print(f"Converting {len(inputs)} files {args.in_dir} → {args.out_dir} (.dat)")
    total = 0
    for f in inputs:
        out_path = out_dir / f.with_suffix(".dat").name
        total += build(f, out_path)
    print(f"\n✅ {len(inputs)} files, {total} total candles, stride={STRIDE}b, header={HEADER_SIZE}b")
    # Sanity-check: round-trip first file
    if inputs:
        f0 = inputs[0]
        out0 = out_dir / f0.with_suffix(".dat").name
        with open(out0, "rb") as fp:
            magic = fp.read(4); ver = struct.unpack("<I", fp.read(4))[0]
            n_chk = struct.unpack("<Q", fp.read(8))[0]
            stride = struct.unpack("<I", fp.read(4))[0]
            fp.read(12)  # skip reserved
            first = struct.unpack("<qqddddd", fp.read(STRIDE))
        orig = json.loads(f0.read_text())[0]
        print(f"\nRoundtrip check on {f0.name}:")
        print(f"  magic={magic} ver={ver} n={n_chk} stride={stride}")
        print(f"  first candle ts={first[0]} O={first[2]:.4f} H={first[3]:.4f} L={first[4]:.4f} C={first[5]:.4f}")
        print(f"  orig candle              O={orig['open']:.4f} H={orig['high']:.4f} L={orig['low']:.4f} C={orig['close']:.4f}")
        assert abs(first[2] - orig["open"]) < 1e-6, "open mismatch"
        print(f"  ✅ Roundtrip OK")

if __name__ == "__main__":
    main()
