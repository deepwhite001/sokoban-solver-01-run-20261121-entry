// Sokoban solver for make.fun: "Build the best Sokoban solver, 21 November 2026".
//
// One run answers all 5 instances of a set. Each level is a hallway with
// 1-4 small rooms off it; boxes never leave their room, so every room is
// solved on its own with a push-optimal A* (minimum-matching heuristic,
// dead-square pruning) and the room solutions are stitched together with
// plain walks through the hallway. Only pushes are scored, so walk moves
// are free and the solver spends its effort on push-optimality.
//
// Deterministic by construction: budgets are node counts, never the clock,
// and every tie is broken by insertion order, so two runs byte-match.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR: string = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR: string = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Move directions in fixed order: up, down, left, right.
const DX: number[] = [0, 0, -1, 1];
const DY: number[] = [-1, 1, 0, 0];
const CH: string[] = ['u', 'd', 'l', 'r'];

// Deterministic work budgets (node expansions, never the clock).
const ROOM_ASTAR_CAP = 200000;
const ROOM_GREEDY_CAP = 200000;
const RUN_EXPANSION_BUDGET = 1000000;

let expansionsUsed = 0;

// Small binary min-heap. Order is (f, h, insertion sequence), so pops are
// fully deterministic for equal keys.
class Heap<T> {
  private items: { f: number; h: number; n: number; v: T }[] = [];
  private seq = 0;
  get size(): number {
    return this.items.length;
  }
  push(f: number, h: number, v: T): void {
    const e = { f, h, n: this.seq++, v };
    this.items.push(e);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(this.items[i], this.items[p])) {
        const t = this.items[i];
        this.items[i] = this.items[p];
        this.items[p] = t;
        i = p;
      } else {
        break;
      }
    }
  }
  pop(): T | undefined {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0 && last !== undefined) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && this.less(this.items[l], this.items[m])) m = l;
        if (r < this.items.length && this.less(this.items[r], this.items[m])) m = r;
        if (m === i) break;
        const t = this.items[i];
        this.items[i] = this.items[m];
        this.items[m] = t;
        i = m;
      }
    }
    return top === undefined ? undefined : top.v;
  }
  private less(
    a: { f: number; h: number; n: number },
    b: { f: number; h: number; n: number },
  ): boolean {
    if (a.f !== b.f) return a.f < b.f;
    if (a.h !== b.h) return a.h < b.h;
    return a.n < b.n;
  }
}

interface Level {
  w: number;
  h: number;
  floor: boolean[]; // indexed y*w+x, true unless '#'
  goals: number[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rawLines = text.split('\n');
  while (rawLines.length > 0 && rawLines[rawLines.length - 1].trim() === '') rawLines.pop();
  const h = rawLines.length;
  let w = 0;
  for (const l of rawLines) if (l.length > w) w = l.length;
  const floor: boolean[] = new Array(w * h).fill(false);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  for (let y = 0; y < h; y++) {
    const line = rawLines[y];
    for (let x = 0; x < w; x++) {
      const c = x < line.length ? line[x] : '#';
      const i = y * w + x;
      if (c === '#') continue;
      floor[i] = true;
      if (c === '.' || c === '*' || c === '+') goals.push(i);
      if (c === '$' || c === '*') boxes.push(i);
      if (c === '@' || c === '+') player = i;
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, floor, goals, boxes, player };
}

// Walk path from `from` to `to` over floor cells, avoiding `blocked` cells.
// Fixed neighbour order, so the path is deterministic. Null if unreachable.
function walkPath(
  w: number,
  h: number,
  floor: boolean[],
  blocked: Set<number>,
  from: number,
  to: number,
): string | null {
  if (from === to) return '';
  const prev = new Map<number, { p: number; ch: string }>();
  const q: number[] = [from];
  prev.set(from, { p: -1, ch: '' });
  for (let qi = 0; qi < q.length; qi++) {
    const cur = q[qi];
    const cx = cur % w;
    const cy = (cur / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d];
      const ny = cy + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (!floor[ni] || blocked.has(ni) || prev.has(ni)) continue;
      prev.set(ni, { p: cur, ch: CH[d] });
      if (ni === to) {
        let s = '';
        let c = ni;
        while (c !== from) {
          const e = prev.get(c)!;
          s = e.ch + s;
          c = e.p;
        }
        return s;
      }
      q.push(ni);
    }
  }
  return null;
}

interface Room {
  walk: boolean[]; // cells the player may stand on (room cells + entry cells)
  boxOk: boolean[]; // cells a box may be pushed onto (room cells only)
  goals: number[];
  boxes: number[];
  startPlayer: number; // door cell when free, else the entry hallway cell
  entries: number[]; // hallway cells the player exits through
}

// Split a level into its rooms. The hallway is the row the player starts
// in; removing it leaves one connected component per room. A room's door
// is the component cell touching a hallway floor cell. Returns null when
// a box or goal sits outside every room (not a generator level), in which
// case the caller falls back to solving the whole level as one room.
function decompose(level: Level): Room[] | null {
  const { w, h, floor, goals, boxes, player } = level;
  const hallRow = (player / w) | 0;
  const comp = new Int32Array(w * h).fill(-1);
  const goalSet = new Set(goals);
  const boxSet = new Set(boxes);
  const found: { cells: number[] }[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!floor[i] || ((i / w) | 0) === hallRow || comp[i] !== -1) continue;
    const cells: number[] = [];
    const q = [i];
    comp[i] = found.length;
    for (let qi = 0; qi < q.length; qi++) {
      const cur = q[qi];
      cells.push(cur);
      const cx = cur % w;
      const cy = (cur / w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = cx + DX[d];
        const ny = cy + DY[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (!floor[ni] || ((ni / w) | 0) === hallRow || comp[ni] !== -1) continue;
        comp[ni] = found.length;
        q.push(ni);
      }
    }
    found.push({ cells });
  }
  const covered = new Set<number>();
  for (const f of found) for (const c of f.cells) covered.add(c);
  for (const b of boxes) if (!covered.has(b)) return null;
  for (const g of goals) if (!covered.has(g)) return null;

  const rooms: Room[] = [];
  for (const f of found) {
    const rGoals = f.cells.filter((c) => goalSet.has(c));
    const rBoxes = f.cells.filter((c) => boxSet.has(c));
    if (rBoxes.length === 0) continue;
    const walk: boolean[] = new Array(w * h).fill(false);
    const boxOk: boolean[] = new Array(w * h).fill(false);
    for (const c of f.cells) {
      walk[c] = true;
      boxOk[c] = true;
    }
    const doors: number[] = [];
    const entries: number[] = [];
    for (const c of f.cells) {
      const cx = c % w;
      const cy = (c / w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = cx + DX[d];
        const ny = cy + DY[d];
        if (ny !== hallRow || nx < 0 || nx >= w) continue;
        const ni = ny * w + nx;
        if (!floor[ni]) continue;
        if (!doors.includes(c)) doors.push(c);
        if (!entries.includes(ni)) entries.push(ni);
        walk[ni] = true;
      }
    }
    if (doors.length === 0) return null;
    doors.sort((a, b) => a - b);
    entries.sort((a, b) => a - b);
    const startPlayer = boxSet.has(doors[0]) ? entries[0] : doors[0];
    rooms.push({ walk, boxOk, goals: rGoals, boxes: rBoxes, startPlayer, entries });
  }
  rooms.sort((a, b) => a.startPlayer - b.startPlayer);
  return rooms;
}

// Fallback room: the whole level at once (used only when decomposition
// does not apply). The player may walk and boxes may go anywhere on floor.
function wholeLevelRoom(level: Level): Room {
  const walk: boolean[] = [...level.floor];
  const boxOk: boolean[] = [...level.floor];
  return {
    walk,
    boxOk,
    goals: level.goals,
    boxes: level.boxes,
    startPlayer: level.player,
    entries: [],
  };
}

interface PushStep {
  box: number; // cell the box is pushed from
  dir: number; // direction index
}

interface RoomSolution {
  moves: string;
  endPlayer: number;
  endBoxes: number[];
  pushes: number;
}

// Solve one room with a push-optimal A* over box configurations.
// The player position rides along; transitions are pushes, and the cost
// is the push count. A greedy best-first retry runs when A* hits its cap.
function solveRoom(level: Level, room: Room, needExit: boolean): RoomSolution | null {
  const { w, h } = level;
  const n = w * h;
  const goals = [...room.goals].sort((a, b) => a - b);
  const startBoxes = [...room.boxes].sort((a, b) => a - b);
  if (startBoxes.length > goals.length) return null;
  const goalSet = new Set(goals);

  // Reverse push distances from each goal: dist[g][cell] is the fewest
  // pushes for a box to reach goal g from cell, other boxes ignored.
  // A box at p could have come from q = p - d when q takes a box and
  // p - 2d takes the player standing behind it.
  const dist: Int32Array[] = [];
  for (const g of goals) {
    const d = new Int32Array(n).fill(-1);
    d[g] = 0;
    const q: number[] = [g];
    for (let qi = 0; qi < q.length; qi++) {
      const p = q[qi];
      const px = p % w;
      const py = (p / w) | 0;
      for (let dir = 0; dir < 4; dir++) {
        const qx = px - DX[dir];
        const qy = py - DY[dir];
        const bx = px - 2 * DX[dir];
        const by = py - 2 * DY[dir];
        if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
        if (bx < 0 || by < 0 || bx >= w || by >= h) continue;
        const qi2 = qy * w + qx;
        const bi = by * w + bx;
        if (!room.boxOk[qi2] || !room.walk[bi] || d[qi2] !== -1) continue;
        d[qi2] = d[p] + 1;
        q.push(qi2);
      }
    }
    dist.push(d);
  }

  // Dead squares: a box cell no goal is reachable from can never be fixed.
  const dead = new Uint8Array(n);
  for (let c = 0; c < n; c++) {
    if (!room.boxOk[c]) continue;
    let ok = false;
    for (const d of dist) if (d[c] !== -1) { ok = true; break; }
    if (!ok) dead[c] = 1;
  }
  for (const b of startBoxes) if (dead[b]) return null;

  // All orderings of the goals, for the minimum-matching heuristic.
  const goalPerms: number[][] = [];
  const permRec = (used: boolean[], cur: number[]): void => {
    if (cur.length === goals.length) {
      goalPerms.push([...cur]);
      return;
    }
    for (let i = 0; i < goals.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      permRec(used, cur);
      cur.pop();
      used[i] = false;
    }
  };
  permRec(new Array(goals.length).fill(false), []);

  // Minimum over injective box->goal assignments of summed push distances.
  // Depends on the box configuration only, so it is cached by box key.
  const hCache = new Map<string, number>();
  const heuristic = (boxes: number[]): number => {
    const key = boxes.join(',');
    const hit = hCache.get(key);
    if (hit !== undefined) return hit;
    let best = Infinity;
    for (const perm of goalPerms) {
      let s = 0;
      let bad = false;
      for (let i = 0; i < boxes.length; i++) {
        const dd = dist[perm[i]][boxes[i]];
        if (dd === -1) {
          bad = true;
          break;
        }
        s += dd;
      }
      if (!bad && s < best) best = s;
    }
    hCache.set(key, best);
    return best;
  };

  // Can the player walk from `player` to an exit cell with `boxes` fixed?
  const canExit = (player: number, boxes: number[]): boolean => {
    if (room.entries.length === 0) return true;
    const occ = new Set(boxes);
    const seen = new Set<number>([player]);
    const q = [player];
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi];
      if (room.entries.includes(c)) return true;
      const cx = c % w;
      const cy = (c / w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = cx + DX[d];
        const ny = cy + DY[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (!room.walk[ni] || occ.has(ni) || seen.has(ni)) continue;
        seen.add(ni);
        q.push(ni);
      }
    }
    return false;
  };

  const startKey = room.startPlayer + '|' + startBoxes.join(',');

  const search = (
    greedy: boolean,
    cap: number,
  ): { steps: PushStep[]; endPlayer: number; endBoxes: number[] } | null => {
    const open = new Heap<{ player: number; boxes: number[]; g: number }>();
    const closed = new Map<string, number>();
    const parent = new Map<string, { pk: string; box: number; dir: number }>();
    const h0 = heuristic(startBoxes);
    if (!Number.isFinite(h0)) return null;
    open.push(h0, h0, { player: room.startPlayer, boxes: startBoxes, g: 0 });
    closed.set(startKey, 0);
    let used = 0;
    const seenMark = new Uint8Array(n);
    const occMark = new Uint8Array(n);
    let seenToken = 0;
    let occToken = 0;
    const queue: number[] = [];

    const reconstruct = (goalKey: string): PushStep[] => {
      const steps: PushStep[] = [];
      let k = goalKey;
      while (k !== startKey) {
        const e = parent.get(k);
        if (!e) break;
        steps.push({ box: e.box, dir: e.dir });
        k = e.pk;
      }
      steps.reverse();
      return steps;
    };

    while (open.size > 0) {
      const cur = open.pop()!;
      const key = cur.player + '|' + cur.boxes.join(',');
      const bestG = closed.get(key);
      if (bestG !== undefined && cur.g > bestG) continue;
      let solved = true;
      for (const b of cur.boxes) {
        if (!goalSet.has(b)) {
          solved = false;
          break;
        }
      }
      if (solved) {
        if (!needExit || canExit(cur.player, cur.boxes)) {
          return { steps: reconstruct(key), endPlayer: cur.player, endBoxes: cur.boxes };
        }
        continue;
      }
      if (used >= cap || expansionsUsed >= RUN_EXPANSION_BUDGET) return null;
      used++;
      expansionsUsed++;
      occToken++;
      for (const b of cur.boxes) occMark[b] = occToken;
      seenToken++;
      queue.length = 0;
      queue.push(cur.player);
      seenMark[cur.player] = seenToken;
      for (let qi = 0; qi < queue.length; qi++) {
        const c = queue[qi];
        const cx = c % w;
        const cy = (c / w) | 0;
        for (let d = 0; d < 4; d++) {
          const nx = cx + DX[d];
          const ny = cy + DY[d];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (!room.walk[ni] || occMark[ni] === occToken || seenMark[ni] === seenToken) continue;
          seenMark[ni] = seenToken;
          queue.push(ni);
        }
      }
      for (let bi = 0; bi < cur.boxes.length; bi++) {
        const b = cur.boxes[bi];
        const bx = b % w;
        const by = (b / w) | 0;
        for (let d = 0; d < 4; d++) {
          const dx = bx + DX[d];
          const dy = by + DY[d];
          const px = bx - DX[d];
          const py = by - DY[d];
          if (dx < 0 || dy < 0 || dx >= w || dy >= h) continue;
          if (px < 0 || py < 0 || px >= w || py >= h) continue;
          const dest = dy * w + dx;
          const behind = py * w + px;
          if (!room.boxOk[dest] || occMark[dest] === occToken) continue;
          if (seenMark[behind] !== seenToken) continue;
          const nb = [...cur.boxes];
          nb[bi] = dest;
          nb.sort((x, y) => x - y);
          if (dead[dest]) continue;
          const hh = heuristic(nb);
          if (!Number.isFinite(hh)) continue;
          const g2 = cur.g + 1;
          const key2 = b + '|' + nb.join(',');
          const prevG = closed.get(key2);
          if (greedy) {
            if (prevG !== undefined) continue;
          } else if (prevG !== undefined && prevG <= g2) {
            continue;
          }
          closed.set(key2, g2);
          parent.set(key2, { pk: key, box: b, dir: d });
          open.push(greedy ? hh : g2 + hh, hh, { player: b, boxes: nb, g: g2 });
        }
      }
    }
    return null;
  };

  // Turn a push list into walk+push moves, replaying from the room entry.
  const replay = (steps: PushStep[]): { moves: string; endPlayer: number } | null => {
    let moves = '';
    let player = room.startPlayer;
    let boxes = [...startBoxes];
    for (const s of steps) {
      const behind = s.box - (DY[s.dir] * w + DX[s.dir]);
      const walk = walkPath(w, h, room.walk, new Set(boxes), player, behind);
      if (walk === null) return null;
      moves += walk + CH[s.dir];
      const dest = s.box + DY[s.dir] * w + DX[s.dir];
      boxes = boxes.map((b) => (b === s.box ? dest : b));
      boxes.sort((a, b) => a - b);
      player = s.box;
    }
    return { moves, endPlayer: player };
  };

  let allOnGoals = true;
  for (const b of startBoxes) {
    if (!goalSet.has(b)) {
      allOnGoals = false;
      break;
    }
  }
  if (allOnGoals) {
    return { moves: '', endPlayer: room.startPlayer, endBoxes: startBoxes, pushes: 0 };
  }
  const found = search(false, ROOM_ASTAR_CAP) ?? search(true, ROOM_GREEDY_CAP);
  if (!found) return null;
  const rep = replay(found.steps);
  if (!rep) return null;
  return { moves: rep.moves, endPlayer: rep.endPlayer, endBoxes: found.endBoxes, pushes: found.steps.length };
}

// Solve one level: decompose into rooms, solve each in turn, and stitch
// the room solutions together with hallway walks. A room that cannot be
// solved is skipped, leaving a legal but partial answer for the level.
function solveLevel(level: Level): string {
  const rooms = decompose(level) ?? [wholeLevelRoom(level)];
  let moves = '';
  let player = level.player;
  const boxSet = new Set(level.boxes);
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri];
    const needExit = ri < rooms.length - 1;
    const sol = solveRoom(level, room, needExit);
    if (!sol) continue;
    const walk = walkPath(level.w, level.h, level.floor, boxSet, player, room.startPlayer);
    if (walk === null) continue;
    moves += walk + sol.moves;
    player = sol.endPlayer;
    for (const b of room.boxes) boxSet.delete(b);
    for (const b of sol.endBoxes) boxSet.add(b);
  }
  return moves;
}

// Replay a move string on a level and report whether every step is
// legal: no step into a wall, no push into a wall or another box.
// Used as a last self-check before an answer is written out.
function verifyMoves(level: Level, moves: string): boolean {
  const { w, h, floor } = level;
  const boxes = new Set(level.boxes);
  let px = level.player;
  for (const m of moves) {
    const d = CH.indexOf(m);
    if (d === -1) return false;
    const cx = px % w;
    const cy = (px / w) | 0;
    const nx = cx + DX[d];
    const ny = cy + DY[d];
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) return false;
    const ni = ny * w + nx;
    if (!floor[ni]) return false;
    if (boxes.has(ni)) {
      const bx = nx + DX[d];
      const by = ny + DY[d];
      if (bx < 0 || by < 0 || bx >= w || by >= h) return false;
      const bi = by * w + bx;
      if (!floor[bi] || boxes.has(bi)) return false;
      boxes.delete(ni);
      boxes.add(bi);
    }
    px = ni;
  }
  return true;
}

function main(): void {
  for (const id of readdirSync(INPUT_DIR).sort()) {
    const level = parseLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
    let moves = solveLevel(level);
    // Never ship an illegal answer: fall back to an empty (valid) one.
    if (moves.length > 65536 || !verifyMoves(level, moves)) moves = '';
    mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
    writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), moves + '\n');
  }
}

main();
