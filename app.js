const WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public";

let ws = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let selectedSymbol = "1HZ100V";
let ticks = [];
const MAX_TICKS = 250;

const $ = id => document.getElementById(id);

function setStatus(kind, text) {
  const el = $("connection");
  el.className = "status " + kind;
  $("connectionText").textContent = text;
}

function log(msg) {
  const el = $("log");
  const d = document.createElement("div");
  d.textContent = new Date().toLocaleTimeString() + " — " + msg;
  el.prepend(d);
  while (el.children.length > 20) el.lastChild.remove();
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function digitOfQuote(q) {
  const s = String(q);
  const parts = s.split(".");
  if (parts.length === 1) return Number(s.slice(-1));
  const decimals = parts[1];
  return Number(decimals.length ? decimals.slice(-1) : parts[0].slice(-1));
}

function formatPrice(q) {
  return Number(q).toLocaleString(undefined, {maximumFractionDigits: 8});
}

function resetAnalysis(message = "Collecting live tick data...") {
  ticks = [];
  $("tickCount").textContent = "0";
  $("lastDigit").textContent = "—";
  $("price").textContent = "—";
  $("latency").textContent = "—";
  $("signal").textContent = "WAIT";
  $("confidence").textContent = "0.0%";
  $("reason").textContent = message;
  renderFeed();
  renderDistribution();
}

function connect() {
  clearTimeout(reconnectTimer);
  setStatus("connecting", "CONNECTING TO DERIV...");

  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    log("Browser could not create WebSocket: " + e.message);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    reconnectAttempts = 0;
    setStatus("connected", "LIVE MARKET CONNECTED");
    log("Connected to Deriv public market-data WebSocket.");
    resetAnalysis("Connected. Waiting for live ticks...");
    subscribe(selectedSymbol);
  };

  ws.onmessage = event => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      log("Received a non-JSON response.");
      return;
    }

    if (data.error) {
      const msg = data.error.message || data.error.code || "Unknown Deriv API error";
      log("Deriv API error: " + msg);
      setStatus("disconnected", "DERIV API ERROR — CHECKING CONNECTION...");
      return;
    }

    if (data.msg_type === "tick" && data.tick) {
      handleTick(data.tick);
      return;
    }

    if (data.msg_type === "ping") return;

    // New API may return other system messages; keep them visible for diagnosis.
    if (data.msg_type && data.msg_type !== "tick") {
      log("Deriv response: " + data.msg_type);
    }
  };

  ws.onerror = () => {
    log("WebSocket network error.");
    setStatus("disconnected", "CONNECTION ERROR — RECONNECTING...");
  };

  ws.onclose = event => {
    log("WebSocket closed (" + event.code + ").");
    setStatus("disconnected", "DISCONNECTED — RECONNECTING...");
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(1.7, Math.min(reconnectAttempts, 7)), 15000);
  reconnectTimer = setTimeout(connect, delay);
}

function subscribe(symbol) {
  selectedSymbol = symbol;
  resetAnalysis("Subscribed. Waiting for live ticks...");
  send({
    ticks: symbol,
    subscribe: 1,
    req_id: 2
  });
  log("Requested live ticks for " + symbol + ".");
}

function handleTick(tick) {
  const quote = Number(tick.quote);
  if (!Number.isFinite(quote)) return;

  const digit = digitOfQuote(tick.quote);
  const epoch = Number(tick.epoch) * 1000;

  ticks.push({quote, digit, epoch});
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
    d.innerHTML =
      `<span>${new Date(t.epoch).toLocaleTimeString()}</span>` +
      `<span>${formatPrice(t.quote)} • digit ${t.digit}</span>`;
    el.appendChild(d);
  });
}

function renderDistribution() {
  const counts = Array(10).fill(0);
  ticks.forEach(t => counts[t.digit]++);
  const total = ticks.length || 1;
  const el = $("digits");
  el.innerHTML = "";

  counts.forEach((n, d) => {
    const pct = n / total * 100;
    const box = document.createElement("div");
    box.className = "digit";
    box.innerHTML =
      `<b>${d}</b><div class="bar"><i style="width:${pct}%"></i></div>` +
      `<span>${pct.toFixed(1)}%</span>`;
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

  const target = Number($("targetDigit").value);
  const matches = ticks.filter(t => t.digit === target).length;
  const p = matches / ticks.length;
  const type = $("contractType").value;

  // Descriptive score only. It is not a prediction or guaranteed probability.
  const edge = Math.abs(p - 0.10);
  const confidence = Math.min(99, 50 + edge * 500);

  let signal = "WAIT";
  let reason =
    `Digit ${target}: ${(p * 100).toFixed(1)}% in the last ${ticks.length} ticks.`;

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
  selectedSymbol = $("market").value;
  if (ws && ws.readyState === WebSocket.OPEN) subscribe(selectedSymbol);
});

$("runBtn").addEventListener("click", () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    subscribe($("market").value);
  } else {
    connect();
  }
});

$("contractType").addEventListener("change", analyze);
$("targetDigit").addEventListener("change", analyze);

setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    send({ping: 1, req_id: 99});
  }
}, 20000);

connect();
