import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, Camera, Clock3, Download, Flag, Gavel, History, Play, Plus,
  Redo2, RotateCcw, Shuffle, Trash2, Trophy, Undo2, UserMinus, UserPlus, Users, X,
} from 'lucide-react';
import {
  conflictMatches, currentRound, describeEvent, planRound, playerName, reduceEvents,
  resultLabel, standings, unresolvedMatches,
} from './engine';
import type { Event, Match, ResultCode, Round, State } from './engine';

// ---------------- 持久化文档：事件只增不删，head 指针移动实现撤销/恢复 ----------------

interface Snap { id: string; label: string; head: number; at: number; auto?: boolean }
interface MetaEntry { at: number; text: string }
interface Doc { events: Event[]; head: number; snaps: Snap[]; meta: MetaEntry[] }

const KEY = 'swiss-desk-v1';
const blank: Doc = { events: [], head: 0, snaps: [], meta: [] };

function loadDoc(): Doc {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return blank;
    const d = JSON.parse(raw) as Doc;
    if (!Array.isArray(d.events) || typeof d.head !== 'number') return blank;
    return { events: d.events, head: Math.min(Math.max(d.head, 0), d.events.length), snaps: d.snaps ?? [], meta: d.meta ?? [] };
  } catch { return blank; }
}

const ACTORS = ['裁判甲', '裁判乙', '裁判长'] as const;
type Actor = (typeof ACTORS)[number];

const fmtTime = (at: number) => new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtCountdown = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export default function App() {
  const [doc, setDoc] = useState<Doc>(loadDoc);
  const [actor, setActor] = useState<Actor>('裁判甲');
  const [tab, setTab] = useState<'pair' | 'rank' | 'log' | 'snap'>('pair');
  const [viewRound, setViewRound] = useState<number | null>(null);
  const [viewSection, setViewSection] = useState<string>('全部');
  const [now, setNow] = useState(Date.now());
  const [warnings, setWarnings] = useState<string[]>([]);
  const [swapMode, setSwapMode] = useState(false);
  const [swapSel, setSwapSel] = useState<{ matchId: string; slot: 1 | 2 } | null>(null);

  // 任何改动 → 由事件流整体重算：排名、对手分、后续配对全部自动刷新
  const st: State = useMemo(() => reduceEvents(doc.events.slice(0, doc.head)), [doc.events, doc.head]);
  useEffect(() => { localStorage.setItem(KEY, JSON.stringify(doc)); }, [doc]);
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, []);

  const cur = currentRound(st);
  const conflicts = conflictMatches(st);
  const unresolved = unresolvedMatches(st);
  const shownRound = viewRound ?? cur?.n ?? null;

  // ---------------- 基础动作 ----------------

  const push = (ev: Event) =>
    setDoc(d => ({ ...d, events: [...d.events, ev], head: d.events.length + 1 }));

  const logMeta = (text: string) =>
    setDoc(d => ({ ...d, meta: [...d.meta, { at: Date.now(), text }] }));

  const undo = () => setDoc(d => d.head > 0
    ? { ...d, head: d.head - 1, meta: [...d.meta, { at: Date.now(), text: `撤销一步（回到第 ${d.head - 1} 步）` }] }
    : d);

  const redo = () => setDoc(d => d.head < d.events.length
    ? { ...d, head: d.head + 1, meta: [...d.meta, { at: Date.now(), text: `重做一步（前进到第 ${d.head + 1} 步）` }] }
    : d);

  const restoreTo = (head: number, label: string) => {
    if (!window.confirm(`确定恢复到「${label}」？\n当前进度不会被删除，随时可以再恢复回来。`)) return;
    setDoc(d => ({ ...d, head, meta: [...d.meta, { at: Date.now(), text: `恢复到「${label}」（第 ${head} 步）` }] }));
    setViewRound(null);
  };

  const takeSnapshot = (label: string, auto = false, head?: number) =>
    setDoc(d => ({ ...d, snaps: [...d.snaps, { id: `s${Date.now()}${Math.floor(Math.random() * 1e4)}`, label, head: head ?? d.head, at: Date.now(), auto }] }));

  const manualSnapshot = () => {
    const label = window.prompt('快照名称', `第 ${cur?.n ?? 0} 轮进行中`);
    if (label) { takeSnapshot(label); logMeta(`创建快照「${label}」`); }
  };

  // ---------------- 赛事流程 ----------------

  const genRound = () => {
    if (st.status !== 'active') return;
    const un = unresolvedMatches(st);
    if (un.length > 0) {
      const list = un.map(m => `${playerName(st, m.p1)} vs ${playerName(st, m.p2)}`).join('；');
      if (!window.confirm(`还有 ${un.length} 场未报分：\n${list}\n\n这些场次将自动判双负，然后生成下一轮。继续？`)) return;
    }
    const plan = planRound(st, Date.now());
    if (plan.round.matches.length === 0) { window.alert('没有可配对的在赛选手'); return; }
    takeSnapshot(`第 ${plan.round.n} 轮开赛前`, true);
    push({
      type: 'NEW_ROUND',
      round: { ...plan.round, startedAt: Date.now() },
      forfeits: un.map(m => ({ matchId: m.id, note: '超时未报/未决，生成下一轮时自动判双负' })),
      at: Date.now(),
    });
    setWarnings(plan.warnings);
    setViewRound(plan.round.n);
    setSwapMode(false); setSwapSel(null);
  };

  const repairRound = () => {
    if (!cur) return;
    if (cur.matches.some(m => m.result != null || m.submissions.length > 0)) {
      window.alert('本轮已有报分记录，不能整体重排（可用改配或撤销单场的重报）');
      return;
    }
    if (!window.confirm(`重新编排第 ${cur.n} 轮？现有对阵将被替换（历史记录仍保留）。`)) return;
    const plan = planRound(st, Date.now());
    push({
      type: 'REPAIR_ROUND',
      round: { ...plan.round, n: cur.n, startedAt: Date.now(), matches: plan.round.matches.map(m => ({ ...m, round: cur.n })) },
      at: Date.now(),
    });
    setWarnings(plan.warnings);
  };

  const report = (m: Match, result: ResultCode) => {
    if (actor === '裁判长') {
      const note = m.status === 'conflict'
        ? window.prompt('裁定理由（会记入裁定链）', '核实双方记录后裁定') ?? ''
        : '裁判长直裁';
      push({ type: 'ADJUDICATE', matchId: m.id, actor, result, note, at: Date.now() });
    } else {
      push({ type: 'SUBMIT', matchId: m.id, actor, result, at: Date.now() });
    }
  };

  const voidResult = (m: Match) => {
    const note = window.prompt('撤销原因（会记入裁定链）', '报分有误，重新录入');
    if (note === null) return;
    push({ type: 'VOID', matchId: m.id, actor, note, at: Date.now() });
  };

  const makeup = (m: Match) => {
    if (!cur) return;
    if (!window.confirm(`为「${playerName(st, m.p1)} vs ${playerName(st, m.p2)}」安排补赛？\n补赛将加入第 ${cur.n} 轮，原场次保留记录但不再计分。`)) return;
    const table = Math.max(0, ...cur.matches.map(x => x.table)) + 1;
    push({
      type: 'MAKEUP',
      match: {
        id: `m${st.seq}`, round: cur.n, section: m.section, table,
        p1: m.p1, p2: m.p2, result: null, status: 'pending',
        submissions: [], adjudications: [], origin: 'makeup', makeupOf: m.id,
      },
      originalId: m.id, actor, at: Date.now(),
    });
    setViewRound(cur.n);
  };

  const clickSlot = (matchId: string, slot: 1 | 2) => {
    if (!swapMode) return;
    if (!swapSel) { setSwapSel({ matchId, slot }); return; }
    if (swapSel.matchId === matchId && swapSel.slot === slot) { setSwapSel(null); return; }
    push({ type: 'SWAP', matchA: swapSel.matchId, slotA: swapSel.slot, matchB: matchId, slotB: slot, actor, at: Date.now() });
    setSwapSel(null);
  };

  const endTournament = () => {
    const un = unresolvedMatches(st);
    const msg = un.length ? `还有 ${un.length} 场未报分，结束前请先处理。仍要结束吗？` : '确定结束赛事？结束后仍可查看与恢复历史。';
    if (window.confirm(msg)) push({ type: 'END', at: Date.now() });
  };

  const resetAll = () => {
    if (window.confirm('清空本赛事全部数据？此操作不可恢复。') && window.confirm('再次确认：删除所有选手、赛程、裁定与快照？')) {
      localStorage.removeItem(KEY);
      setDoc(blank); setViewRound(null); setWarnings([]);
    }
  };

  // ---------------- 导出 ----------------

  const exportMd = () => {
    const secs = [...new Set(st.players.map(p => p.section))].sort();
    let md = `# ${st.name}\n\n状态：${st.status === 'setup' ? '报名中' : st.status === 'active' ? `进行中（第 ${cur?.n ?? 0} 轮）` : '已结束'}\n\n`;
    for (const sec of secs) {
      md += `## ${sec} 排名\n\n| 名次 | 选手 | 积分 | 对手分 | 累进分 | 胜 | 和 | 负 |\n|---|---|---|---|---|---|---|---|\n`;
      standings(st, sec).forEach((r, i) => {
        md += `| ${i + 1} | ${r.player.name}${r.player.withdrawn ? '（已退赛）' : ''} | ${r.score} | ${r.buch} | ${r.prog} | ${r.w} | ${r.d} | ${r.l} |\n`;
      });
      md += '\n';
    }
    for (const r of st.rounds) {
      md += `## 第 ${r.n} 轮对阵\n\n| 台 | 组别 | 对阵 | 结果 |\n|---|---|---|---|\n`;
      for (const m of [...r.matches].sort((a, b) => a.table - b.table)) {
        md += `| ${m.table} | ${m.section} | ${playerName(st, m.p1)} vs ${playerName(st, m.p2)} | ${m.supersededBy ? '已由补赛替代' : resultLabel(m.result, playerName(st, m.p1), playerName(st, m.p2))} |\n`;
      }
      md += '\n';
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    a.download = `${st.name}-赛果.md`;
    a.click();
  };

  // ---------------- 渲染 ----------------

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><Trophy size={18} /></div>
          <div>
            <strong>{st.name}</strong>
            <span>
              {st.status === 'setup' ? '报名中' : st.status === 'active' ? `第 ${cur?.n ?? 0} 轮进行中` : '已结束'}
              {st.players.length > 0 && ` · ${st.players.length} 人`}
            </span>
          </div>
        </div>
        <div className="top-actions">
          {conflicts.length > 0 && (
            <button className="btn danger" onClick={() => setTab('pair')}>
              <AlertTriangle size={14} /> {conflicts.length} 场待裁定
            </button>
          )}
          <label className="actor">
            <Gavel size={14} />
            <select value={actor} onChange={e => setActor(e.target.value as Actor)}>
              {ACTORS.map(a => <option key={a}>{a}</option>)}
            </select>
          </label>
          <button className="btn" onClick={undo} disabled={doc.head === 0} title="撤销一步"><Undo2 size={14} /></button>
          <button className="btn" onClick={redo} disabled={doc.head >= doc.events.length} title="重做一步"><Redo2 size={14} /></button>
          <button className="btn" onClick={manualSnapshot} title="保存当前进度为快照"><Camera size={14} /> 快照</button>
          <button className="btn" onClick={exportMd} title="导出排名与赛程"><Download size={14} /></button>
          <button className="btn ghost-danger" onClick={resetAll} title="清空全部数据"><Trash2 size={14} /></button>
        </div>
      </header>

      {warnings.length > 0 && (
        <div className="banner">
          <AlertTriangle size={15} />
          <div>{warnings.map((w, i) => <p key={i}>{w}</p>)}</div>
          <button className="icon-btn" onClick={() => setWarnings([])}><X size={14} /></button>
        </div>
      )}

      <div className="layout">
        <PlayersPanel st={st} actor={actor} push={push} />

        <main className="content">
          {st.status === 'setup' ? (
            <SetupPanel st={st} push={push} />
          ) : (
            <>
              <nav className="tabs">
                <button className={tab === 'pair' ? 'tab active' : 'tab'} onClick={() => setTab('pair')}>
                  对阵表 {unresolved.length > 0 && <em>{unresolved.length} 未决</em>}
                </button>
                <button className={tab === 'rank' ? 'tab active' : 'tab'} onClick={() => setTab('rank')}>排名</button>
                <button className={tab === 'log' ? 'tab active' : 'tab'} onClick={() => setTab('log')}>
                  裁定链 {conflicts.length > 0 && <em className="red">{conflicts.length} 冲突</em>}
                </button>
                <button className={tab === 'snap' ? 'tab active' : 'tab'} onClick={() => setTab('snap')}>快照与恢复</button>
              </nav>
              {tab === 'pair' && (
                <PairingsView
                  st={st} actor={actor} now={now} shownRound={shownRound} setViewRound={setViewRound}
                  viewSection={viewSection} setViewSection={setViewSection}
                  swapMode={swapMode} setSwapMode={m => { setSwapMode(m); setSwapSel(null); }}
                  swapSel={swapSel} clickSlot={clickSlot}
                  genRound={genRound} repairRound={repairRound} report={report}
                  voidResult={voidResult} makeup={makeup} endTournament={endTournament}
                />
              )}
              {tab === 'rank' && <RankView st={st} />}
              {tab === 'log' && <LogView doc={doc} st={st} restoreTo={restoreTo} />}
              {tab === 'snap' && (
                <SnapView
                  doc={doc}
                  restoreTo={restoreTo}
                  delSnap={id => setDoc(d => ({ ...d, snaps: d.snaps.filter(s => s.id !== id) }))}
                />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

// ---------------- 选手面板 ----------------

function PlayersPanel({ st, actor, push }: { st: State; actor: string; push: (e: Event) => void }) {
  const [name, setName] = useState('');
  const [section, setSection] = useState('');
  const [bulk, setBulk] = useState('');
  const [showBulk, setShowBulk] = useState(false);
  const secs = [...new Set(st.players.map(p => p.section))].sort();
  const setup = st.status === 'setup';

  const addOne = () => {
    const n = name.trim();
    if (!n) return;
    push({ type: 'ADD_PLAYER', player: { id: `p${st.seq}`, name: n, section: section.trim() || '默认组', withdrawn: false }, at: Date.now() });
    setName('');
  };

  const addBulk = () => {
    const lines = bulk.split('\n').map(s => s.trim()).filter(Boolean);
    lines.forEach((line, i) => {
      const [n, sec] = line.split(/[,，\t]/).map(s => s.trim());
      if (n) push({ type: 'ADD_PLAYER', player: { id: `p${st.seq + i}`, name: n, section: sec || '默认组', withdrawn: false }, at: Date.now() });
    });
    setBulk(''); setShowBulk(false);
  };

  const seedDemo = () => {
    const demo: [string, string][] = [
      ['王弈秋', '公开组'], ['李忘忧', '公开组'], ['张镇辉', '公开组'], ['陈守拙', '公开组'], ['刘劫争', '公开组'], ['赵收官', '公开组'],
      ['孙小飞', '少年组'], ['周小星', '少年组'], ['吴小目', '少年组'], ['郑小高', '少年组'], ['林小布局', '少年组'],
    ];
    demo.forEach(([n, sec], i) => push({ type: 'ADD_PLAYER', player: { id: `p${st.seq + i}`, name: n, section: sec, withdrawn: false }, at: Date.now() }));
  };

  const scoreOf = (pid: string, sec: string) => standings(st, sec).find(r => r.player.id === pid)?.score ?? 0;

  return (
    <aside className="players">
      <div className="panel-head">
        <h2><Users size={15} /> 选手名录</h2>
        <span className="count">{st.players.length}</span>
      </div>

      {setup && (
        <div className="add-box">
          <div className="add-row">
            <input value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && addOne()} placeholder="选手姓名" />
            <input value={section} onChange={e => setSection(e.target.value)} onKeyDown={e => e.key === 'Enter' && addOne()} placeholder="组别" list="secs" />
            <datalist id="secs">{secs.map(s => <option key={s} value={s} />)}</datalist>
            <button className="btn primary" onClick={addOne} title="添加选手"><Plus size={14} /></button>
          </div>
          <div className="add-row">
            <button className="btn small" onClick={() => setShowBulk(!showBulk)}>批量导入</button>
            {st.players.length === 0 && <button className="btn small" onClick={seedDemo}>载入示例 11 人</button>}
          </div>
          {showBulk && (
            <div className="bulk">
              <textarea value={bulk} onChange={e => setBulk(e.target.value)} placeholder={'每行一位：姓名,组别\n例如：\n王弈秋,公开组\n孙小飞,少年组'} />
              <button className="btn primary small" onClick={addBulk}>导入 {bulk.split('\n').filter(s => s.trim()).length} 人</button>
            </div>
          )}
        </div>
      )}

      <div className="player-list">
        {secs.map(sec => (
          <div key={sec}>
            <div className="sec-label">{sec}（{st.players.filter(p => p.section === sec).length}）</div>
            {st.players.filter(p => p.section === sec).map(p => (
              <div key={p.id} className={p.withdrawn ? 'player withdrawn' : 'player'}>
                <span className="pname">{p.name}</span>
                {!setup && <span className="pscore">{scoreOf(p.id, sec)} 分</span>}
                {setup ? (
                  <button className="icon-btn" title="移除" onClick={() => push({ type: 'REMOVE_PLAYER', playerId: p.id, at: Date.now() })}><Trash2 size={13} /></button>
                ) : p.withdrawn ? (
                  <button className="icon-btn ok" title="恢复参赛" onClick={() => push({ type: 'REINSTATE', playerId: p.id, at: Date.now() })}><UserPlus size={13} /></button>
                ) : (
                  <button
                    className="icon-btn warn" title="临时退赛"
                    onClick={() => { if (window.confirm(`${p.name} 临时退赛？后续轮次不再配对，已赛成绩保留。`)) push({ type: 'WITHDRAW', playerId: p.id, at: Date.now() }); }}
                  ><UserMinus size={13} /></button>
                )}
              </div>
            ))}
          </div>
        ))}
        {st.players.length === 0 && <div className="empty">还没有选手，先报名或载入示例</div>}
      </div>
      {!setup && <p className="hint">当前身份：{actor}。报分、裁定、退赛等操作都会记入裁定链。</p>}
    </aside>
  );
}

// ---------------- 报名/开赛面板 ----------------

function SetupPanel({ st, push }: { st: State; push: (e: Event) => void }) {
  const [name, setName] = useState(st.name === '未命名赛事' ? '' : st.name);
  const [cfg, setCfg] = useState(st.cfg);
  const num = (v: string, fallback: number) => { const n = parseFloat(v); return Number.isFinite(n) ? n : fallback; };

  const start = () => {
    if (st.players.length < 2) { window.alert('至少 2 名选手才能开赛'); return; }
    const finalCfg = { ...cfg };
    push({ type: 'CONFIG', name: name.trim() || '未命名赛事', cfg: finalCfg, at: Date.now() });
    push({ type: 'START', at: Date.now() });
  };

  return (
    <section className="setup">
      <h2>开赛设置</h2>
      <p className="muted">在左侧录入选手与组别，这里设置计分规则。开赛后将按胜场与对手分进行瑞士制配对。</p>
      <div className="form-grid">
        <label>赛事名称<input value={name} onChange={e => setName(e.target.value)} placeholder="例如：社区杯围棋赛" /></label>
        <label>报分时限（分钟）<input type="number" min={1} value={cfg.timeoutMin} onChange={e => setCfg({ ...cfg, timeoutMin: num(e.target.value, 45) })} /></label>
        <label>胜<input type="number" step="0.5" value={cfg.winPts} onChange={e => setCfg({ ...cfg, winPts: num(e.target.value, 1) })} /></label>
        <label>和<input type="number" step="0.5" value={cfg.drawPts} onChange={e => setCfg({ ...cfg, drawPts: num(e.target.value, 0.5) })} /></label>
        <label>负<input type="number" step="0.5" value={cfg.lossPts} onChange={e => setCfg({ ...cfg, lossPts: num(e.target.value, 0) })} /></label>
        <label>轮空得分<input type="number" step="0.5" value={cfg.byePts} onChange={e => setCfg({ ...cfg, byePts: num(e.target.value, 1) })} /></label>
      </div>
      <div className="setup-summary">
        <span><b>{st.players.length}</b> 名选手</span>
        <span><b>{[...new Set(st.players.map(p => p.section))].length}</b> 个组别</span>
        <span>超时未报分将在生成下一轮时自动判双负</span>
      </div>
      <button className="btn primary big" onClick={start} disabled={st.players.length < 2}>
        <Play size={15} /> 开赛（{st.players.length < 2 ? '至少 2 人' : '进入编排'}）
      </button>
    </section>
  );
}

// ---------------- 对阵表 ----------------

function PairingsView(props: {
  st: State; actor: string; now: number;
  shownRound: number | null; setViewRound: (n: number) => void;
  viewSection: string; setViewSection: (s: string) => void;
  swapMode: boolean; setSwapMode: (b: boolean) => void;
  swapSel: { matchId: string; slot: 1 | 2 } | null; clickSlot: (id: string, slot: 1 | 2) => void;
  genRound: () => void; repairRound: () => void;
  report: (m: Match, r: ResultCode) => void; voidResult: (m: Match) => void; makeup: (m: Match) => void;
  endTournament: () => void;
}) {
  const { st, now, shownRound, setViewRound, viewSection, setViewSection, swapMode, setSwapMode, swapSel, clickSlot, genRound, repairRound, endTournament } = props;
  const cur = currentRound(st);
  const round = st.rounds.find(r => r.n === shownRound);
  const secs = ['全部', ...[...new Set(st.players.map(p => p.section))].sort()];
  const matches = (round?.matches ?? [])
    .filter(m => viewSection === '全部' || m.section === viewSection)
    .sort((a, b) => a.table - b.table);
  const isCur = round != null && cur != null && round.n === cur.n;
  const canRepair = isCur && st.status === 'active' && !round!.matches.some(m => m.result != null || m.submissions.length > 0);

  return (
    <section>
      <div className="pair-toolbar">
        <div className="round-chips">
          {st.rounds.map(r => (
            <button key={r.n} className={r.n === shownRound ? 'chip active' : 'chip'} onClick={() => setViewRound(r.n)}>第 {r.n} 轮</button>
          ))}
        </div>
        <div className="sec-chips">
          {secs.map(s => <button key={s} className={s === viewSection ? 'chip active' : 'chip'} onClick={() => setViewSection(s)}>{s}</button>)}
        </div>
        <div className="toolbar-actions">
          {st.status === 'active' && (
            <>
              {isCur && (
                <button className={swapMode ? 'btn warn' : 'btn'} onClick={() => setSwapMode(!swapMode)} disabled={!canRepair} title={canRepair ? '交换两台之间的选手' : '本轮已有报分，不能改配'}>
                  <Shuffle size={14} /> {swapMode ? '退出改配' : '改配'}
                </button>
              )}
              {isCur && <button className="btn" onClick={repairRound} disabled={!canRepair} title="本轮无报分时可整体重排"><RotateCcw size={14} /> 重新编排</button>}
              <button className="btn primary" onClick={genRound}><Play size={14} /> 生成第 {(cur?.n ?? 0) + 1} 轮</button>
              <button className="btn" onClick={endTournament}><Flag size={14} /> 结束赛事</button>
            </>
          )}
        </div>
      </div>
      {swapMode && <div className="banner info"><Shuffle size={14} /><p>改配模式：依次点击两台中的选手，交换他们的位置（仅限未报分的场次）。</p></div>}
      {st.status === 'finished' && <div className="banner gold"><Trophy size={14} /><p>赛事已结束。排名页为最终成绩；历史与快照仍可恢复。</p></div>}

      <div className="match-list">
        {matches.map(m => (
          <MatchRow
            key={m.id} m={m} st={st} now={now} round={round!} isCur={isCur}
            swapMode={swapMode && canRepair} swapSel={swapSel} clickSlot={clickSlot}
            report={props.report} voidResult={props.voidResult} makeup={props.makeup}
            active={st.status === 'active'}
          />
        ))}
        {matches.length === 0 && (
          <div className="empty">
            {st.rounds.length === 0
              ? '还没有对阵。点击右上角「生成第 1 轮」开始编排。'
              : '该轮该组别没有场次。'}
          </div>
        )}
        {st.rounds.length === 0 && st.status === 'active' && (
          <button className="btn primary big" onClick={genRound}><Play size={15} /> 生成第 1 轮对阵</button>
        )}
      </div>
    </section>
  );
}

function MatchRow({ m, st, now, round, isCur, swapMode, swapSel, clickSlot, report, voidResult, makeup, active }: {
  m: Match; st: State; now: number; round: Round; isCur: boolean;
  swapMode: boolean; swapSel: { matchId: string; slot: 1 | 2 } | null;
  clickSlot: (id: string, slot: 1 | 2) => void;
  report: (m: Match, r: ResultCode) => void; voidResult: (m: Match) => void; makeup: (m: Match) => void;
  active: boolean;
}) {
  const p1 = playerName(st, m.p1), p2 = playerName(st, m.p2);
  const deadline = round.startedAt + st.cfg.timeoutMin * 60_000;
  const overdue = active && isCur && m.result == null && m.status !== 'bye' && now > deadline;
  const canReport = active && m.status !== 'bye' && !m.supersededBy;
  const swappable = swapMode && m.result == null && m.submissions.length === 0 && m.status !== 'bye';

  const slot = (pid: string | null, s: 1 | 2) => {
    const selected = swapSel?.matchId === m.id && swapSel.slot === s;
    return (
      <button
        className={`slot${selected ? ' selected' : ''}${swappable && pid ? ' clickable' : ''}`}
        onClick={() => pid && swappable && clickSlot(m.id, s)}
        disabled={!swappable || !pid}
      >{pid ? playerName(st, pid) : '—'}</button>
    );
  };

  const resultBtns = (
    <div className="result-btns">
      <button className="btn small" onClick={() => report(m, 'W1')}>{p1} 胜</button>
      <button className="btn small" onClick={() => report(m, 'D')}>和</button>
      <button className="btn small" onClick={() => report(m, 'W2')}>{p2} 胜</button>
      <select
        value=""
        onChange={e => { if (e.target.value) report(m, e.target.value as ResultCode); e.target.value = ''; }}
        title="弃权 / 双负"
      >
        <option value="" disabled>弃权…</option>
        <option value="F1">{p1} 弃权负</option>
        <option value="F2">{p2} 弃权负</option>
        <option value="DF">双负</option>
      </select>
    </div>
  );

  return (
    <div className={`match ${m.status}${m.supersededBy ? ' superseded' : ''}${overdue ? ' overdue' : ''}`}>
      <div className="table-no"><span>台</span><b>{m.table}</b></div>
      <div className="match-main">
        <div className="vs">
          {slot(m.p1, 1)}
          <span className="vs-mark">vs</span>
          {m.status === 'bye' ? <span className="slot bye-tag">轮空</span> : slot(m.p2, 2)}
          <span className="sec-tag">{m.section}</span>
          {m.origin === 'makeup' && <span className="tag makeup">补赛</span>}
        </div>

        <div className="match-meta">
          {m.status === 'bye' && <span className="tag bye">轮空 +{st.cfg.byePts} 分</span>}
          {m.supersededBy && <span className="tag muted">已由补赛替代，不计分</span>}
          {m.result != null && m.status !== 'bye' && (
            <span className="tag result">{resultLabel(m.result, p1, p2)}</span>
          )}
          {m.status === 'reported' && <span className="tag pending">待第二人确认</span>}
          {m.status === 'confirmed' && m.result != null && <span className="tag ok">已确认</span>}
          {m.status === 'pending' && !m.supersededBy && (
            overdue
              ? <span className="tag danger"><Clock3 size={11} /> 超时未报 {fmtCountdown(now - deadline)}</span>
              : isCur && active
                ? <span className="tag muted"><Clock3 size={11} /> 剩余 {fmtCountdown(deadline - now)}</span>
                : <span className="tag muted">未报分，可补录</span>
          )}
          {m.submissions.length > 0 && (
            <span className="subs">
              {m.submissions.map((s, i) => <em key={i}>{s.actor}：{resultLabel(s.result, p1, p2)}</em>)}
            </span>
          )}
        </div>

        {m.status === 'conflict' && (
          <div className="conflict-box">
            <AlertTriangle size={13} />
            <span>报分冲突，等待裁判长裁定（当前暂按首报计）：</span>
            {m.submissions.map((s, i) => <b key={i}>{s.actor} → {resultLabel(s.result, p1, p2)}</b>)}
          </div>
        )}

        {m.adjudications.length > 0 && (
          <details className="adj-chain">
            <summary>裁定链（{m.adjudications.length}）</summary>
            {m.adjudications.map((a, i) => (
              <p key={i}>{fmtTime(a.at)} · {a.actor}：{a.result ? resultLabel(a.result, p1, p2) : '撤销结果'}{a.note ? ` — ${a.note}` : ''}</p>
            ))}
          </details>
        )}
      </div>

      <div className="match-actions">
        {canReport && resultBtns}
        {canReport && m.result != null && (
          <button className="icon-btn warn" title="撤销结果，重新报分" onClick={() => voidResult(m)}><RotateCcw size={14} /></button>
        )}
        {active && !m.supersededBy && (m.result === 'DF' || m.result === 'F1' || m.result === 'F2') && (
          <button className="btn small" title="安排补赛替代本场" onClick={() => makeup(m)}>补赛</button>
        )}
      </div>
    </div>
  );
}

// ---------------- 排名 ----------------

function RankView({ st }: { st: State }) {
  const secs = [...new Set(st.players.map(p => p.section))].sort();
  const [sec, setSec] = useState(secs[0] ?? '');
  const rows = standings(st, sec);
  return (
    <section>
      <div className="sec-chips">{secs.map(s => <button key={s} className={s === sec ? 'chip active' : 'chip'} onClick={() => setSec(s)}>{s}</button>)}</div>
      <table className="rank-table">
        <thead><tr><th>名次</th><th>选手</th><th>积分</th><th>对手分</th><th>累进分</th><th>胜</th><th>和</th><th>负</th><th>已赛对手</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.player.id} className={r.player.withdrawn ? 'withdrawn' : ''}>
              <td>{i + 1}</td>
              <td>{r.player.name}{r.player.withdrawn && <span className="tag muted"> 已退赛</span>}</td>
              <td><b>{r.score}</b></td>
              <td>{r.buch}</td>
              <td>{r.prog}</td>
              <td>{r.w}</td><td>{r.d}</td><td>{r.l}</td>
              <td className="opps">{r.opponents.map(o => playerName(st, o.id)).join('、') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">排名按 积分 → 对手分（Buchholz）→ 累进分 排序，任何报分/裁定/补赛改动都会即时重算。</p>
    </section>
  );
}

// ---------------- 裁定链（事件流 + 任意步恢复） ----------------

function LogView({ doc, st, restoreTo }: { doc: Doc; st: State; restoreTo: (head: number, label: string) => void }) {
  type Item = { at: number; kind: 'event'; ev: Event; idx: number; active: boolean } | { at: number; kind: 'meta'; text: string };
  const items: Item[] = [
    ...doc.events.map((ev, idx) => ({ at: ev.at, kind: 'event' as const, ev, idx, active: idx < doc.head })),
    ...doc.meta.map(m => ({ at: m.at, kind: 'meta' as const, text: m.text })),
  ].sort((a, b) => a.at - b.at);

  return (
    <section>
      <p className="hint">完整操作链。点击「回到此步」可恢复到任意历史时刻——事件只增不删，恢复不会覆盖原记录。</p>
      <div className="log-list">
        {items.length === 0 && <div className="empty">暂无记录</div>}
        {items.map((it, i) => it.kind === 'meta' ? (
          <div key={i} className="log-row meta"><History size={12} /><span>{fmtTime(it.at)} · {it.text}</span></div>
        ) : (
          <div key={i} className={it.active ? 'log-row' : 'log-row inactive'}>
            <span className="log-idx">{it.idx + 1}</span>
            <span className="log-time">{fmtTime(it.at)}</span>
            <span className="log-text">{describeEvent(it.ev, st)}</span>
            {!it.active && <span className="tag muted">已回退</span>}
            <button className="btn tiny" onClick={() => restoreTo(it.idx + 1, `第 ${it.idx + 1} 步之后`)}>回到此步</button>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------- 快照 ----------------

function SnapView({ doc, restoreTo, delSnap }: { doc: Doc; restoreTo: (h: number, l: string) => void; delSnap: (id: string) => void }) {
  return (
    <section>
      <p className="hint">快照是命名的时间点（生成新一轮时会自动存档）。恢复快照只移动进度指针，原始记录全部保留。</p>
      <div className="snap-list">
        {doc.snaps.length === 0 && <div className="empty">还没有快照。点击顶栏「快照」保存当前进度。</div>}
        {[...doc.snaps].reverse().map(s => (
          <div key={s.id} className={s.head === doc.head ? 'snap-row current' : 'snap-row'}>
            <Camera size={14} />
            <div className="snap-info">
              <b>{s.label}{s.auto && <span className="tag muted"> 自动</span>}</b>
              <span>{new Date(s.at).toLocaleString('zh-CN')} · 第 {s.head} 步{s.head === doc.head ? ' · 当前位置' : ''}</span>
            </div>
            <button className="btn small" onClick={() => restoreTo(s.head, s.label)}>恢复</button>
            <button className="icon-btn" title="删除快照" onClick={() => delSnap(s.id)}><Trash2 size={13} /></button>
          </div>
        ))}
      </div>
    </section>
  );
}
