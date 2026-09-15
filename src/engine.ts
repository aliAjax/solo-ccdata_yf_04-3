// ============================================================
// 赛事编排与裁定引擎（纯函数，事件溯源）
// 状态 = reduce(events[0..head])，任何改动都从这里重算排名/对手分/配对
// ============================================================

export type ID = string;

/** W1 p1胜 | W2 p2胜 | D 和 | F1 p1弃权负 | F2 p2弃权负 | DF 双负 */
export type ResultCode = 'W1' | 'W2' | 'D' | 'F1' | 'F2' | 'DF';

export interface Config {
  winPts: number;
  drawPts: number;
  lossPts: number;
  byePts: number;
  timeoutMin: number; // 开赛后多少分钟未报分视为超时
}

export interface Player {
  id: ID;
  name: string;
  section: string; // 组别（独立瑞士制赛场）
  withdrawn: boolean; // 临时退赛
}

export interface Submission {
  actor: string;
  result: ResultCode;
  at: number;
}

export interface Adjudication {
  actor: string;
  result: ResultCode | null; // null 表示撤销结果
  note: string;
  at: number;
}

export type MatchStatus = 'pending' | 'reported' | 'confirmed' | 'conflict' | 'bye';

export interface Match {
  id: ID;
  round: number;
  section: string;
  table: number;
  p1: ID;
  p2: ID | null; // null = 轮空
  result: ResultCode | 'BYE' | null; // 官方结果（首报为暂定，裁定后为最终）
  status: MatchStatus;
  submissions: Submission[]; // 裁判报分（可能两份且冲突）
  adjudications: Adjudication[]; // 裁定链
  origin: 'swiss' | 'makeup';
  makeupOf?: ID; // 补赛对应的原始场次
  supersededBy?: ID; // 被哪场补赛替代（原场次保留但不再计分）
}

export interface Round {
  n: number;
  startedAt: number;
  matches: Match[];
}

export interface State {
  name: string;
  status: 'setup' | 'active' | 'finished';
  cfg: Config;
  players: Player[];
  rounds: Round[];
  seq: number; // id 计数器，保证事件重放确定性
}

// ---------------- 事件 ----------------

export type Event =
  | { type: 'CONFIG'; name: string; cfg: Config; at: number }
  | { type: 'ADD_PLAYER'; player: Player; at: number }
  | { type: 'REMOVE_PLAYER'; playerId: ID; at: number }
  | { type: 'WITHDRAW'; playerId: ID; at: number }
  | { type: 'REINSTATE'; playerId: ID; at: number }
  | { type: 'START'; at: number }
  | { type: 'NEW_ROUND'; round: Round; forfeits: { matchId: ID; note: string }[]; at: number }
  | { type: 'REPAIR_ROUND'; round: Round; at: number }
  | { type: 'SWAP'; matchA: ID; slotA: 1 | 2; matchB: ID; slotB: 1 | 2; actor: string; at: number }
  | { type: 'SUBMIT'; matchId: ID; actor: string; result: ResultCode; at: number }
  | { type: 'ADJUDICATE'; matchId: ID; actor: string; result: ResultCode; note: string; at: number }
  | { type: 'VOID'; matchId: ID; actor: string; note: string; at: number }
  | { type: 'MAKEUP'; match: Match; originalId: ID; actor: string; at: number }
  | { type: 'END'; at: number };

export const DEFAULT_CFG: Config = { winPts: 1, drawPts: 0.5, lossPts: 0, byePts: 1, timeoutMin: 45 };

export function initialState(): State {
  return { name: '未命名赛事', status: 'setup', cfg: { ...DEFAULT_CFG }, players: [], rounds: [], seq: 1 };
}

export const uid = (st: State, tag: string): ID => `${tag}${st.seq}`;

// ---------------- 工具 ----------------

export const pairKey = (a: ID, b: ID) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function resultLabel(r: ResultCode | 'BYE' | null, p1name?: string, p2name?: string): string {
  switch (r) {
    case 'W1': return `${p1name ?? '先手'} 胜`;
    case 'W2': return `${p2name ?? '后手'} 胜`;
    case 'D': return '和棋';
    case 'F1': return `${p1name ?? '先手'} 弃权负`;
    case 'F2': return `${p2name ?? '后手'} 弃权负`;
    case 'DF': return '双负';
    case 'BYE': return '轮空';
    default: return '未报分';
  }
}

/** 单场双方得分；null 表示尚无结果 */
export function pointsOf(m: Match, cfg: Config): [number, number] | null {
  switch (m.result) {
    case 'W1': case 'F2': return [cfg.winPts, cfg.lossPts];
    case 'W2': case 'F1': return [cfg.lossPts, cfg.winPts];
    case 'D': return [cfg.drawPts, cfg.drawPts];
    case 'DF': return [cfg.lossPts, cfg.lossPts];
    case 'BYE': return [cfg.byePts, 0];
    default: return null;
  }
}

/** 实际下完的对局（用于"已交手"判断；弃权/双负不算真正交手） */
const isPlayedGame = (m: Match) =>
  !m.supersededBy && (m.result === 'W1' || m.result === 'W2' || m.result === 'D');

/** 计入排名的对局（有官方结果且未被补赛替代） */
const isCounted = (m: Match) => !m.supersededBy && m.result != null;

// ---------------- 排名 ----------------

export interface Row {
  player: Player;
  score: number;
  buch: number; // 对手分（Buchholz）
  prog: number; // 累进分
  w: number; d: number; l: number;
  opponents: { id: ID; round: number }[];
}

export function standings(st: State, section: string): Row[] {
  const rows = new Map<ID, Row>();
  for (const p of st.players) {
    if (p.section !== section) continue;
    rows.set(p.id, { player: p, score: 0, buch: 0, prog: 0, w: 0, d: 0, l: 0, opponents: [] });
  }
  const all = st.rounds.flatMap(r => r.matches);
  // 第一遍：积分与战绩
  for (const m of all) {
    if (m.section !== section || !isCounted(m)) continue;
    const pts = pointsOf(m, st.cfg);
    if (!pts) continue;
    const r1 = rows.get(m.p1);
    if (r1) {
      r1.score += pts[0];
      if (m.result === 'W1' || m.result === 'F2') r1.w++;
      else if (m.result === 'D') r1.d++;
      else if (m.result !== 'BYE') r1.l++;
      if (m.p2) r1.opponents.push({ id: m.p2, round: m.round });
    }
    if (m.p2) {
      const r2 = rows.get(m.p2);
      if (r2) {
        r2.score += pts[1];
        if (m.result === 'W2' || m.result === 'F1') r2.w++;
        else if (m.result === 'D') r2.d++;
        else r2.l++;
        r2.opponents.push({ id: m.p1, round: m.round });
      }
    }
  }
  // 第二遍：对手分 = 所有已交手对手（含弃权局对手）的积分之和
  for (const m of all) {
    if (m.section !== section || !isCounted(m) || !m.p2) continue;
    const r1 = rows.get(m.p1), r2 = rows.get(m.p2);
    if (r1) r1.buch += rows.get(m.p2)?.score ?? 0;
    if (r2) r2.buch += rows.get(m.p1)?.score ?? 0;
  }
  // 累进分：每轮结束时的累计积分求和
  for (const row of rows.values()) {
    let cum = 0;
    for (const round of st.rounds) {
      for (const m of round.matches) {
        if (m.section !== section || !isCounted(m)) continue;
        if (m.p1 !== row.player.id && m.p2 !== row.player.id) continue;
        const pts = pointsOf(m, st.cfg);
        if (!pts) continue;
        cum += m.p1 === row.player.id ? pts[0] : pts[1];
      }
      row.prog += cum;
    }
  }
  return [...rows.values()].sort(
    (a, b) => b.score - a.score || b.buch - a.buch || b.prog - a.prog || a.player.name.localeCompare(b.player.name, 'zh'),
  );
}

// ---------------- 瑞士制配对 ----------------

function hashJitter(id: string, salt: number): number {
  let h = salt >>> 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

/** 在已排序名单上求"重赛数最少"的完美匹配；节点超限退化为贪心，保证不卡死 */
function bestMatching(order: Player[], played: Set<string>): [Player, Player][] {
  const rematch = (a: Player, b: Player) => (played.has(pairKey(a.id, b.id)) ? 1 : 0);
  let best: [Player, Player][] | null = null;
  let bestCost = Infinity;
  let nodes = 0;
  const CAP = 60000;
  const rec = (rest: Player[], acc: [Player, Player][], cost: number) => {
    if (cost >= bestCost || nodes > CAP) return;
    if (rest.length === 0) { best = acc; bestCost = cost; return; }
    const a = rest[0];
    const limit = Math.min(rest.length, 9); // 只在前 8 个候选里挑，控制搜索规模
    for (let i = 1; i < limit; i++) {
      const b = rest[i];
      rec(rest.slice(1, i).concat(rest.slice(i + 1)), [...acc, [a, b]], cost + rematch(a, b));
      if (nodes > CAP) return;
    }
    nodes++;
  };
  rec(order, [], 0);
  if (best) return best;
  const rest = [...order];
  const greedy: [Player, Player][] = [];
  while (rest.length >= 2) greedy.push([rest.shift()!, rest.shift()!]);
  return greedy;
}

export interface PairingPlan {
  matches: Omit<Match, 'id'>[]; // id 由调用方按 seq 分配
  warnings: string[];
}

/** 为某一组别生成下一轮配对 */
export function pairSection(st: State, section: string, roundNo: number, tableBase: number, salt: number): PairingPlan {
  const rows = standings(st, section).filter(r => !r.player.withdrawn);
  const all = st.rounds.flatMap(r => r.matches);
  const played = new Set<string>();
  const byeCount = new Map<ID, number>();
  for (const m of all) {
    if (m.section !== section) continue;
    if (isPlayedGame(m) && m.p2) { played.add(pairKey(m.p1, m.p2)); }
    if (m.result === 'BYE') byeCount.set(m.p1, (byeCount.get(m.p1) ?? 0) + 1);
  }
  // 排名排序 + 同分抖动（重排时可产生不同配对）
  const order = rows
    .map(r => r.player)
    .sort((a, b) => {
      const ra = rows.find(r => r.player.id === a.id)!, rb = rows.find(r => r.player.id === b.id)!;
      return rb.score - ra.score || rb.buch - ra.buch || hashJitter(a.id, salt) - hashJitter(b.id, salt);
    });
  const warnings: string[] = [];
  const matches: Omit<Match, 'id'>[] = [];
  let pool = [...order];
  // 奇数人数 → 轮空：优先给排名靠后且没轮空过的
  if (pool.length % 2 === 1) {
    let idx = -1;
    for (let i = pool.length - 1; i >= 0; i--) {
      if ((byeCount.get(pool[i].id) ?? 0) === 0) { idx = i; break; }
    }
    if (idx === -1) idx = pool.length - 1;
    const byePlayer = pool.splice(idx, 1)[0];
    matches.push({
      round: roundNo, section, table: 0, p1: byePlayer.id, p2: null,
      result: 'BYE', status: 'bye', submissions: [], adjudications: [], origin: 'swiss',
    });
    warnings.push(`${byePlayer.name} 轮空（奇数人数）`);
  }
  const pairs = bestMatching(pool, played);
  const rematches = pairs.filter(([a, b]) => played.has(pairKey(a.id, b.id)));
  if (rematches.length > 0) {
    warnings.push(`有 ${rematches.length} 对无法避开重赛（已选重赛最少方案）：${rematches.map(([a, b]) => `${a.name} vs ${b.name}`).join('、')}`);
  }
  let t = tableBase;
  for (const [a, b] of pairs) {
    matches.push({
      round: roundNo, section, table: ++t, p1: a.id, p2: b.id,
      result: null, status: 'pending', submissions: [], adjudications: [], origin: 'swiss',
    });
  }
  // 轮空桌号排在最后
  for (const m of matches) if (m.status === 'bye') m.table = ++t;
  return { matches, warnings };
}

/** 为全部组别生成新一轮（含桌号衔接） */
export function planRound(st: State, salt: number): { round: Round; warnings: string[] } {
  const roundNo = st.rounds.length + 1;
  const sections = [...new Set(st.players.filter(p => !p.withdrawn).map(p => p.section))].sort();
  const warnings: string[] = [];
  const matches: Match[] = [];
  let tableBase = 0;
  let seq = st.seq;
  for (const sec of sections) {
    const plan = pairSection(st, sec, roundNo, tableBase, salt);
    warnings.push(...plan.warnings.map(w => `【${sec}】${w}`));
    for (const m of plan.matches) {
      matches.push({ ...m, id: `m${seq++}` });
      tableBase = Math.max(tableBase, m.table);
    }
  }
  return { round: { n: roundNo, startedAt: 0, matches }, warnings }; // startedAt 由派发方填
}

// ---------------- Reducer ----------------

function findMatch(st: State, id: ID): Match | undefined {
  for (const r of st.rounds) for (const m of r.matches) if (m.id === id) return m;
  return undefined;
}

/** 原地应用事件（调用方负责 structuredClone） */
export function apply(st: State, ev: Event): void {
  switch (ev.type) {
    case 'CONFIG':
      st.name = ev.name;
      st.cfg = { ...ev.cfg };
      break;
    case 'ADD_PLAYER':
      st.players.push({ ...ev.player });
      st.seq = Math.max(st.seq, parseInt(ev.player.id.replace(/\D/g, '') || '0', 10) + 1);
      break;
    case 'REMOVE_PLAYER':
      if (st.status === 'setup') st.players = st.players.filter(p => p.id !== ev.playerId);
      break;
    case 'WITHDRAW': {
      const p = st.players.find(p => p.id === ev.playerId);
      if (p) p.withdrawn = true;
      break;
    }
    case 'REINSTATE': {
      const p = st.players.find(p => p.id === ev.playerId);
      if (p) p.withdrawn = false;
      break;
    }
    case 'START':
      if (st.players.length >= 2) st.status = 'active';
      break;
    case 'NEW_ROUND': {
      // 先把上一轮及更早的未报分场次自动判双负，再落新轮次
      for (const f of ev.forfeits) {
        const m = findMatch(st, f.matchId);
        if (m && m.result == null && m.status !== 'bye') {
          m.result = 'DF';
          m.status = 'confirmed';
          m.adjudications.push({ actor: '系统', result: 'DF', note: f.note, at: ev.at });
        }
      }
      st.rounds.push({ ...ev.round, matches: ev.round.matches.map(m => ({ ...m, submissions: [...m.submissions], adjudications: [...m.adjudications] })) });
      const maxSeq = Math.max(0, ...ev.round.matches.map(m => parseInt(m.id.replace(/\D/g, '') || '0', 10)));
      st.seq = Math.max(st.seq, maxSeq + 1);
      break;
    }
    case 'REPAIR_ROUND': {
      const idx = st.rounds.findIndex(r => r.n === ev.round.n);
      if (idx >= 0) {
        const old = st.rounds[idx];
        const dirty = old.matches.some(m => m.result != null || m.submissions.length > 0);
        if (!dirty) {
          st.rounds[idx] = ev.round;
          const maxSeq = Math.max(0, ...ev.round.matches.map(m => parseInt(m.id.replace(/\D/g, '') || '0', 10)));
          st.seq = Math.max(st.seq, maxSeq + 1);
        }
      }
      break;
    }
    case 'SWAP': {
      const a = findMatch(st, ev.matchA), b = findMatch(st, ev.matchB);
      if (!a || !b || a.status === 'bye' || b.status === 'bye') break;
      if (a.result != null || b.result != null || a.submissions.length || b.submissions.length) break;
      const pa = ev.slotA === 1 ? a.p1 : a.p2;
      const pb = ev.slotB === 1 ? b.p1 : b.p2;
      if (pa == null || pb == null) break;
      if (ev.slotA === 1) a.p1 = pb; else a.p2 = pb;
      if (ev.slotB === 1) b.p1 = pa; else b.p2 = pa;
      break;
    }
    case 'SUBMIT': {
      const m = findMatch(st, ev.matchId);
      if (!m || m.status === 'bye' || m.result === 'BYE') break;
      const mine = m.submissions.find(s => s.actor === ev.actor);
      if (mine) {
        // 同一裁判改自己的报分：更新并留痕，不静默
        m.adjudications.push({ actor: ev.actor, result: ev.result, note: `更正本人此前报分（${resultLabel(mine.result)} → ${resultLabel(ev.result)}）`, at: ev.at });
        mine.result = ev.result;
        mine.at = ev.at;
        if (m.submissions.length === 1) m.result = ev.result;
        break;
      }
      m.submissions.push({ actor: ev.actor, result: ev.result, at: ev.at });
      if (m.submissions.length === 1) {
        m.result = ev.result;
        m.status = 'reported';
      } else {
        const [s1, s2] = m.submissions;
        if (s1.result === s2.result) {
          m.result = ev.result;
          m.status = 'confirmed';
        } else {
          // 两名裁判报分不一致：保留冲突，官方结果维持首报，等待裁定
          m.status = 'conflict';
        }
      }
      break;
    }
    case 'ADJUDICATE': {
      const m = findMatch(st, ev.matchId);
      if (!m || m.status === 'bye') break;
      m.result = ev.result;
      m.status = 'confirmed';
      m.adjudications.push({ actor: ev.actor, result: ev.result, note: ev.note, at: ev.at });
      break;
    }
    case 'VOID': {
      const m = findMatch(st, ev.matchId);
      if (!m || m.status === 'bye') break;
      m.result = null;
      m.status = 'pending';
      m.submissions = [];
      m.adjudications.push({ actor: ev.actor, result: null, note: ev.note || '撤销结果，待重报', at: ev.at });
      break;
    }
    case 'MAKEUP': {
      const orig = findMatch(st, ev.originalId);
      if (!orig) break;
      orig.supersededBy = ev.match.id;
      const round = st.rounds.find(r => r.n === ev.match.round);
      if (round) round.matches.push({ ...ev.match });
      const n = parseInt(ev.match.id.replace(/\D/g, '') || '0', 10);
      st.seq = Math.max(st.seq, n + 1);
      break;
    }
    case 'END':
      st.status = 'finished';
      break;
  }
}

export function reduceEvents(events: Event[]): State {
  const st = initialState();
  for (const ev of events) apply(st, ev);
  return st;
}

// ---------------- 查询辅助 ----------------

export const currentRound = (st: State): Round | undefined => st.rounds[st.rounds.length - 1];

export function unresolvedMatches(st: State): Match[] {
  return st.rounds.flatMap(r => r.matches).filter(m => m.result == null && m.status !== 'bye' && !m.supersededBy);
}

export function conflictMatches(st: State): Match[] {
  return st.rounds.flatMap(r => r.matches).filter(m => m.status === 'conflict');
}

export function sections(st: State): string[] {
  return [...new Set(st.players.map(p => p.section))].sort();
}

export function playerName(st: State, id: ID | null): string {
  if (id == null) return '轮空';
  return st.players.find(p => p.id === id)?.name ?? '?';
}

export function isOverdue(m: Match, round: Round | undefined, cfg: Config, now: number): boolean {
  if (!round || m.result != null || m.status === 'bye' || m.supersededBy) return false;
  return now > round.startedAt + cfg.timeoutMin * 60_000;
}

/** 事件的人话描述（裁定链用） */
export function describeEvent(ev: Event, st: State): string {
  const name = (id: ID | null) => playerName(st, id);
  switch (ev.type) {
    case 'CONFIG': return `设置赛事「${ev.name}」（胜${ev.cfg.winPts}/和${ev.cfg.drawPts}/负${ev.cfg.lossPts}，轮空${ev.cfg.byePts}分，${ev.cfg.timeoutMin}分钟报分时限）`;
    case 'ADD_PLAYER': return `报名：${ev.player.name}（${ev.player.section}）`;
    case 'REMOVE_PLAYER': return `移除选手 ${name(ev.playerId)}`;
    case 'WITHDRAW': return `${name(ev.playerId)} 临时退赛`;
    case 'REINSTATE': return `${name(ev.playerId)} 恢复参赛`;
    case 'START': return '开赛';
    case 'NEW_ROUND': return `生成第 ${ev.round.n} 轮对阵（${ev.round.matches.length} 场）${ev.forfeits.length ? `，${ev.forfeits.length} 场超时未报自动双负` : ''}`;
    case 'REPAIR_ROUND': return `重新编排第 ${ev.round.n} 轮`;
    case 'SWAP': return `${ev.actor} 改配：调整两台对阵`;
    case 'SUBMIT': return `${ev.actor} 报分：${resultLabel(ev.result)}`;
    case 'ADJUDICATE': return `${ev.actor} 裁定：${resultLabel(ev.result)}${ev.note ? `（${ev.note}）` : ''}`;
    case 'VOID': return `${ev.actor} 撤销结果${ev.note ? `（${ev.note}）` : ''}`;
    case 'MAKEUP': return `${ev.actor} 安排补赛（替代原场次）`;
    case 'END': return '赛事结束';
  }
}
