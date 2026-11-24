# trellis

A multiplayer design canvas in the browser, in the class of Figma, built on a CRDT so several people can edit the same document at once, keep editing offline, and merge without losing anything. Plain JavaScript, no dependencies, no build step: the server is Node 22's standard library, including its own WebSocket implementation.

Today it has frames (which nest), rectangles, ellipses and text, a layers panel, a properties panel, drag to move and drag into a frame to reparent, live cursors, an offline switch, and a server that keeps the document as an append-only op log. The goal is much bigger: components with overrides, auto-layout that matches CSS flexbox, a pen tool with boolean operations, undo that respects other people's edits, history and branching, SVG and PDF export, and eight people hammering the same document without it ever diverging or losing a shape.

```
$ node tools/check.mjs
check            result          value  threshold  measures
fracindex        PASS                0          0  keys from between(a, b) not strictly between, or ending in the lowest digit, of 20 000
converged        PASS                0          0  fuzz seeds where replicas end in different states, of 500 (4 replicas, reordered + duplicated delivery)
tree-valid       KNOWN GAP       0.082          0  fraction of fuzz seeds where concurrent moves make a parent cycle and shapes vanish
sibling-ties     KNOWN GAP           1          0  fraction of concurrent same-position inserts that end with two siblings sharing an order key
ws-framing       PASS                0          0  WebSocket frames (0-70 000 bytes, masked, fragmented, split byte by byte) decoded wrong
live-sync        PASS                0          0  3 WebSocket clients + server not identical after 300 edits (client 2 offline for 120 of them)
restart          PASS                0          0  server restarted from its op log, or a new client, sees a different document
replay-100k      PASS          83.8493        300  ms to replay a 100 000-op log at start-up (10.4 MB, no snapshots)

0 failed, 2 known gaps (3.4 s)
```

## Run it

Needs Node 22 or newer. Nothing to install.

```
node server/server.mjs --port 8090     # then open http://127.0.0.1:8090/ in two windows
npm test                               # unit tests (node --test)
node tools/check.mjs                   # the table above
node tools/fuzz.mjs --seeds 500        # convergence fuzzer on its own (--seed N --verbose for one)
python3 tools/mutants.py               # plants bugs, reports what catches each
```

Keys: V select, F frame, R rectangle, O ellipse, T text, Delete removes. Drag a shape onto a frame to move it inside.

## How it works

```
src/crdt.js        the document: every node is a set of last-writer-wins registers (one per
                   property, plus parent, order and deleted) stamped with Lamport timestamps
                   [counter, replica]; ops are idempotent and commute, so replicas that saw the
                   same ops agree whatever the order or duplication
src/fracindex.js   order keys between two siblings (base-62 strings), so inserting never
                   renumbers anything
src/sync.js        client sync: local ops apply at once, queue, send when the socket is open,
                   re-send after a reconnect; backlog from the server on (re)connect
server/ws.mjs      RFC 6455: handshake, masked/fragmented/16- and 64-bit frames, ping/pong, close
server/server.mjs  static files, relay, append-only op log per document, replay at start-up
web/               the editor (canvas 2D)
tools/fuzz.mjs     random replicas, random delivery order with delays and duplicates
```

## Known gaps

These are measured. They are the roadmap.

1. **Concurrent moves can make a parent cycle.** `parent` is a plain last-writer-wins register. If one person drags frame A into frame B while someone else drags B into A, both moves win somewhere. After merging, A and B are each other's parent, and both vanish from every replica together with everything inside them. It happens in 8.2% of fuzz seeds. Fixing it needs a move operation that keeps the tree a tree on every replica in the same way (for example Kleppmann et al.'s replicated tree with undo/redo of moves by timestamp), and it must not cost convergence.
2. **Concurrent inserts at the same spot tie.** Two people inserting at the same index generate the same fractional key every time. Ties are broken by node id, so replicas agree, but the order doesn't follow either person's intent, and a later insert "between" the two can't be placed between them. Keys need a per-replica component that still interleaves sensibly.
3. **The tests miss one thing.** `tools/mutants.py` plants 11 bugs and 10 are caught. Ordering siblings that share an order key by arrival instead of by id survives, because the convergence check compares registers, not the order the canvas draws.
4. **No snapshots or compaction.** The server replays the whole log at start-up (84 ms for 100,000 ops here) and sends a reconnecting client everything it missed op by op. Big documents and long histories need snapshots, compaction, and a checkpointed backlog.
5. **No undo.** There's no undo or redo, and making it work for one person among many (undo my change, not yours) is part of the CRDT design.
6. **No components, auto-layout, pen tool or export.** These are the main features of the end goal.

## Licence

MIT, see LICENSE.
