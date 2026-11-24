"""Plant known bugs in trellis one at a time and report what catches each.

For every mutant: rewrite one file in a scratch copy, run the unit tests
(node --test) and tools/check.mjs. A mutant nothing catches is SURVIVED.

    python3 tools/mutants.py [--only NAME]
"""
import argparse
import glob
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MUTANTS = [
    ("tie-break-reversed", "src/crdt.js", "return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;",
     "return a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0;", "equal Lamport counters resolve towards the smaller replica id"),
    ("no-dedup", "src/crdt.js", "if (this.seen.has(key)) return false;", "",
     "an op delivered twice is applied and logged twice"),
    ("delete-ignored", "src/crdt.js", "[n.deleted] = lww(n.deleted, true, op.ts);", "",
     "delete ops do nothing"),
    ("children-no-id-tiebreak", "src/crdt.js", ": a.id < b.id ? -1 : a.id > b.id ? 1 : 0", ": 0",
     "siblings with equal order keys are ordered by arrival, not by id"),
    ("move-allows-own-subtree", "src/crdt.js", "if (id === parent || this.isAncestor(id, parent)) return null;",
     "if (id === parent) return null;", "a local move into your own subtree is allowed"),
    ("frac-mid-ceil", "src/fracindex.js", "const mid = Math.floor((da + db) / 2);", "const mid = Math.ceil((da + db) / 2);",
     "the midpoint digit can equal the upper bound"),
    ("ws-mask-wrong", "server/ws.mjs", "unmasked[i] = data[i] ^ mask[i & 3];", "unmasked[i] = data[i] ^ mask[i & 1];",
     "client frames unmasked with the wrong key bytes"),
    ("ws-len16-offset", "server/ws.mjs", "len = this.buf.readUInt16BE(2);", "len = this.buf.readUInt16BE(1) & 0xffff;",
     "16-bit payload length read from the wrong offset"),
    ("offline-edits-dropped", "src/sync.js", "    if (!op) return;\n    this.pending.push(op);",
     "    if (!op || this.offline) return;\n    this.pending.push(op);", "edits made while offline are never sent"),
    ("log-not-persisted", "server/server.mjs",
     "appendFileSync(logPath, fresh.map((op) => JSON.stringify(op) + \"\\n\").join(\"\"));", "",
     "the server never writes its op log"),
    ("backlog-off-by-one", "server/server.mjs", "ops: doc.log.slice(have)", "ops: doc.log.slice(have + 1)",
     "a reconnecting client misses one op from the backlog"),
]


def run(cmd, cwd, shell=False):
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=600, shell=shell)
    return p.returncode, p.stdout + p.stderr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only")
    args = ap.parse_args()
    todo = [m for m in MUTANTS if not args.only or m[0] == args.only]
    tmp = tempfile.mkdtemp(prefix="trellis-mutants-")
    src = os.path.join(tmp, "trellis")
    shutil.copytree(ROOT, src, ignore=shutil.ignore_patterns(".git", "node_modules", "__pycache__"))
    print(f"{'mutant':<26}{'tests':>8}{'checks':>9}   meaning")
    survived = []
    for name, rel, old, new, meaning in todo:
        path = os.path.join(src, rel)
        original = open(path).read()
        if original.count(old) != 1:
            print(f"{name:<26}   pattern found {original.count(old)} times in {rel}, expected 1")
            survived.append(name)
            continue
        open(path, "w").write(original.replace(old, new))
        tests = sorted(glob.glob(os.path.join(src, "tests", "*.test.mjs")))
        tcode, tout = run(["node", "--test", *tests], src)
        failed = [l.split("✖ ", 1)[1].split(" (")[0] for l in tout.splitlines() if l.startswith("✖ ") and "failing" not in l]
        ccode, cout = run(["node", "tools/check.mjs"], src)
        fails = [l.split()[0] for l in cout.splitlines() if " FAIL " in f" {l} " and not l.startswith("check")]
        caught = []
        if tcode:
            caught.append("tests: " + (", ".join(sorted(set(failed))) or "failed"))
        if ccode:
            caught.append("checks: " + (", ".join(fails) or "crashed"))
        print(f"{name:<26}{('fail' if tcode else 'pass'):>8}{(f'{len(fails)} fail' if ccode else 'pass'):>9}   "
              f"{'' if caught else 'SURVIVED  '}{meaning}")
        for c in caught:
            print(f"{'':<31}{c}")
        if not caught:
            survived.append(name)
        open(path, "w").write(original)
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{len(todo) - len(survived)}/{len(todo)} caught" + (f"; survived: {', '.join(survived)}" if survived else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
