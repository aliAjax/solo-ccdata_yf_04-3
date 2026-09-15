import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AlertTriangle, Camera, Clock3, Download, Flag, Gavel, History, Play, Plus,
  Redo2, RotateCcw, Shuffle, Trash2, Trophy, Undo2, UserMinus, UserPlus, Users, X,
} from 'lucide-react';
import {
  conflictMatches, currentRound, describeEvent, isRuled, maybeRepair, planRound, playerName,
  reduceEvents, resultLabel, roundDirty, standings, unresolvedMatches,
} from './engine';
import type { Event, Match, ResultCode, Round, State } from './engine';
import {
  blankDoc, migrateDoc, pushEvents, redo, restoreSnap, restoreToStep, takeSnapshot, undo,
} from './doc';
import type { Doc } from './doc';

const KEY = 'swiss-desk-v1';

function loadDoc(): Doc {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return blankDoc();
    return migrateDoc(JSON.parse(raw));
  } catch { return blankDoc(); }
}

const ACTORS = ['裁判甲', '裁判乙', '裁判长'] as const;
type Actor = (typeof ACTORS)[number];

const fmtTime = (at: number) => new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtCountdown = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// ---------------- 页面内确认/输入对话框（不依赖浏览器弹窗） ----------------

interface DialogSpec {
  title: string;
  body?: ReactNode;
  input?: { defaultValue?: string; placeholder?: string };
  okText?: string;
  danger?: boolean;
  onOk: (value: string) => void;
}

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
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const [dialogVal, setDialogVal] = useState('');

  // 任何改动 → 由事件流整体重算：排名、对手分、后续配对全部自动刷新
  const st: State = useMemo(() => reduceEvents(doc.events.slice(0, doc.head)), [doc.events, doc.head]);
  useEffect(() => { localStorage.setItem(KEY, JSON.stringify(doc)); }, [doc]);
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, []);

  const cur = currentRound(st);
  const conflicts = conflictMatches(st);
  const unresolved = unresolvedMatches(st);
  const shownRound = viewRound ?? cur?.n ?? null;

  const openDialog = (spec: DialogSpec) => { setDialogVal(spec.input?.defaultValue ?? ''); setDialog(spec); };
  const closeDialog = () => setDialog(null);

  // ---------------- 基础动作 ----------------

  /** 派发事件：先截断回退分支，再检查是否需要按新排名自动重排最新轮 */
  const dispatch = (ev: Event) => {
    const chain = doc.events.slice(0, doc.head);
    const st2 = reduceEvents([...chain, ev]);
    const repair = maybeRepair(st2, ev, Date.now());
    setDoc(d => pushEvents(d, repair ? [ev, repair] : [ev]));
    if (repair && repair.type === 'REPAIR_ROUND') {
      setWarnings([`较早赛果变更：第 ${repair.round.n} 轮已按最新排名重新配对，原对阵保留在裁定链与快照中。`]);
    }
  };

  const askRestoreStep = (k: number, label: string) =>
    openDialog({
      title: '恢复历史进度',
      body: `确定恢复到「${label}」？当前进度不会被删除，会保留在回退分支与快照中，随时可再恢复。`,
      okText: '恢复',
      onOk: () => { setDoc(d => restoreToStep(d, k)); setViewRound(null); },
    });

  const askRestoreSnap = (snapId: string, label: string) =>
    openDialog({
      title: '恢复快照',
      body: `确定恢复到快照「${label}」？当前进度会存入回退分支，不会被覆盖。`,
      okText: '恢复快照',
      onOk: () => { setDoc(d => restoreSnap(d, snapId)); setViewRound(null); },
    });

  const manualSnapshot = () =>
    openDialog({
      title: '保存快照',
      input: { defaultValue: `第 ${cur?.n ?? 0} 轮进行中`, placeholder: '快照名称' },
      okText: '保存',
      onOk: v => { if (v.trim()) setDoc(d => takeSnapshot(d, v.trim())); },
    });

  // ---------------- 赛事流程 ----------------

  const doGenRound = () => {
    const un = unresolvedMatches(st);
    const plan = planRound(st, Date.now());
    if (plan.round.matches.length === 0) { setWarnings(['没有可配对的在赛选手']); return; }
    const ev: Event = {
      type: 'NEW_ROUND',
      round: { ...plan.round, startedAt: Date.now() },
      forfeits: un.map(m => ({ matchId: m.id, note: '超时未报/未决，生成下一轮时自动判双负' })),
      at: Date.now(),
    };
    setDoc(d => pushEvents(takeSnapshot(d, `第 ${plan.round.n} 轮开赛前`, true), [ev]));
    setWarnings(plan.warnings);
    setViewRound(plan.round.n);
    setSwapMode(false); setSwapSel(null);
  };

  const genRound = () => {
    if (st.status !== 'active') return;
    const un = unresolvedMatches(st);
    if (un.length > 0) {
      openDialog({
        title: '生成下一轮',
        body: (
          <>
            <p>还有 {un.length} 场未报分，将自动判双负：</p>
            <ul>{un.map(m => <li key={m.id}>{playerName(st, m.p1)} vs {playerName(st, m.p2)}</li>)}</ul>
          </>
        ),
        okText: '判双负并生成',
        onOk: doGenRound,
      });
    } else doGenRound();
  };

  const repairRound = () => {
    if (!cur) return;
    if (roundDirty(cur)) { setWarnings(['本轮已有报分记录，不能整体重排（可用改配或撤销单场重报）']); return; }
    openDialog({
      title: `重新编排第 ${cur.n} 轮`,
      body: '现有对阵将被替换（原对阵保留在裁定链中，可恢复）。确定重排？',
      okText: '重新编排',
      onOk: () => {
        const plan = planRound(st, Date.now());
        dispatch({
          type: 'REPAIR_ROUND',
          round: { ...plan.round, n: cur.n, startedAt: Date.now(), matches: plan.round.matches.map(m => ({ ...m, round: cur.n })) },
          reason: '裁判手动重排',
          at: Date.now(),
        });
      },
    });
  };

  const report = (m: Match, result: ResultCode) => {
    const p1 = playerName(st, m.p1), p2 = playerName(st, m.p2);
    if (actor === '裁判长') {
      if (m.status === 'conflict') {
        openDialog({
          title: '裁定冲突报分',
          body: (
            <>
              <p>两台报分不一致，请选择认定结果（当前选择：<b>{resultLabel(result, p1, p2)}</b>）：</p>
              <ul>{m.submissions.map((s, i) => <li key={i}>{s.actor} → {resultLabel(s.result, p1, p2)}</li>)}</ul>
            </>
          ),
          input: { defaultValue: '核实双方记录后裁定', placeholder: '裁定理由（记入裁定链）' },
          okText: '确认裁定',
          onOk: note => dispatch({ type: 'ADJUDICATE', matchId: m.id, actor, result, note, at: Date.now() }),
        });
      } else {
        dispatch({ type: 'ADJUDICATE', matchId: m.id, actor, result, note: '裁判长直裁', at: Date.now() });
      }
    } else {
      dispatch({ type: 'SUBMIT', matchId: m.id, actor, result, at: Date.now() });
    }
  };

  const voidResult = (m: Match) =>
    openDialog({
      title: '撤销本场结果',
      body: `${playerName(st, m.p1)} vs ${playerName(st, m.p2)} 的结果将被清空，重新报分。`,
      input: { defaultValue: '报分有误，重新录入', placeholder: '撤销原因（记入裁定链）' },
      okText: '撤销结果',
      danger: true,
      onOk: note => dispatch({ type: 'VOID', matchId: m.id, actor, note, at: Date.now() }),
    });

  const makeup = (m: Match) => {
    if (!cur) return;
    openDialog({
      title: '安排补赛',
      body: `为「${playerName(st, m.p1)} vs ${playerName(st, m.p2)}」安排补赛？补赛加入第 ${cur.n} 轮，原场次保留记录但不再计分。`,
      okText: '安排补赛',
      onOk: () => {
        const table = Math.max(0, ...cur.matches.map(x => x.table)) + 1;
        dispatch({
          type: 'MAKEUP',
          match: {
            id: `m${st.seq}`, round: cur.n, section: m.section, table,
            p1: m.p1, p2: m.p2, result: null, status: 'pending',
            submissions: [], adjudications: [], origin: 'makeup', makeupOf: m.id,
          },
          originalId: m.id, actor, at: Date.now(),
        });
        setViewRound(cur.n);
      },
    });
  };

  const withdraw = (pid: string) =>
    openDialog({
      title: '临时退赛',
      body: `${playerName(st, pid)} 临时退赛？后续轮次不再配对，已赛成绩保留，可随时恢复参赛。`,
      okText: '确认退赛',
      onOk: () => dispatch({ type: 'WITHDRAW', playerId: pid, at: Date.now() }),
    });

  const endTournament = () =>
    openDialog({
      title: '结束赛事',
      body: unresolved.length ? `还有 ${unresolved.length} 场未报分。结束后仍可查看与恢复历史。` : '结束后仍可查看排名与恢复历史。',
      okText: '结束赛事',
      onOk: () => dispatch({ type: 'END', at: Date.now() }),
    });

  const resetAll = () =>
    openDialog({
      title: '清空全部数据',
      body: '删除所有选手、赛程、裁定与快照，此操作不可恢复。',
      okText: '全部清空',
      danger: true,
      onOk: () => { localStorage.removeItem(KEY); setDoc(blankDoc()); setViewRound(null); setWarnings([]); },
    });

  const clickSlot = (matchId: string, slot: 1 | 2) => {
    if (!swapMode) return;
    if (!swapSel) { setSwapSel({ matchId, slot }); return; }
    if (swapSel.matchId === matchId && swapSel.slot === slot) { setSwapSel(null); return; }
    dispatch({ type: 'SWAP', matchA: swapSel.matchId, slotA: swapSel.slot, matchB: matchId, slotB: slot, actor, at: Date.now() });
    setSwapSel(null);
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
          <button className="btn" onClick={() => setDoc(d => undo(d))} disabled={doc.head === 0} title="撤销一步"><Undo2 size={14} /></button>
          <button className="btn" onClick={() => setDoc(d => redo(d))} disabled={doc.head >= doc.events.length} title="重做一步"><Redo2 size={14} /></button>
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
        <PlayersPanel st={st} actor={actor} dispatch={dispatch} onWithdraw={withdraw} />

        <main className="content">
          {st.status === 'setup' ? (
            <SetupPanel st={st} dispatch={dispatch} />
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
              {tab === 'log' && <LogView doc={doc} st={st} askRestore={askRestoreStep} />}
              {tab === 'snap' && (
                <SnapView
                  doc={doc}
                  askRestoreSnap={askRestoreSnap}
                  delSnap={id => setDoc(d => ({ ...d, snaps: d.snaps.filter(s => s.id !== id) }))}
                />
              )}
            </>
          )}
        </main>
      </div>

      {dialog && (
        <div className="dialog-backdrop" onClick={closeDialog}>
          <div className="dialog" onClick={e => e.stopPropagation()}>
            <h3>{dialog.title}</h3>
            {dialog.body && <div className="dialog-body">{dialog.body}</div>}
            {dialog.input && (
              <input
                autoFocus
                value={dialogVal}
                placeholder={dialog.input.placeholder}
                onChange={e => setDialogVal(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { dialog.onOk(dialogVal); closeDialog(); } }}
              />
            )}
            <div className="dialog-actions">
              <button className="btn" onClick={closeDialog}>取消</button>
              <button
                className={dialog.danger ? 'btn danger' : 'btn primary'}
                onClick={() => { dialog.onOk(dialogVal); closeDialog(); }}
              >{dialog.okText ?? '确定'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- 选手面板 ----------------

function PlayersPanel({ st, actor, dispatch, onWithdraw }: {
  st: State; actor: string; dispatch: (e: Event) => void; onWithdraw: (pid: string) => void;
}) {
  const [name, setName] = useState('');
  const [section, setSection] = useState('');
  const [bulk, setBulk] = useState('');
  const [showBulk, setShowBulk] = useState(false);
  const secs = [...new Set(st.players.map(p => p.section))].sort();
  const setup = st.status === 'setup';

  const addOne = () => {
    const n = name.trim();
    if (!n) return;
    dispatch({ type: 'ADD_PLAYER', player: { id: `p${st.seq}`, name: n, section: section.trim() || '默认组', withdrawn: false }, at: Date.now() });
    setName('');
  };

  const addBulk = () => {
    const lines = bulk.split('\n').map(s => s.trim()).filter(Boolean);
    lines.forEach((line, i) => {
      const [n, sec] = line.split(/[,，\t]/).map(s => s.trim());
      if (n) dispatch({ type: 'ADD_PLAYER', player: { id: `p${st.seq + i}`, name: n, section: sec || '默认组', withdrawn: false }, at: Date.now() });
    });
    setBulk(''); setShowBulk(false);
  };

  const seedDemo = () => {
    const demo: [string, string][] = [
      ['王弈秋', '公开组'], ['李忘忧', '公开组'], ['张镇辉', '公开组'], ['陈守拙', '公开组'], ['刘劫争', '公开组'], ['赵收官', '公开组'],
      ['孙小飞', '少年组'], ['周小星', '少年组'], ['吴小目', '少年组'], ['郑小高', '少年组'], ['林小布局', '少年组'],
    ];
    demo.forEach(([n, sec], i) => dispatch({ type: 'ADD_PLAYER', player: { id: `p${st.seq + i}`, name: n, section: sec, withdrawn: false }, at: Date.now() }));
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
                  <button className="icon-btn" title="移除" onClick={() => dispatch({ type: 'REMOVE_PLAYER', playerId: p.id, at: Date.now() })}><Trash2 size={13} /></button>
                ) : p.withdrawn ? (
                  <button className="icon-btn ok" title="恢复参赛" onClick={() => dispatch({ type: 'REINSTATE', playerId: p.id, at: Date.now() })}><UserPlus size={13} /></button>
                ) : (
                  <button className="icon-btn warn" title="临时退赛" onClick={() => onWithdraw(p.id)}><UserMinus size={13} /></button>
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

function SetupPanel({ st, dispatch }: { st: State; dispatch: (e: Event) => void }) {
  const [name, setName] = useState(st.name === '未命名赛事' ? '' : st.name);
  const [cfg, setCfg] = useState(st.cfg);
  const num = (v: string, fallback: number) => { const n = parseFloat(v); return Number.isFinite(n) ? n : fallback; };

  const start = () => {
    if (st.players.length < 2) return;
    dispatch({ type: 'CONFIG', name: name.trim() || '未命名赛事', cfg: { ...cfg }, at: Date.now() });
    dispatch({ type: 'START', at: Date.now() });
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
  const { st, actor, now, shownRound, setViewRound, viewSection, setViewSection, swapMode, setSwapMode, swapSel, clickSlot, genRound, repairRound, endTournament } = props;
  const cur = currentRound(st);
  const round = st.rounds.find(r => r.n === shownRound);
  const secs = ['全部', ...[...new Set(st.players.map(p => p.section))].sort()];
  const matches = (round?.matches ?? [])
    .filter(m => viewSection === '全部' || m.section === viewSection)
    .sort((a, b) => a.table - b.table);
  const isCur = round != null && cur != null && round.n === cur.n;
  const canRepair = isCur && st.status === 'active' && round != null && !roundDirty(round);

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
            key={m.id} m={m} st={st} actor={actor} now={now} round={round!} isCur={isCur}
            swapMode={swapMode && canRepair} swapSel={swapSel} clickSlot={clickSlot}
            report={props.report} voidResult={props.voidResult} makeup={props.makeup}
            active={st.status === 'active'}
          />
        ))}
        {matches.length === 0 && (
          <div className="empty">
            {st.rounds.length === 0 ? '还没有对阵。点击下方按钮开始编排。' : '该轮该组别没有场次。'}
          </div>
        )}
        {st.rounds.length === 0 && st.status === 'active' && (
          <button className="btn primary big" onClick={genRound}><Play size={15} /> 生成第 1 轮对阵</button>
        )}
      </div>
    </section>
  );
}

function MatchRow({ m, st, actor, now, round, isCur, swapMode, swapSel, clickSlot, report, voidResult, makeup, active }: {
  m: Match; st: State; actor: string; now: number; round: Round; isCur: boolean;
  swapMode: boolean; swapSel: { matchId: string; slot: 1 | 2 } | null;
  clickSlot: (id: string, slot: 1 | 2) => void;
  report: (m: Match, r: ResultCode) => void; voidResult: (m: Match) => void; makeup: (m: Match) => void;
  active: boolean;
}) {
  const p1 = playerName(st, m.p1), p2 = playerName(st, m.p2);
  const deadline = round.startedAt + st.cfg.timeoutMin * 60_000;
  const overdue = active && isCur && m.result == null && m.status !== 'bye' && now > deadline;
  const ruled = isRuled(m);
  const isChief = actor === '裁判长';
  const canReport = active && m.status !== 'bye' && !m.supersededBy && (!ruled || isChief);
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
          {ruled && <span className="tag ruled"><Gavel size={10} /> 裁判长已裁定</span>}
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
        {canReport && (
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
        )}
        {ruled && !isChief && active && m.status !== 'bye' && !m.supersededBy && (
          <span className="tag muted">已裁定，如需改判请切换裁判长</span>
        )}
        {active && m.result != null && m.status !== 'bye' && (
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

// ---------------- 裁定链（事件流 + 任意步恢复 + 回退分支存档） ----------------

function LogView({ doc, st, askRestore }: { doc: Doc; st: State; askRestore: (k: number, label: string) => void }) {
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
            <button className="btn tiny" onClick={() => askRestore(it.idx + 1, `第 ${it.idx + 1} 步之后`)}>回到此步</button>
          </div>
        ))}
      </div>

      {doc.branches.length > 0 && (
        <div className="branch-section">
          <h3>回退分支（仅作记录，不影响当前进度）</h3>
          {doc.branches.map(b => (
            <details key={b.id} className="branch">
              <summary>{b.label} · {b.events.length} 步 · 存档于 {fmtTime(b.archivedAt)}</summary>
              {b.events.map((e, i) => <p key={i}>{fmtTime(e.at)} · {describeEvent(e, st)}</p>)}
            </details>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------- 快照 ----------------

function SnapView({ doc, askRestoreSnap, delSnap }: {
  doc: Doc; askRestoreSnap: (id: string, label: string) => void; delSnap: (id: string) => void;
}) {
  return (
    <section>
      <p className="hint">快照保存完整进度（生成新一轮时自动存档）。恢复快照只切换活动链，当前进度会存入回退分支，不会丢失。</p>
      <div className="snap-list">
        {doc.snaps.length === 0 && <div className="empty">还没有快照。点击顶栏「快照」保存当前进度。</div>}
        {[...doc.snaps].reverse().map(s => (
          <div key={s.id} className={s.chain.length === doc.head ? 'snap-row current' : 'snap-row'}>
            <Camera size={14} />
            <div className="snap-info">
              <b>{s.label}{s.auto && <span className="tag muted"> 自动</span>}</b>
              <span>{new Date(s.at).toLocaleString('zh-CN')} · 第 {s.chain.length} 步{s.chain.length === doc.head ? ' · 当前位置' : ''}</span>
            </div>
            <button className="btn small" onClick={() => askRestoreSnap(s.id, s.label)}>恢复</button>
            <button className="icon-btn" title="删除快照" onClick={() => delSnap(s.id)}><Trash2 size={13} /></button>
          </div>
        ))}
      </div>
    </section>
  );
}
