// Aura: browser side.
// Webcam + MediaPipe hand tracking run here; relay commands go through the
// Node server, which talks to the ESP8266.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ---------------------------------------------------------------------------
// Settings (same behaviour as the original Python app)
// ---------------------------------------------------------------------------
const STABLE_FRAMES = 6; // a gesture must hold this many camera frames
const MIN_GAP_MS = 500; // cooldown between commands
const RETRY_GAP_MS = 3000; // wait this long before retrying a failed command

const TASKS_VERSION = "0.10.14";
const TASKS_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";

const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];
const TIPS = [4, 8, 12, 16, 20];

// ---------------------------------------------------------------------------
// Elements & app state
// ---------------------------------------------------------------------------
const video = $("#video");
const canvas = $("#overlay");
const ctx = canvas.getContext("2d");
const frameEl = $("#frame");
const veil = $("#veil");
const fingerEls = $$("#fingers i");
const holdBar = $("#holdBar");
const cfg = $("#cfg");

const app = {
  server: null, // latest state from the Node server
  serverUp: false,
  tracker: null,
  paused: false,
  skeleton: true,
  candidate: null, // true = open hand, false = fist, null = neither
  frames: 0,
  lastTriggered: null,
  lastSent: 0,
  lastOk: true,
  pending: false,
  fps: 0,
};

// ---------------------------------------------------------------------------
// Server connection (live state over SSE)
// ---------------------------------------------------------------------------
function connectEvents() {
  const es = new EventSource("/api/events");
  es.onopen = () => { app.serverUp = true; renderConn(); };
  es.onmessage = (e) => { app.server = JSON.parse(e.data); app.serverUp = true; renderServer(); };
  es.onerror = () => { app.serverUp = false; renderConn(); }; // the browser reconnects on its own
}

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "The request failed.");
  return data;
}

// ---------------------------------------------------------------------------
// Relay control
// ---------------------------------------------------------------------------
const targetKey = () => $('input[name="target"]:checked').value;
const relayName = (t) => (t === "both" ? "Both relays" : `Relay ${t}`);
const now = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function targetIsOn() {
  const s = app.server;
  if (!s) return null;
  const t = targetKey();
  if (t === "both") return s.relay1 == null || s.relay2 == null ? null : s.relay1 && s.relay2;
  return t === "1" ? s.relay1 : s.relay2;
}

async function sendRelay(relay, on, source) {
  if (app.pending) return false;
  app.pending = true;
  try {
    await api("/api/relay", { relay, state: on ? "on" : "off" });
    log(`${now()}  ${relayName(relay)} turned ${on ? "on" : "off"} (${source})`, "ok");
    ping(on);
    return true;
  } catch (err) {
    log(err.message, "error");
    return false;
  } finally {
    app.pending = false;
  }
}

function ping(on) {
  frameEl.classList.remove("ping-on", "ping-off");
  void frameEl.offsetWidth; // restart the animation
  frameEl.classList.add(on ? "ping-on" : "ping-off");
}

function log(message, kind = "") {
  const el = $("#log");
  el.textContent = message;
  el.className = `log ${kind}`;
}

async function refresh() {
  try {
    await api("/api/refresh");
    log(`${now()}  Refreshed`, "ok");
  } catch (err) {
    log(err.message, "error");
  }
}

// ---------------------------------------------------------------------------
// Rendering server state
// ---------------------------------------------------------------------------
const hostOf = (url) => {
  try { return new URL(url).host; } catch { return url; }
};

function renderConn() {
  const dot = $("#connDot");
  const text = $("#connText");
  const s = app.server;

  if (!app.serverUp) {
    dot.dataset.tone = "bad";
    text.textContent = "Dashboard server stopped";
  } else if (!s) {
    dot.dataset.tone = "warn";
    text.textContent = "Connecting…";
  } else if (s.online) {
    dot.dataset.tone = "ok";
    text.textContent = `Connected to ${hostOf(s.baseUrl)}`;
  } else {
    dot.dataset.tone = "warn";
    text.textContent = `Can't reach ${hostOf(s.baseUrl)}`;
  }
}

function renderServer() {
  const s = app.server;
  if (!s) return;

  renderConn();

  const label = (v) => (v == null ? "No signal" : v ? "On" : "Off");
  $("#r1Text").textContent = label(s.relay1);
  $("#r2Text").textContent = label(s.relay2);
  $$(".switch").forEach((b) => {
    const v = b.dataset.relay === "1" ? s.relay1 : s.relay2;
    b.setAttribute("aria-checked", v ? "true" : "false");
  });

  document.body.dataset.relay =
    s.relay1 || s.relay2 ? "on" : s.relay1 === false && s.relay2 === false ? "off" : "unknown";

  $("#temp").textContent = s.temp == null ? "--" : s.temp.toFixed(1);
  $("#hum").textContent = s.hum == null ? "--" : Math.round(s.hum);
  $("#motion").textContent = s.motion == null ? "--" : s.motion ? "Movement detected" : "Still";
}

// ---------------------------------------------------------------------------
// Camera & hand tracking
// ---------------------------------------------------------------------------
function showVeil(title, body = "", light = false) {
  $("#veilTitle").textContent = title;
  $("#veilBody").textContent = body;
  veil.classList.toggle("light", light);
  veil.hidden = false;
}
const hideVeil = () => { veil.hidden = true; };

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showVeil(
      "Camera isn't available here",
      `Open this page at http://localhost:${location.port || 80}. Browsers only allow camera access on localhost or HTTPS.`
    );
    return false;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    if (!video.videoWidth) await new Promise((r) => video.addEventListener("loadedmetadata", r, { once: true }));
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    frameEl.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    return true;
  } catch (err) {
    const blocked = err.name === "NotAllowedError" || err.name === "SecurityError";
    const missing = err.name === "NotFoundError" || err.name === "OverconstrainedError";
    showVeil(
      blocked ? "Camera access is blocked" : missing ? "No camera found" : "Couldn't start the camera",
      blocked
        ? "Allow camera access in your browser's address bar, then reload this page."
        : missing
        ? "Connect a webcam, or close other apps that are using it, then reload."
        : err.message
    );
    return false;
  }
}

async function startTracker() {
  const vision = await import(`${TASKS_CDN}/vision_bundle.mjs`);
  const fileset = await vision.FilesetResolver.forVisionTasks(`${TASKS_CDN}/wasm`);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    numHands: 1,
    minHandDetectionConfidence: 0.7,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.6,
  });
  try {
    app.tracker = await vision.HandLandmarker.createFromOptions(fileset, options("GPU"));
  } catch {
    app.tracker = await vision.HandLandmarker.createFromOptions(fileset, options("CPU"));
  }
}

// ---------------------------------------------------------------------------
// Gesture analysis (ported from analyze_fingers in the Python version)
// ---------------------------------------------------------------------------
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function analyzeFingers(lm) {
  const wrist = lm[0];
  const states = [false, false, false, false, false];

  [[8, 6], [12, 10], [16, 14], [20, 18]].forEach(([tip, pip], i) => {
    states[i + 1] = dist(lm[tip], wrist) > dist(lm[pip], wrist) * 1.1;
  });
  states[0] = dist(lm[4], lm[17]) > dist(lm[3], lm[17]) * 1.05;

  return states;
}

function drawHand(lm, states) {
  const w = canvas.width;
  const h = canvas.height;
  const P = lm.map((p) => [p.x * w, p.y * h]);
  const r = Math.max(2.5, w / 320);

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(2, w / 420);
  ctx.strokeStyle = "rgba(255,255,255,0.92)";
  ctx.shadowColor = "rgba(14,107,115,0.95)";
  ctx.shadowBlur = 12;
  for (const [a, b] of CONNECTIONS) {
    ctx.beginPath();
    ctx.moveTo(P[a][0], P[a][1]);
    ctx.lineTo(P[b][0], P[b][1]);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;

  ctx.fillStyle = "#fff";
  for (const [x, y] of P) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Fingertip rings: mint = extended, coral = folded
  ctx.lineWidth = 3;
  TIPS.forEach((idx, i) => {
    ctx.strokeStyle = states[i] ? "#7ce0c3" : "#ff8a7a";
    ctx.beginPath();
    ctx.arc(P[idx][0], P[idx][1], r * 3, 0, Math.PI * 2);
    ctx.stroke();
  });
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let lastVideoTime = -1;
let fpsFrames = 0;
let fpsSince = performance.now();
const readout = { name: "", hint: "", fps: "" };

function setReadout(name, hint) {
  if (readout.name !== name) { $("#gestureName").textContent = name; readout.name = name; }
  if (readout.hint !== hint) { $("#gestureHint").textContent = hint; readout.hint = hint; }
}

function tick() {
  requestAnimationFrame(tick);
  if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  // FPS
  fpsFrames++;
  const t = performance.now();
  if (t - fpsSince >= 500) {
    app.fps = (fpsFrames * 1000) / (t - fpsSince);
    fpsFrames = 0;
    fpsSince = t;
    const text = `${app.fps.toFixed(0)} fps`;
    if (readout.fps !== text) { $("#fps").textContent = text; readout.fps = text; }
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  let handSeen = false;
  let gesture = null;
  let states = [false, false, false, false, false];

  if (app.tracker && !app.paused) {
    const result = app.tracker.detectForVideo(video, performance.now());
    if (result.landmarks && result.landmarks.length) {
      handSeen = true;
      const lm = result.landmarks[0];
      states = analyzeFingers(lm);
      if (app.skeleton) drawHand(lm, states);

      const count = states.filter(Boolean).length;
      if (count >= 4) gesture = true; // open hand -> on
      else if (count <= 1) gesture = false; // fist -> off
    }
  }

  fingerEls.forEach((el, i) => el.classList.toggle("up", states[i]));

  // Debounce: the same gesture has to hold for STABLE_FRAMES frames
  if (gesture !== null && gesture === app.candidate) {
    app.frames++;
  } else {
    app.candidate = gesture;
    app.frames = gesture !== null ? 1 : 0;
  }
  if (app.candidate === null) app.lastTriggered = null; // a new gesture starts fresh

  const stable = app.candidate !== null && app.frames >= STABLE_FRAMES;
  const current = targetIsOn();

  if (
    stable &&
    app.candidate !== app.lastTriggered &&
    app.candidate !== current &&
    !app.pending &&
    t - app.lastSent >= (app.lastOk ? MIN_GAP_MS : RETRY_GAP_MS)
  ) {
    app.lastSent = t;
    const want = app.candidate;
    sendRelay(targetKey(), want, "gesture").then((ok) => {
      app.lastOk = ok;
      if (ok) app.lastTriggered = want;
    });
  }

  // Readout
  if (app.paused) {
    setReadout("Detection paused", "Press P to resume");
  } else if (!app.tracker) {
    setReadout("Hand tracking is off", "Reload the page to try again");
  } else if (!handSeen) {
    setReadout("No hand in view", "Hold your hand up to the camera");
  } else if (app.candidate === null) {
    setReadout("Hand detected", "Open fully, or close into a fist");
  } else {
    const word = app.candidate ? "on" : "off";
    setReadout(
      app.candidate ? "Open hand" : "Fist",
      app.pending
        ? "Sending…"
        : stable
        ? current === app.candidate ? `Already ${word}` : `Turning ${word}`
        : `Hold to turn ${word}`
    );
  }

  const progress = app.candidate === null ? 0 : Math.min(app.frames / STABLE_FRAMES, 1);
  holdBar.style.width = `${progress * 100}%`;
  holdBar.classList.toggle("off", app.candidate === false);
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
function setPaused(paused) {
  app.paused = paused;
  $("#pauseBtn").innerHTML = paused ? "Resume detection <kbd>P</kbd>" : "Pause detection <kbd>P</kbd>";
  if (paused) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    showVeil("Detection paused", "Press P or choose Resume detection.", true);
  } else if (app.tracker) {
    hideVeil();
  }
}

function setSkeleton(on) {
  app.skeleton = on;
  $("#skeletonBtn").innerHTML = on ? "Hide hand outline <kbd>H</kbd>" : "Show hand outline <kbd>H</kbd>";
}

$$(".switch").forEach((b) =>
  b.addEventListener("click", () => {
    const turnOn = b.getAttribute("aria-checked") !== "true";
    sendRelay(b.dataset.relay, turnOn, "switch");
  })
);

$("#pauseBtn").addEventListener("click", () => setPaused(!app.paused));
$("#skeletonBtn").addEventListener("click", () => setSkeleton(!app.skeleton));
$("#refreshBtn").addEventListener("click", refresh);

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || cfg.open) return;
  if (e.target.closest("input, textarea")) return;

  switch (e.key.toLowerCase()) {
    case "o": sendRelay(targetKey(), true, "keyboard"); break;
    case "f": sendRelay(targetKey(), false, "keyboard"); break;
    case "t": refresh(); break;
    case "p": setPaused(!app.paused); break;
    case "h": setSkeleton(!app.skeleton); break;
  }
});

// Controller address dialog
$("#connBtn").addEventListener("click", () => {
  $("#cfgUrl").value = app.server?.baseUrl || "";
  $("#cfgError").textContent = "";
  cfg.showModal();
  $("#cfgUrl").select();
});
$("#cfgCancel").addEventListener("click", () => cfg.close());
$("#cfgForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/config", { url: $("#cfgUrl").value });
    cfg.close();
    log(`${now()}  Controller address updated`, "ok");
  } catch (err) {
    $("#cfgError").textContent = err.message;
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
(async function init() {
  connectEvents();
  requestAnimationFrame(tick);

  if (!(await startCamera())) return;

  showVeil("Loading hand tracking…", "This takes a few seconds the first time.");
  try {
    await startTracker();
    hideVeil();
  } catch (err) {
    console.error(err);
    showVeil(
      "Hand tracking couldn't load",
      "The tracking model loads from the internet. Check your connection and reload. Manual controls still work."
    );
  }
})();
