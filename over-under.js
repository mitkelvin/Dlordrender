const APP_ID = 1089;

const SYMBOLS = ["R_10", "R_25", "R_50", "R_75", "R_100", "1HZ10V", "1HZ25V", "1HZ50V", "1HZ75V", "1HZ100V"];
const MAX_HISTORY = 200;

// ---- Assumptions made where the spec left a formula undefined ----
// - "Strongly disagree" for the WAIT conflict rule (section 6) is defined as
//   |P50 - P200| > 10 percentage points.
// - Consistency and decision thresholds (section 10) are evaluated against the
//   SMOOTHED 20-tick probability, since that is the number actually used in
//   P_final. The raw 20-tick number is not otherwise used downstream.
// - The digit score (section 8) combines weighted frequency, momentum and
//   long-term deviation: score = 100*(0.6*D + 0.3*momentum + 0.1*deviation),
//   clamped to 0-100. This is one reasonable normalization of the spec's
//   "can combine" language, not a specified formula.
// These are marked in the UI as statistical outputs requiring backtesting,
// per section 14/15 of the spec.

let ws;
let symbol = "R_50";
let history = []; // rolling digit history, capped at MAX_HISTORY
let renderLock = false;

// session backtest log
let pendingSignal = null; // {direction, consistency, weighted, timestamp}
let log = []; // resolved signals: {timestamp, direction, weighted, consistency, win}

const liveDiv = document.getElementById("live");
const bestVolDiv = document.getElementById("bestVol");
const scanBtn = document.getElementById("scanBtn");
const topDigitsDiv = document.getElementById("topDigits");
const decisionEl = document.getElementById("decision");
const edgeInfoEl = document.getElementById("edgeInfo");
const backtestDiv = document.getElementById("backtest");

document.getElementById("startBtn").onclick = () => {
  symbol = document.getElementById("symbol").value;
  startAnalysis(symbol);
};

document.getElementById("symbol").onchange = (e) => {
  if (ws && ws.readyState === 1) {
    startAnalysis(e.target.value);
  }
};

function startAnalysis(sym) {
  document.getElementById("loading").classList.remove("hidden");

  symbol = sym;
  history = [];
  pendingSignal = null;
  liveDiv.innerHTML = "";
  document.getElementById("symbol").value = sym;

  if (ws) {
    try { ws.close(); } catch (e) {}
  }

  ws = new WebSocket(`wss://api.derivws.com/trading/v1/options/ws/public?app_id=${APP_ID}`);

  ws.onopen = () => {
    ws.send(JSON.stringify({
      ticks_history: symbol,
      adjust_start_time: 1,
      count: MAX_HISTORY,
      end: "latest",
      style: "ticks"
    }));
    ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
    document.getElementById("loading").classList.add("hidden");
    decisionEl.textContent = "⚠️ Connection error — see console";
    decisionEl.className = "decision no-trade";
  };

  ws.onclose = (evt) => {
    console.warn("WebSocket closed:", evt.code, evt.reason);
  };

  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);

    if (data.error) {
      console.error("API error:", data.error.code, data.error.message, data);
      document.getElementById("loading").classList.add("hidden");
      decisionEl.textContent = `⚠️ ${data.error.message}`;
      decisionEl.className = "decision no-trade";
      return;
    }

    if (data.msg_type === "history" && data.history) {
      history = data.history.prices.map(getDigit).slice(-MAX_HISTORY);
      document.getElementById("loading").classList.add("hidden");
      renderLiveStrip();
      runAnalysis();
    }

    if (data.msg_type === "tick" && data.tick) {
      onTick(data.tick.quote);
    }
  };
}

function getDigit(price) {
  return Number(String(price).slice(-1));
}

function onTick(price) {
  const digit = getDigit(price);

  // resolve any pending signal against this new digit BEFORE appending it
  resolvePendingSignal(digit);

  history.push(digit);
  if (history.length > MAX_HISTORY) history.shift();

  renderLiveStrip();
  runAnalysis();
}

function renderLiveStrip() {
  if (renderLock) return;
  renderLock = true;

  requestAnimationFrame(() => {
    liveDiv.innerHTML = "";
    const last10 = history.slice(-10);

    last10.forEach((d, i) => {
      const el = document.createElement("span");
      el.className = "tick";
      el.textContent = String(d);
      if (i === last10.length - 1) el.classList.add("new");
      liveDiv.appendChild(el);
    });

    renderLock = false;
  });
}

// ============== CORE ENGINE (spec sections 1-11) ==============

function windowStats(arr, n) {
  const slice = arr.slice(-n);
  let over = 0, under = 0;
  slice.forEach(d => {
    if (d >= 4) over++;
    if (d <= 5) under++;
  });
  return { n: slice.length, over_k: over, under_k: under, over: over / slice.length, under: under / slice.length };
}

// Section 3: baseline smoothing, applied to the 20-tick window
function smooth(k, n) {
  return (k + 12) / (n + 20);
}

function consistencyScore(p200, p50, p20) {
  let score = 0;
  if (p200 > 0.60) score++;
  if (p50 > 0.60) score++;
  if (p20 > 0.60) score++;
  if (p50 > p200) score++;
  if (p20 > p50) score++;
  return score;
}

function classifyDecision(pFinal, consistency, p200, p50, p20, conflict) {
  if (conflict === "no_trade") return "NO_TRADE";
  if (pFinal >= 0.67 && consistency >= 4 && p200 >= 0.64 && p50 >= 0.60 && p20 >= 0.60) return "TRADE_CANDIDATE";
  if ((pFinal >= 0.63 && pFinal < 0.67) || consistency === 3 || conflict === "wait") return "WAIT";
  return "NO_TRADE";
}

// Full analysis for one digit history array (used for live symbol AND scanner)
function analyzeHistory(arr) {
  if (arr.length < 30) return null;

  const w200 = windowStats(arr, 200);
  const w50 = windowStats(arr, 50);
  const w20 = windowStats(arr, 20);

  const over20s = smooth(w20.over_k, w20.n);
  const under20s = smooth(w20.under_k, w20.n);

  const overFinal = 0.5 * w200.over + 0.3 * w50.over + 0.2 * over20s;
  const underFinal = 0.5 * w200.under + 0.3 * w50.under + 0.2 * under20s;

  const overConsistency = consistencyScore(w200.over, w50.over, over20s);
  const underConsistency = consistencyScore(w200.under, w50.under, under20s);

  // Section 6: conflict filter, evaluated per direction
  function conflictFor(p200, p50, p20) {
    if (p200 > 0.60 && p50 < 0.55 && p20 < 0.55) return "no_trade";
    if (Math.abs(p50 - p200) > 0.10) return "wait";
    return "none";
  }

  const overConflict = conflictFor(w200.over, w50.over, over20s);
  const underConflict = conflictFor(w200.under, w50.under, under20s);

  const overDecision = classifyDecision(overFinal, overConsistency, w200.over, w50.over, over20s, overConflict);
  const underDecision = classifyDecision(underFinal, underConsistency, w200.under, w50.under, under20s, underConflict);

  // Section 7-9: individual digit engine
  const digitStats = [];
  for (let d = 0; d <= 9; d++) {
    const f200 = arr.slice(-200).filter(x => x === d).length / Math.min(arr.length, 200);
    const f50 = arr.slice(-50).filter(x => x === d).length / Math.min(arr.length, 50);
    const f20 = arr.slice(-20).filter(x => x === d).length / Math.min(arr.length, 20);

    const D = 0.5 * f200 + 0.3 * f50 + 0.2 * f20;
    const momentum = f20 - f50;
    const deviation = f200 - 0.10;

    let score = 100 * (0.6 * D + 0.3 * Math.max(momentum, 0) + 0.1 * Math.max(deviation, 0));
    score = Math.max(0, Math.min(100, Math.round(score)));

    let status = "WEAK";
    if (f200 > 0.10 && f50 > 0.10 && f20 > 0.10) status = "STRONG+";
    else if (f200 > 0.10 && f50 > 0.10) status = "STRONG";
    else if (D > 0.105) status = "MODERATE";

    digitStats.push({ digit: d, f200, f50, f20, D, momentum, deviation, score, status });
  }

  const topDigits = [...digitStats].sort((a, b) => b.score - a.score).slice(0, 3);

  return {
    w200, w50, w20,
    over: { p200: w200.over, p50: w50.over, p20smoothed: over20s, final: overFinal, consistency: overConsistency, conflict: overConflict, decision: overDecision },
    under: { p200: w200.under, p50: w50.under, p20smoothed: under20s, final: underFinal, consistency: underConsistency, conflict: underConflict, decision: underDecision },
    digitStats, topDigits
  };
}

// Section 11: overlap resolution using payout-based edge
function pickDirection(result, payoutR) {
  const overIsCandidate = result.over.decision === "TRADE_CANDIDATE";
  const underIsCandidate = result.under.decision === "TRADE_CANDIDATE";
  const breakEven = 1 / (payoutR + 1);

  if (overIsCandidate && underIsCandidate) {
    const overEdge = result.over.final - breakEven;
    const underEdge = result.under.final - breakEven;
    return overEdge >= underEdge
      ? { direction: "OVER 3", stats: result.over, edge: overEdge, breakEven }
      : { direction: "UNDER 6", stats: result.under, edge: underEdge, breakEven };
  }
  if (overIsCandidate) return { direction: "OVER 3", stats: result.over, edge: result.over.final - breakEven, breakEven };
  if (underIsCandidate) return { direction: "UNDER 6", stats: result.under, edge: result.under.final - breakEven, breakEven };

  // no candidate — report whichever direction is closer to threshold, for the WAIT/NO_TRADE display
  const best = result.over.final >= result.under.final ? { direction: "OVER 3", stats: result.over } : { direction: "UNDER 6", stats: result.under };
  return { direction: best.direction, stats: best.stats, edge: best.stats.final - breakEven, breakEven };
}

// ============== LIVE UI RENDERING ==============

function pct(x) { return (x * 100).toFixed(1) + "%"; }

function runAnalysis() {
  const result = analyzeHistory(history);
  if (!result) return;

  document.getElementById("over200").textContent = pct(result.over.p200);
  document.getElementById("over50").textContent = pct(result.over.p50);
  document.getElementById("over20").textContent = pct(result.over.p20smoothed);
  document.getElementById("overFinal").textContent = pct(result.over.final);
  document.getElementById("overConsistency").textContent = `${result.over.consistency}/5`;

  document.getElementById("under200").textContent = pct(result.under.p200);
  document.getElementById("under50").textContent = pct(result.under.p50);
  document.getElementById("under20").textContent = pct(result.under.p20smoothed);
  document.getElementById("underFinal").textContent = pct(result.under.final);
  document.getElementById("underConsistency").textContent = `${result.under.consistency}/5`;

  document.getElementById("overFinalBig").textContent = pct(result.over.final);
  document.getElementById("underFinalBig").textContent = pct(result.under.final);

  renderTopDigits(result.topDigits);

  const payoutR = parseFloat(document.getElementById("payout").value) || 0.95;
  const picked = pickDirection(result, payoutR);

  const decisionLabel = picked.stats.decision.replace("_", " ");
  decisionEl.textContent = `${decisionLabel} — ${picked.direction}`;
  decisionEl.className = "decision " + (
    picked.stats.decision === "TRADE_CANDIDATE" ? "trade" :
    picked.stats.decision === "WAIT" ? "wait" : "no-trade"
  );

  edgeInfoEl.textContent = `Break-even: ${pct(picked.breakEven)} | Model edge: ${(picked.edge * 100).toFixed(2)} pts (payout R=${payoutR}) — edge estimate carries model uncertainty, do not treat a small margin as reliable.`;

  // log a new signal only when the decision changes to something worth recording
  if (picked.stats.decision === "TRADE_CANDIDATE" || picked.stats.decision === "WAIT") {
    if (!pendingSignal || pendingSignal.direction !== picked.direction || pendingSignal.decision !== picked.stats.decision) {
      pendingSignal = {
        direction: picked.direction,
        decision: picked.stats.decision,
        weighted: picked.stats.final,
        consistency: picked.stats.consistency,
        timestamp: Date.now()
      };
    }
  }

  renderBacktest();
}

function renderTopDigits(topDigits) {
  topDigitsDiv.innerHTML = "";
  topDigits.forEach((d, i) => {
    const el = document.createElement("span");
    const statusClass = d.status === "STRONG+" ? "candidate-strong-plus" :
      d.status === "STRONG" ? "candidate-strong" :
      d.status === "MODERATE" ? "candidate-moderate" : "candidate-weak";
    el.className = "digit-candidate " + statusClass;
    el.innerHTML = `#${i + 1} Digit ${d.digit} — Score ${d.score} (${d.status})`;
    topDigitsDiv.appendChild(el);
  });
}

function resolvePendingSignal(actualDigit) {
  if (!pendingSignal || pendingSignal.decision !== "TRADE_CANDIDATE") {
    pendingSignal = null;
    return;
  }
  const win = pendingSignal.direction === "OVER 3" ? actualDigit >= 4 : actualDigit <= 5;
  log.push({ ...pendingSignal, actualDigit, win });
  pendingSignal = null;
}

function renderBacktest() {
  if (log.length === 0) {
    backtestDiv.textContent = "No resolved TRADE CANDIDATE signals yet this session.";
    return;
  }

  const wins = log.filter(l => l.win).length;
  const overSignals = log.filter(l => l.direction === "OVER 3");
  const underSignals = log.filter(l => l.direction === "UNDER 6");
  const overWinRate = overSignals.length ? (overSignals.filter(l => l.win).length / overSignals.length) : null;
  const underWinRate = underSignals.length ? (underSignals.filter(l => l.win).length / underSignals.length) : null;

  let streak = 0, maxLoseStreak = 0, cur = 0;
  log.forEach(l => {
    if (!l.win) { cur++; maxLoseStreak = Math.max(maxLoseStreak, cur); }
    else cur = 0;
  });

  backtestDiv.innerHTML =
    `Signals: ${log.length} | Overall win rate: ${pct(wins / log.length)}<br>` +
    `Over 3: ${overSignals.length} signals${overWinRate !== null ? `, ${pct(overWinRate)} win rate` : ""}<br>` +
    `Under 6: ${underSignals.length} signals${underWinRate !== null ? `, ${pct(underWinRate)} win rate` : ""}<br>` +
    `Max losing streak: ${maxLoseStreak}<br>` +
    `<em>Section 14 recommends 500+ signals before drawing conclusions.</em>`;
}

// ============== BEST VOLATILITIES SCANNER (same engine, all symbols) ==============

scanBtn.onclick = () => scanAllVolatilities();

async function scanAllVolatilities() {
  scanBtn.disabled = true;
  bestVolDiv.textContent = "Scanning all volatilities...";

  const scanWs = new WebSocket(`wss://api.derivws.com/trading/v1/options/ws/public?app_id=${APP_ID}`);

  try {
    await new Promise((resolve, reject) => {
      scanWs.onopen = resolve;
      scanWs.onerror = reject;
    });

    const results = [];
    for (const sym of SYMBOLS) {
      try {
        const digits = await fetchSymbolHistory(scanWs, sym);
        const analysis = analyzeHistory(digits);
        if (analysis) results.push({ symbol: sym, analysis });
      } catch (e) {
        console.error("Scan failed for", sym, e);
      }
    }

    scanWs.close();
    renderBestVolatilities(results);

  } catch (e) {
    console.error("Scan connection error:", e);
    bestVolDiv.textContent = "⚠️ Could not scan — see console";
  } finally {
    scanBtn.disabled = false;
  }
}

function fetchSymbolHistory(scanWs, sym) {
  return new Promise((resolve, reject) => {
    const handler = (msg) => {
      const data = JSON.parse(msg.data);

      if (data.error) {
        scanWs.removeEventListener("message", handler);
        reject(data.error);
        return;
      }

      if (data.msg_type === "history" && data.history && data.echo_req && data.echo_req.ticks_history === sym) {
        scanWs.removeEventListener("message", handler);
        resolve(data.history.prices.map(getDigit));
      }
    };

    scanWs.addEventListener("message", handler);

    scanWs.send(JSON.stringify({
      ticks_history: sym,
      adjust_start_time: 1,
      count: MAX_HISTORY,
      end: "latest",
      style: "ticks"
    }));
  });
}

function renderBestVolatilities(results) {
  const payoutR = parseFloat(document.getElementById("payout").value) || 0.95;

  const scored = results.map(r => {
    const picked = pickDirection(r.analysis, payoutR);
    return { symbol: r.symbol, direction: picked.direction, decision: picked.stats.decision, weighted: picked.stats.final, consistency: picked.stats.consistency, edge: picked.edge };
  });

  const candidates = scored.filter(s => s.decision === "TRADE_CANDIDATE" || s.decision === "WAIT")
    .sort((a, b) => {
      // TRADE_CANDIDATE first, then by edge
      if (a.decision !== b.decision) return a.decision === "TRADE_CANDIDATE" ? -1 : 1;
      return b.edge - a.edge;
    });

  bestVolDiv.innerHTML = "";

  if (candidates.length === 0) {
    bestVolDiv.textContent = "No volatilities currently meet TRADE CANDIDATE or WAIT criteria.";
    return;
  }

  candidates.forEach(c => {
    const btn = document.createElement("button");
    btn.className = "vol-btn" + (c.decision === "WAIT" ? " wait" : "");
    btn.textContent = `${symbolLabel(c.symbol)} — ${c.decision.replace("_", " ")} ${c.direction} | Weighted ${pct(c.weighted)} | Consistency ${c.consistency}/5`;
    btn.onclick = () => startAnalysis(c.symbol);
    bestVolDiv.appendChild(btn);
  });
}

function symbolLabel(sym) {
  const opt = document.querySelector(`#symbol option[value="${sym}"]`);
  return opt ? opt.textContent : sym;
}
