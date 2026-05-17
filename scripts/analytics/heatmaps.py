#!/usr/bin/env python3
"""2026-05-17 Heatmap-Generator für FTMO Hunt analysis.

Outputs 4 PNGs into scripts/cache_bakeoff/hunt_2026_05_16/heatmaps/:
1. cross_config_corr.png - 10×10 correlation matrix per-window-AND outcomes
2. per_window_passfail.png - 329 windows × 10 configs timeline
3. p1_vs_p2_per_config.png - bar chart P1 vs P2 per config
4. asset_basket_perf.png - if per-asset data available
"""
import json
from pathlib import Path
import sys

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import seaborn as sns
    import numpy as np
except ImportError as e:
    print(f"ERROR: {e}\nRun: pip install --user --break-system-packages matplotlib seaborn numpy")
    sys.exit(1)

OUT = Path("scripts/cache_bakeoff/hunt_2026_05_16/multi_account")
HEATMAP_DIR = Path("scripts/cache_bakeoff/hunt_2026_05_16/heatmaps")
HEATMAP_DIR.mkdir(parents=True, exist_ok=True)
LABELS = ["A_amber","B_titanium","C_obsidian","D_topaz","E_rubin","F_sapphir","G_diamond","H_amber_ds","I_amber_atr","J_r28_v6"]

def load(label):
    p1 = {json.loads(l)["win_idx"]: json.loads(l)["passed"]
          for l in (OUT/f"{label}_p1.jsonl").read_text().splitlines() if l.strip()}
    p2 = {json.loads(l)["win_idx"]: json.loads(l)["passed"]
          for l in (OUT/f"{label}_p2.jsonl").read_text().splitlines() if l.strip()}
    keys = sorted(set(p1) & set(p2))
    return label, [p1[k] and p2[k] for k in keys], [p1[k] for k in keys], [p2[k] for k in keys]

print("Loading 10 configs...")
configs = [load(l) for l in LABELS]
min_n = min(len(c[1]) for c in configs)

# Heatmap 1: Cross-Config Correlation
print("Heatmap 1/4: cross-config correlation matrix")
arrs = np.array([c[1][:min_n] for c in configs], dtype=float)
corr = np.corrcoef(arrs)
plt.figure(figsize=(10, 8))
sns.heatmap(corr, annot=True, fmt=".2f", xticklabels=LABELS, yticklabels=LABELS,
            cmap="RdBu_r", center=0, vmin=-1, vmax=1)
plt.title("Cross-Config Per-Window-AND Correlation Matrix")
plt.tight_layout()
plt.savefig(HEATMAP_DIR/"01_cross_config_corr.png", dpi=120)
plt.close()

# Heatmap 2: Per-Window Pass/Fail Timeline
print("Heatmap 2/4: per-window pass/fail timeline")
plt.figure(figsize=(16, 5))
sns.heatmap(arrs, cmap="RdYlGn", cbar_kws={"label": "Pass(1)/Fail(0)"},
            xticklabels=False, yticklabels=LABELS, linewidths=0)
plt.title(f"Per-Window Pass/Fail Timeline ({min_n} windows × 10 configs)")
plt.xlabel("Window index (chronological)")
plt.tight_layout()
plt.savefig(HEATMAP_DIR/"02_per_window_passfail.png", dpi=120)
plt.close()

# Heatmap 3: P1 vs P2 per config (bar chart not heatmap, but useful)
print("Heatmap 3/4: P1 vs P2 per config")
p1_rates = [100*sum(c[2][:min_n])/min_n for c in configs]
p2_rates = [100*sum(c[3][:min_n])/min_n for c in configs]
combined = [100*sum(c[1][:min_n])/min_n for c in configs]
fig, ax = plt.subplots(figsize=(12, 6))
x = np.arange(len(LABELS))
w = 0.27
ax.bar(x - w, p1_rates, w, label="P1 only", color="steelblue")
ax.bar(x, p2_rates, w, label="P2 only", color="darkorange")
ax.bar(x + w, combined, w, label="P1 AND P2 (per-win)", color="forestgreen")
ax.set_xticks(x); ax.set_xticklabels(LABELS, rotation=45, ha="right")
ax.set_ylabel("Pass-Rate %"); ax.set_title("Per-Config: P1, P2, and Combined Per-Win-AND")
ax.axhline(50, color="red", linestyle="--", alpha=0.5, label="50% threshold")
ax.axhline(60, color="purple", linestyle="--", alpha=0.5, label="60% threshold")
ax.legend(); ax.grid(axis="y", alpha=0.3)
plt.tight_layout()
plt.savefig(HEATMAP_DIR/"03_p1_p2_per_config.png", dpi=120)
plt.close()

# Heatmap 4: All-Stack OR (Cumulative)
print("Heatmap 4/4: cumulative OR-stack progression")
sorted_idx = sorted(range(len(configs)), key=lambda i: -combined[i])
cum_or = np.zeros((len(configs), min_n))
running = np.zeros(min_n, dtype=bool)
for rank, idx in enumerate(sorted_idx):
    running = running | np.array(configs[idx][1][:min_n])
    cum_or[rank] = running.astype(float)
plt.figure(figsize=(16, 5))
labels_ordered = [LABELS[i] for i in sorted_idx]
sns.heatmap(cum_or, cmap="Greens", cbar_kws={"label": "Cumulative OR-pass"},
            xticklabels=False, yticklabels=labels_ordered, linewidths=0)
plt.title(f"Cumulative OR-Stack Progression (adding configs sorted by single-Combined)")
plt.xlabel("Window index")
plt.ylabel("Stack additions (top-down)")
plt.tight_layout()
plt.savefig(HEATMAP_DIR/"04_cumulative_or_stack.png", dpi=120)
plt.close()

print(f"\n✅ 4 heatmaps generated in {HEATMAP_DIR}/")
for f in sorted(HEATMAP_DIR.glob("*.png")):
    print(f"  {f.stat().st_size:>8} bytes  {f.name}")
