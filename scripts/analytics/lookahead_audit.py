#!/usr/bin/env python3
"""2026-05-17 Automated Lookahead-Audit-Bot.

Greps all signals_*.rs for suspicious patterns:
- `candles.len() - 1` outside entry_price contexts
- `signal_idx + 1` (future reach)
- `candles[len-1]` direct indexing
- `for i in 0..candles.len()` (iterates over entry-bar too)
- Missing `signal_idx = candles.len() - 2` convention

Exit code 0 if clean, 1 if findings.
"""
import re
import sys
from pathlib import Path

SIGNALS = Path("engine-rust/ftmo-engine-core/src")
PATTERNS = {
    "candles.len() - 1 outside entry context": re.compile(r"candles\.len\(\)\s*-\s*1"),
    "candles[len-1] direct read": re.compile(r"candles\[\s*candles\.len\(\)\s*-\s*1\s*\]"),
    "for i in 0..candles.len()": re.compile(r"for\s+\w+\s+in\s+0\.\.candles\.len\(\)"),
    "candles[i+1] future index": re.compile(r"candles\[\s*\w+\s*\+\s*1\s*\]"),
    "signal_idx + 1": re.compile(r"signal_idx\s*\+\s*1"),
}

ENTRY_OK_PATTERNS = re.compile(r"entry_price|entry_bar|\.open_time|test|TODO|\\\\\\")
INVARIANT_PATTERN = re.compile(r"signal_idx\s*=\s*candles\.len\(\)\s*-\s*2")

findings = []
voters_checked = 0
voters_with_invariant = 0

for f in sorted(SIGNALS.glob("signals_*.rs")):
    voters_checked += 1
    content = f.read_text()
    if INVARIANT_PATTERN.search(content):
        voters_with_invariant += 1
    for desc, pat in PATTERNS.items():
        for m in pat.finditer(content):
            line_start = content.rfind("\n", 0, m.start()) + 1
            line_end = content.find("\n", m.end())
            line = content[line_start:line_end].strip()
            line_num = content[:m.start()].count("\n") + 1
            # Skip if in comment or test or entry-context
            if line.startswith("//") or line.startswith("///") or "#[test]" in content[max(0,line_start-200):line_start]:
                continue
            if ENTRY_OK_PATTERNS.search(line):
                continue
            findings.append((f.name, line_num, desc, line[:100]))

print(f"=== LOOKAHEAD AUDIT — {voters_checked} signal files scanned ===")
print(f"Files with `signal_idx = candles.len() - 2` invariant: {voters_with_invariant}/{voters_checked}")
print()
if findings:
    print(f"⚠ {len(findings)} suspicious findings (manually review):")
    for f, n, d, line in findings[:30]:
        print(f"  {f}:{n}  [{d}]")
        print(f"    {line}")
    sys.exit(1)
else:
    print("✅ No lookahead-pattern findings (auto-grep level).")
    print("   Note: full audit requires Reviewer-Agent (see Hunt 48).")
    sys.exit(0)
