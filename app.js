const WS_URL = "wss://ws.binaryws.com/websockets/v3";
let ws = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let selectedSymbol = "1HZ100V";
let ticks = [];
let connectedAt = 0;
let lastTickEpoch = 0;
const MAX_TICKS = 250;

const $ = id => document.getElementById(id);
const connection = $("connection");
const connectionText = $("connectionText");
const market = $("market");
const contractType = $("contractType");
const targetDigit = $("targetDigit");

function setStatus(kind, text) {
  connection.className = "status " + kind;
  connectionText.textContent = text;
}

function log(msg) {
  const el = $("log");
  const d = document.createElement("div");
  d.textContent = new Date().toLocaleTimeString() + " — " + msg;
  el.prepend(d);
  while (el.children.length > 20) el.lastChild.remove();
}

function digitOfQuote(q) {
  const s = String(q);
  const clean = s.includes(".") ? s.replace(/0+$/,"") : s;
  return Number(clean.slice(-1));
}

function formatPrice(q) {
  return Number(q).toLocaleString(undefined,{maximumFractionDigits:8});
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connect() {
  clearTimeout(reconnectTimer);
  setStatus("connecting","CONNECTING TO DERIV...");
  try { ws = new WebSocket(WS_URL); }
  catch(e) { scheduleReconnect(); return; }

  ws.onopen = () => {
    reconnectAttempts = 0;
    connectedAt = performance.now();
    setStatus("connected","LIVE MARKET CONNECTED");
    log("Connected to Deriv market-data WebSocket.");
    send({active_symbols:"brief", product_type:"basic", req_id:1});
    subscribe(selectedSymbol);
  };

  ws.onmessage = e => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }

    if (data.error) {
      log("API error: " + (data.error.message || "Unknown error"));
      setStatus("disconnected","API ERROR — RECONNECTING...");
      return;
    }

    if (data.msg_type === "active_symbols") {
      populateSymbols(data.active_symbols || []);
      return;
    }

    if (data.msg_type === "tick" && data.tick) {
      handleTick(data.tick);
      return;
    }

    if (data.msg_type === "ping") return;
  };

  ws.onerror = () => {
    setStatus("disconnected","CONNECTION ERROR — RECONNECTING...");
  };

  ws.onclose = () => {
    setStatus("disconnected","DISCONNECTED — RECONNECTING...");
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(1.7, Math.min(reconnectAttempts,7)), 15000);
  reconnectTimer = setTimeout(connect, delay);
}

function subscribe(symbol) {
  selectedSymbol = symbol;
  ticks = [];
  $("tickCount").textContent = "0";
  $("lastDigit").textContent = "—";
  $("price").textContent = "—";
  $("signal").textContent = "WAIT";
  $("confidence").textContent = "0.0%";
  $("reason").textContent = "Collecting live tick data...";
  send({ticks:symbol, subscribe:1, req_id:2});
  log("Subscribed to " + symbol + ".");
}

function populateSymbols(list) {
  const wanted = [
    ["1HZ100V","Volatility 100 Index"],
    ["1HZ75V","Volatility 75 (1s) Index"],
    ["1HZ50V","Volatility 50 (1s) Index"],
    ["1HZ25V","Volatility 25 (1s) Index"],
    ["1HZ10V","Volatility 10 (1s) Index"]
  ];
  const available = new Map(list.map(x => [x.symbol, x.display_name]));
  market.innerHTML = "";
  wanted.forEach(([sym,name]) => {
    if (available.has(sym) || sym === "1HZ100V") {
      const o = document.createElement("option");
      o.value = sym; o.textContent = available.get(sym) || name;
      market.appendChild(o);
    }
  });
  market.value = selectedSymbol;
}

function handleTick(tick) {
  const quote = Number(tick.quote);
  if (!Number.isFinite(quote)) return;

  const digit = digitOfQuote(tick.quote);
  const epoch = Number(tick.epoch) * 1000;
  lastTickEpoch = epoch;

  ticks.push({quote,digit,epoch});
  if (ticks.length > MAX_TICKS) ticks.shift();

  $("price").textContent = formatPrice(quote);
  $("lastDigit").textContent = digit;
  $("tickCount").textContent = ticks.length;

  const latency = Math.max(0, Date.now() - epoch);
  $("latency").textContent = latency + " ms";

  renderFeed();
  renderDistribution();
  analyze();
}

function renderFeed() {
  const el = $("feed");
  el.innerHTML = "";
  ticks.slice(-12).reverse().forEach(t => {
    const d = document.createElement("div");
    d.className = "row";
    d.innerHTML = `<span>${new Date(t.epoch).toLocaleTimeString()}</span><span>${formatPrice(t.quote)} • digit ${t.digit}</span>`;
    el.appendChild(d);
  });
}

function renderDistribution() {
  const counts = Array(10).fill(0);
  ticks.forEach(t => counts[t.digit]++);
  const total = ticks.length || 1;
  const el = $("digits");
  el.innerHTML = "";
  counts.forEach((n,d) => {
    const pct = n / total * 100;
    const box = document.createElement("div");
    box.className = "digit";
    box.innerHTML = `<b>${d}</b><div class="bar"><i style="width:${pct}%"></i></div><span>${pct.toFixed(1)}%</span>`;
    el.appendChild(box);
  });
}

function analyze() {
  if (ticks.length < 20) {
    $("signal").textContent = "WAIT";
    $("confidence").textContent = "0.0%";
    $("reason").textContent = `Collecting data: ${ticks.length}/20 ticks`;
    return;
  }

  const target = Number(targetDigit.value);
  const matches = ticks.filter(t => t.digit === target).length;
  const p = matches / ticks.length;
  const base = 10;

  // Descriptive confidence: distance from the 10% baseline,
  // capped to avoid presenting a tiny sample as certainty.
  const edge = Math.abs(p - 0.10);
  const confidence = Math.min(99, 50 + edge * 500);
  const type = contractType.value;

  let signal = "WAIT";
  let reason = `Digit ${target}: ${(p*100).toFixed(1)}% in the last ${ticks.length} ticks.`;

  if (ticks.length >= 50) {
    if (type === "matches" && p >= 0.13) {
      signal = "MATCH";
      reason += " Recent frequency is above the 10% baseline.";
    } else if (type === "differs" && p <= 0.87) {
      signal = "DIFFER";
      reason += " The selected digit has not dominated the recent sample.";
    } else {
      reason += " No strong frequency condition detected.";
    }
  } else {
    reason += " Waiting for a larger sample.";
  }

  $("signal").textContent = signal;
  $("confidence").textContent = confidence.toFixed(1) + "%";
  $("reason").textContent = reason;
}

$("market").addEventListener("change", () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    subscribe(market.value);
  } else {
    selectedSymbol = market.value;
  }
});

$("runBtn").addEventListener("click", () => {
  ticks = [];
  $("tickCount").textContent = "0";
  $("signal").textContent = "WAIT";
  $("confidence").textContent = "0.0%";
  $("reason").textContent = "Analysis reset — collecting fresh live ticks...";
  if (ws && ws.readyState === WebSocket.OPEN) subscribe(market.value);
  else connect();
});

contractType.addEventListener("change", analyze);
targetDigit.addEventListener("change", analyze);

setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    send({ping:1, req_id:99});
  }
}, 20000);

connect();
