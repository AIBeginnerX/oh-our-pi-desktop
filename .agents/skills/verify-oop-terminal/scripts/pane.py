#!/usr/bin/env python3
"""Reads a `tmux capture-pane -p -e` file (.ansi). Subcommands:
  bar <f>     the Savvy bar row: plain text, filled/total cells, the label, and which cells are
              lit by the glow (cell colour differs from the base colour of the same glyph).
  right <f>   the plain text of the right pane (from the Workflow|Agents|Savvy|Files tab row).
  walker <f>  exit 1 and list rows if a half-block figure glyph is in the right pane below
              the "Crew" heading (the removed walking figure)."""
import re, sys
from collections import Counter

SGR = re.compile(r"\x1b\[([0-9;]*)m")

def cells(line):
    """[(char, fg)] where fg is the colour string active for that char (None = default)."""
    out, fg, pos = [], None, 0
    for m in SGR.finditer(line):
        out += [(c, fg) for c in line[pos:m.start()]]
        p = m.group(1).split(";") if m.group(1) else ["0"]
        i = 0
        while i < len(p):
            if p[i] in ("0", "39"): fg = None
            elif p[i] == "38" and i + 1 < len(p) and p[i + 1] == "2": fg = ",".join(p[i + 2:i + 5]); i += 4
            elif p[i] == "38" and i + 1 < len(p) and p[i + 1] == "5": fg = "c" + p[i + 2]; i += 2
            elif p[i] == "1": fg = (fg or "") + "+b"
            i += 1
        pos = m.end()
    return out + [(c, fg) for c in line[pos:]]

def right_col(lines):
    for l in lines:
        plain = SGR.sub("", l)
        if "Workflow │ Agents │ Savvy │ Files" in plain:
            return plain.index("Workflow │ Agents") - 2
    return None

def bar(path):
    lines = open(path, encoding="utf-8").read().split("\n")
    col = right_col(lines)
    if col is None: print("bar: no right pane / Savvy tab on screen"); return 1
    for l in lines:
        cs = cells(l)
        txt = "".join(c for c, _ in cs)
        if "▕" not in txt[col:] or "▏" not in txt[col:]: continue
        a, b = txt.index("▕", col) + 1, txt.index("▏", col)
        body = cs[a:b]
        base = {}
        for g in set(c for c, _ in body):
            base[g] = Counter(f for c, f in body if c == g).most_common(1)[0][0]
        lit = [i for i, (c, f) in enumerate(body) if f != base[c]]
        filled = sum(1 for c, _ in body if c not in "░ ")
        print(f"bar   {txt[a - 1:b + 1]}{txt[b + 1:].rstrip()[:30]}")
        print(f"cells {len(body)}  filled {filled}  fill-colour {Counter(f for c, f in body if c not in '░ ').most_common(1)}  glow-lit {lit if lit else 'none'}")
        return 0
    print("bar   (none: the Savvy pane shows no bar)"); return 0

def pane(path):
    lines = [SGR.sub("", l) for l in open(path, encoding="utf-8").read().split("\n")]
    col = right_col([l for l in lines])
    return [l[col:].rstrip() for l in lines] if col is not None else []

if __name__ == "__main__":
    cmd, path = sys.argv[1], sys.argv[2]
    if cmd == "bar": sys.exit(bar(path))
    rows = pane(path)
    if cmd == "right": print("\n".join(r for r in rows if r.strip()))
    elif cmd == "walker":
        i = next((n for n, r in enumerate(rows) if r.lstrip("│ ").startswith("Crew")), None)
        bad = [r for r in (rows[i:] if i is not None else []) if re.search("[▀▄]", r)]
        print("walker: none" if not bad else "walker rows:\n" + "\n".join(bad)); sys.exit(1 if bad else 0)
