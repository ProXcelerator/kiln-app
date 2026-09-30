/* ============================================================
   KilnForge — Frontend Application Logic
   ============================================================ */

'use strict';

// ============================================================
// CONFIG
// ============================================================
const WS_URL = `ws://${location.host}`;
const API = {
  schedules:   '/api/schedules',
  records:     '/api/records',
  kilnStatus:  '/api/kiln/status',
  kilnStart:   '/api/kiln/start',
  kilnWarmup:  '/api/kiln/warmup',
  kilnStop:    '/api/kiln/stop',
  settings:    '/api/settings'
};

// ============================================================
// STATE
// ============================================================
let state = {
  ws: null,
  wsReconnectTimer: null,
  live: null,
  schedules: [],
  records: [],
  settings: {},
  editingScheduleId: null,
  tempSteps: [],
  recordsSortCol: 'startTime',
  recordsSortAsc: false,
  chartData: { labels: [], kilnTemps: [], ambientTemps: [] },
  chart: null,
  elapsedTimer: null,
  // Full Firing Overview & Step Journey
  firingChart: null,
  firingStartTime: null,
  firingStartTemp: null,
  prevKilnState: null,
  graphViewMode: 'all',
  focusedStepIndex: null,
  stepSegments: [],
  activeScheduleId: null
};

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
  initTabs();
  initGaugeSvgDefs();
  initChart();
  bindControls();
  bindGraphControls();

  // Await data loading before connecting WebSocket to prevent race conditions 
  // where telemetry arrives before schedules are loaded.
  await Promise.all([
    loadSchedules(),
    loadRecords(),
    loadSettings()
  ]);

  connectWebSocket();
});

// ============================================================
// TABS
// ============================================================
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
    b.setAttribute('aria-selected', b.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('active', p.id === `panel-${tab}`);
  });
  if (tab === 'records') loadRecords();
}

// ============================================================
// WEBSOCKET
// ============================================================
function connectWebSocket() {
  if (state.ws) return;

  state.ws = new WebSocket(WS_URL);

  state.ws.onopen = () => {
    setBadge('connected');
    if (state.wsReconnectTimer) clearTimeout(state.wsReconnectTimer);
  };

  state.ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'telemetry') onTelemetry(msg.data);
      if (msg.type === 'firingComplete') onFiringComplete(msg.data);
      if (msg.type === 'stepChange') onStepChange(msg);
      if (msg.type === 'firingHistory') onFiringHistory(msg.data);
    } catch (e) {
      console.warn('[WS] Parse error', e);
    }
  };

  state.ws.onclose = () => {
    setBadge('disconnected');
    state.ws = null;
    state.wsReconnectTimer = setTimeout(connectWebSocket, 3000);
  };

  state.ws.onerror = () => {
    state.ws.close();
  };
}

function setBadge(status) {
  const badge = document.getElementById('ws-badge');
  const label = badge.querySelector('.badge-label');
  badge.className = `connection-badge ${status}`;
  label.textContent = status === 'connected' ? 'Live' : 'Disconnected';
}

// ============================================================
// TELEMETRY UPDATE
// ============================================================
function onTelemetry(data) {
  state.live = data;
  updateGauge(data.kilnTempF);
  updateKilnStatus(data.kilnStatus);
  updateStats(data);
  pushChartData(data.kilnTempF, data.kilnStatus);
  updateSensorInfo(data);

  // ---- Firing Overview Chart & Step Tracking ----
  const ks = data.kilnStatus;
  const currState = ks ? ks.state : 'IDLE';
  const isFiring = currState === 'FIRING' || currState === 'HOLD';

  if (isFiring) {
    const activeSched = (state.schedules && state.schedules.find(s => s.id === ks.scheduleId))
      || (ks.scheduleSteps && ks.scheduleSteps.length ? { id: ks.scheduleId, name: ks.scheduleName, steps: ks.scheduleSteps } : null);

    if (activeSched) {
      if (!state.firingChart || state.activeScheduleId !== activeSched.id) {
        state.firingStartTime = ks.startTime ? new Date(ks.startTime) : new Date();
        state.activeScheduleId = activeSched.id;
        initFiringChart(activeSched, data.kilnTempF, 0);
      }

      const elapsedMinutes = ks.elapsedSeconds != null
        ? (ks.elapsedSeconds / 60)
        : (state.firingStartTime ? (Date.now() - state.firingStartTime.getTime()) / 60000 : 0);

      pushFiringActualData(elapsedMinutes, data.kilnTempF, ks.stepIndex, ks);
      renderStepJourney(activeSched, ks.stepIndex, ks, data.kilnTempF);

      const subTitle = document.getElementById('graph-main-subtitle');
      if (subTitle) {
        subTitle.textContent = `Active Firing: ${activeSched.name} • Step ${(ks.stepIndex || 0) + 1} of ${activeSched.steps.length}`;
      }
    }
  } else if (currState === 'COMPLETE') {
    if (state.prevKilnState === 'FIRING' || state.prevKilnState === 'HOLD') {
      const activeSched = state.schedules.find(s => s.id === ks.scheduleId);
      if (activeSched) renderStepJourney(activeSched, activeSched.steps.length, ks, data.kilnTempF);
    }
  } else if (currState === 'IDLE') {
    // If firing just ended, reset so next firing re-initializes
    if (state.prevKilnState === 'FIRING' || state.prevKilnState === 'HOLD') {
      state.firingStartTime = null;
      state.firingXOffset = 0;
      state.activeScheduleId = null;
      const sched = (currentStudioSelection && state.schedules.find(s => s.id === currentStudioSelection.scheduleId)) || state.schedules[0];
      if (sched) previewScheduleOnGraph(sched);
    }
  }

  state.prevKilnState = currState;
}

function onFiringComplete(record) {
  toast(`🎉 Firing complete! ${record.scheduleName} — ${formatDuration(getDurationSec(record.startTime, record.endTime))}`, 'success', 6000);
  loadRecords();
}

function onStepChange({ stepIndex, step }) {
  toast(`Step ${stepIndex + 1}: ${step.label || (step.type === 'ramp' ? `Ramp to ${step.targetTempF}°F` : `Hold ${step.durationMinutes}min`)}`, 'warning', 4000);
}

// Called when the server replays the full firing history after a reconnect.
// Restores both the rolling live chart and the full firing overview chart.
function onFiringHistory(history) {
  if (!history || !history.length) return;
  console.log(`[History] Replaying ${history.length} readings...`);

  const firingStart = new Date(history[0].timestamp);
  state.firingStartTime = firingStart;

  // Clear existing chart data before replaying
  const d = state.chart.data;
  d.labels = [];
  d.datasets.forEach(ds => ds.data = []);

  // Figure out how many of the most recent readings fit in the rolling window
  const recentHistory = history.slice(-MAX_CHART_POINTS);

  recentHistory.forEach(entry => {
    const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    d.labels.push(time);
    d.datasets[0].data.push(entry.kilnTempF != null ? Math.round(entry.kilnTempF) : null);
    d.datasets[1].data.push(null); // goal line resets — live ticks will fill it back in
  });
  state.chart.update('none');

  // Replay into the full firing overview chart if it's initialized
  if (state.firingChart) {
    state.firingChart.data.datasets[0].data = history.map(entry => ({
      x: Math.round(((entry.timestamp - firingStart.getTime()) / 60000) * 10) / 10,
      y: Math.round(entry.kilnTempF)
    }));
    state.firingChart.update('none');
  }
}

// ============================================================
// GAUGE
// ============================================================
const GAUGE_MAX_TEMP = 2500;
const GAUGE_CX = 120, GAUGE_CY = 170, GAUGE_R = 90;
const GAUGE_START_ANGLE = 220; // degrees from right (clockwise)
const GAUGE_SWEEP = 280;       // degrees the arc spans

function initGaugeSvgDefs() {
  const svg = document.getElementById('gauge-svg');
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `
    <linearGradient id="gaugeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%"   stop-color="#4fc3f7"/>
      <stop offset="30%"  stop-color="#ffb347"/>
      <stop offset="70%"  stop-color="#ff6b35"/>
      <stop offset="100%" stop-color="#ff0000"/>
    </linearGradient>
  `;
  svg.insertBefore(defs, svg.firstChild);
}

function polarToCart(cx, cy, r, angleDeg) {
  const rad = (angleDeg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function updateGauge(tempF) {
  const el = document.getElementById('gauge-temp-text');
  const arc = document.getElementById('gauge-arc');
  if (!el || !arc) return;

  el.textContent = tempF != null ? `${Math.round(tempF)}°F` : '—';

  const fraction = Math.min(1, Math.max(0, (tempF || 0) / GAUGE_MAX_TEMP));
  const startDeg = GAUGE_START_ANGLE;
  const endDeg = GAUGE_START_ANGLE + fraction * GAUGE_SWEEP;

  const start = polarToCart(GAUGE_CX, GAUGE_CY, GAUGE_R, startDeg);
  const end = polarToCart(GAUGE_CX, GAUGE_CY, GAUGE_R, endDeg);
  const largeArc = (fraction * GAUGE_SWEEP) > 180 ? 1 : 0;

  if (fraction < 0.001) {
    arc.setAttribute('d', `M ${start.x} ${start.y} A ${GAUGE_R} ${GAUGE_R} 0 0 1 ${start.x} ${start.y}`);
  } else {
    arc.setAttribute('d', `M ${start.x} ${start.y} A ${GAUGE_R} ${GAUGE_R} 0 ${largeArc} 1 ${end.x} ${end.y}`);
  }

  // Also update track path
  const trackEl = document.querySelector('.gauge-track');
  if (trackEl) {
    const trackEnd = polarToCart(GAUGE_CX, GAUGE_CY, GAUGE_R, GAUGE_START_ANGLE + GAUGE_SWEEP);
    trackEl.setAttribute('d', `M ${start.x} ${start.y} A ${GAUGE_R} ${GAUGE_R} 0 1 1 ${trackEnd.x} ${trackEnd.y}`);
  }
}

// ============================================================
// KILN STATUS
// ============================================================
function updateKilnStatus(status) {
  if (!status) return;

  const hero = document.getElementById('kiln-hero');
  const badge = document.getElementById('kiln-state-badge');
  const label = document.getElementById('kiln-state-label');
  const activeName = document.getElementById('active-schedule-name');
  const activeStep = document.getElementById('active-step-label');
  const activeProgress = document.getElementById('active-step-progress');
  const projEnd = document.getElementById('projected-end');
  const btnStart = document.getElementById('btn-start-fire');
  const btnWarmup = document.getElementById('btn-warmup-fire');
  const btnStop = document.getElementById('btn-stop-fire');
  const schedSel = document.getElementById('start-schedule-select');
  const stepContainer = document.getElementById('step-progress-container');

  const s = status.state;

  // Hero glow
  hero.classList.toggle('firing', s === 'FIRING' || s === 'HOLD');

  // Badge
  badge.className = `kiln-state-badge state-${s}`;
  label.textContent = s;

  // Schedule / step info
  let ddlName = '';
  const ddl = document.getElementById('preset-select');
  if (ddl && ddl.selectedIndex > 0) ddlName = ddl.options[ddl.selectedIndex].text;
  activeName.textContent = status.scheduleName || (status.state === 'IDLE' && ddlName ? ddlName : '—');

  if (status.currentStep) {
    const step = status.currentStep;
    if (step.type === 'ramp') {
      activeStep.textContent = step.label || `Ramp → ${step.targetTempF}°F`;
    } else {
      activeStep.textContent = step.label || `Hold @ ${step.tempF}°F for ${step.durationMinutes}min`;
    }
  } else {
    activeStep.textContent = s === 'COMPLETE' ? 'Complete' : '—';
  }

  // Step progress %
  if (status.currentStep && status.state === 'HOLD' && status.stepIndex != null) {
    activeProgress.textContent = '—';
  } else {
    activeProgress.textContent = (s === 'FIRING' || s === 'HOLD')
      ? `Step ${status.stepIndex + 1} of ${status.totalSteps}`
      : '—';
  }

  // Projected end
  if (status.projectedEndTime) {
    const d = new Date(status.projectedEndTime);
    projEnd.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else {
    projEnd.textContent = '—';
  }

  // Control Engine Mode Display
  const currentEngineMode = status.controllerMode || state.live?.controllerMode || state.settings?.controllerMode || 'standard';
  const modeBadge = document.getElementById('active-control-mode');
  if (modeBadge) {
    const isStd = currentEngineMode === 'standard';
    modeBadge.textContent = isStd ? 'Classic' : 'Adaptive (ML)';
    modeBadge.style.color = isStd ? 'var(--success, #4ade80)' : 'var(--ember, #ff6b35)';
  }

  // Controls
  const isFiring = s === 'FIRING' || s === 'HOLD';
  btnStart.classList.toggle('hidden', isFiring);
  if (btnWarmup) btnWarmup.classList.toggle('hidden', isFiring);
  btnStop.classList.toggle('hidden', !isFiring);
  schedSel.disabled = isFiring;

  // Studio Controls Sync
  const btnStudioIgnite = document.getElementById('btn-studio-ignite');
  const btnStudioStop = document.getElementById('btn-studio-stop');
  if (btnStudioIgnite) btnStudioIgnite.classList.toggle('hidden', isFiring);
  if (btnStudioStop) btnStudioStop.classList.toggle('hidden', !isFiring);

  const cardGrid = document.getElementById('quick-cards-grid');
  if (cardGrid) {
    cardGrid.querySelectorAll('.quick-card').forEach(card => {
      card.classList.toggle('disabled', isFiring);
    });
  }

  const studioSel = document.getElementById('studio-dropdown-select');
  const studioStepSel = document.getElementById('studio-step-select');
  if (studioSel) studioSel.disabled = isFiring;
  if (studioStepSel) studioStepSel.disabled = isFiring;

  if (isFiring) {
    const selName = document.getElementById('studio-sel-name');
    const selDet = document.getElementById('studio-sel-details');
    const subLabel = document.getElementById('quick-selected-label');
    if (selName) selName.textContent = status.scheduleName || 'Active Firing';
    if (selDet) {
      if (status.currentStep) {
        selDet.textContent = status.currentStep.label
          ? `${status.currentStep.label} (${status.state})`
          : `Step ${(status.stepIndex || 0) + 1} of ${status.totalSteps || 1} (${status.state})`;
      } else {
        selDet.textContent = `Firing state: ${status.state}`;
      }
    }
    if (subLabel) subLabel.textContent = `Kiln is actively firing (${status.state})`;
  } else {
    const subLabel = document.getElementById('quick-selected-label');
    if (subLabel) subLabel.textContent = 'Select a cycle below to prime';
  }

  // Elapsed timer
  if (isFiring && status.startTime) {
    if (!state.elapsedTimer) {
      state.elapsedTimer = setInterval(() => updateElapsed(status.startTime), 1000);
    }
    updateElapsed(status.startTime);
  } else {
    if (state.elapsedTimer) { clearInterval(state.elapsedTimer); state.elapsedTimer = null; }
    const elEl = document.getElementById('elapsed-time');
    if (s === 'COMPLETE' && status.startTime && status.endTime) {
      const sec = getDurationSec(status.startTime, status.endTime);
      elEl.textContent = formatDuration(sec);
    } else {
      elEl.textContent = '—';
    }
  }

  // Step progress
  const activeSched = (state.schedules && state.schedules.find(sch => sch.id === status.scheduleId))
    || (status.scheduleSteps && status.scheduleSteps.length ? { id: status.scheduleId, name: status.scheduleName, steps: status.scheduleSteps } : null)
    || (currentStudioSelection && state.schedules.find(sch => sch.id === currentStudioSelection.scheduleId))
    || (state.schedules && state.schedules[0]);

  if (activeSched && stepContainer) {
    stepContainer.style.display = '';
    renderStepJourney(activeSched, status.stepIndex, status, state.live?.kilnTempF);
  }
}

function updateElapsed(startTime) {
  const el = document.getElementById('elapsed-time');
  if (!el || !startTime) return;
  const sec = Math.floor((Date.now() - new Date(startTime).getTime()) / 1000);
  el.textContent = formatDuration(sec);
}

function renderStepTrack(status) {
  const sched = (state.schedules && state.schedules.find(s => s.id === status.scheduleId))
    || (status.scheduleSteps && status.scheduleSteps.length ? { id: status.scheduleId, name: status.scheduleName, steps: status.scheduleSteps } : null)
    || (currentStudioSelection && state.schedules.find(s => s.id === currentStudioSelection.scheduleId))
    || (state.schedules && state.schedules[0]);
  if (sched) {
    renderStepJourney(sched, status.stepIndex, status, state.live?.kilnTempF);
  }
}

// ============================================================
// STATS CARDS
// ============================================================
function updateStats(data) {
  // Ambient temp
  const ambEl = document.getElementById('stat-ambient');
  ambEl.textContent = data.ambientTempF != null ? `${Math.round(data.ambientTempF)}°F` : '—';

  // Humidity
  const humEl = document.getElementById('stat-humidity');
  humEl.textContent = data.humidity != null ? `${data.humidity}%` : '—';

  // Watts
  const wattsEl = document.getElementById('stat-watts');
  const wattsSrc = document.getElementById('stat-watts-source');
  if (data.watts != null) {
    wattsEl.textContent = `${data.watts.toLocaleString()}W`;
  } else {
    wattsEl.textContent = '—';
  }
  wattsSrc.textContent = data.emporiaConnected ? 'Via Emporia Vue' : 'Schedule estimate';

  // Cost
  const costEl = document.getElementById('stat-cost');
  costEl.textContent = data.kilnStatus && data.kilnStatus.totalCost != null 
    ? `$${data.kilnStatus.totalCost.toFixed(2)}`
    : '—';

  // Virtual Cone
  const coneNameEl = document.getElementById('stat-virtual-cone-name');
  const coneScoreEl = document.getElementById('stat-virtual-cone-score');
  if (data.kilnStatus && data.kilnStatus.virtualCone) {
    coneNameEl.textContent = data.kilnStatus.virtualCone.cone;
    coneScoreEl.textContent = `Heat Work Score: ${data.kilnStatus.virtualCone.score}`;
  } else {
    coneNameEl.textContent = '—';
    coneScoreEl.textContent = 'Heat Work Score: 0';
  }
  const kwhEl = document.getElementById('stat-kwh');
  costEl.textContent = `$${(data.estimatedCost || 0).toFixed(2)}`;
  kwhEl.textContent = `${(data.estimatedKWhUsed || 0).toFixed(3)} kWh used`;
}

function updateSensorInfo(data) {
  const modeEl = document.getElementById('info-sensor-mode');
  const empEl = document.getElementById('info-emporia-connected');
  if (modeEl) modeEl.textContent = data.sensorMode === 'hardware' ? 'MAX31855 (Hardware)' : 'Simulation';
  if (empEl) empEl.textContent = data.emporiaConnected ? 'Yes' : 'No';
}

// ============================================================
// LIVE CHART
// ============================================================
const MAX_CHART_POINTS = 120; // 4 minutes of 2s data

function initChart() {
  const ctx = document.getElementById('temp-chart').getContext('2d');

  state.chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Kiln Temp (°F)',
          data: [],
          borderColor: '#ff6b35',
          backgroundColor: 'rgba(255,107,53,0.08)',
          borderWidth: 2.5,
          pointRadius: 0,
          pointHoverRadius: 5,
          fill: true,
          tension: 0.4,
          yAxisID: 'y'
        },
        {
          label: 'Goal Temp (°F)',
          data: [],
          borderColor: 'rgba(100,200,255,0.7)',
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          pointRadius: 0,
          pointHoverRadius: 4,
          fill: false,
          tension: 0.1,
          borderDash: [6, 4],
          yAxisID: 'y'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(26,26,36,0.95)',
          borderColor: 'rgba(255,107,53,0.3)',
          borderWidth: 1,
          titleColor: '#9898b8',
          bodyColor: '#f0f0f8',
          callbacks: {
            label: ctx => `${ctx.dataset.label}: ${Math.round(ctx.parsed.y)}°F`
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#5a5a78', font: { size: 10 }, maxTicksLimit: 8 }
        },
        y: {
          position: 'left',
          grid: { color: 'rgba(255,255,255,0.05)' },
          suggestedMin: 0,
          ticks: { color: '#ff9060', font: { size: 10 }, precision: 0, callback: v => `${v}°F` },
          title: { display: true, text: 'Kiln °F', color: '#ff6b35', font: { size: 10 } }
        }
      }
    }
  });
}

function pushChartData(kilnTemp, kilnStatus) {
  const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const d = state.chart.data;

  d.labels.push(now);
  d.datasets[0].data.push(kilnTemp != null ? Math.round(kilnTemp) : null);

  // Calculate the current goal temp from the active ramp step
  let goalTemp = null;
  if (kilnStatus && (kilnStatus.state === 'FIRING' || kilnStatus.state === 'HOLD')) {
    const step = kilnStatus.currentStep;
    if (step && step.type === 'ramp') {
      // We don't have stepStartTime here, so just use the target as a flat reference line
      goalTemp = Math.round(step.targetTempF);
    } else if (step && step.type === 'hold') {
      goalTemp = Math.round(step.tempF);
    }
  }
  d.datasets[1].data.push(goalTemp);

  if (d.labels.length > MAX_CHART_POINTS) {
    d.labels.shift();
    d.datasets.forEach(ds => ds.data.shift());
  }

  state.chart.update('none');
}

// ============================================================
// FULL FIRING OVERVIEW CHART
// ============================================================

// ============================================================
// MASTER FIRING & STEP GRAPH SYSTEM
// ============================================================

function drawRoundRect(ctx, x, y, width, height, radius) {
  if (width < 2 * radius) radius = width / 2;
  if (height < 2 * radius) radius = height / 2;
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y + width, x, y, radius);
  ctx.closePath();
}

function formatDurationMinutes(min) {
  if (min == null || isNaN(min)) return '—';
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (h > 0) return `${h}h ${remM}m`;
  return `${remM}m`;
}

// Compute metadata and timeline span for each step in the schedule
function computeStepSegments(schedule, startTempF = 72) {
  if (!schedule || !schedule.steps || !schedule.steps.length) return [];
  const segments = [];
  let currentTemp = startTempF;
  let currentMinutes = 0;

  schedule.steps.forEach((step, index) => {
    let durationMinutes = 0;
    let targetTemp = currentTemp;

    if (step.type === 'ramp') {
      targetTemp = step.targetTempF != null ? step.targetTempF : currentTemp;
      const rate = step.ratePerHour || 100;
      const delta = Math.abs(targetTemp - currentTemp);
      durationMinutes = (delta / rate) * 60;
    } else if (step.type === 'hold') {
      targetTemp = step.tempF != null ? step.tempF : currentTemp;
      durationMinutes = step.durationMinutes || 0;
    }

    const startMinutes = currentMinutes;
    const endMinutes = currentMinutes + durationMinutes;

    segments.push({
      index,
      stepNumber: index + 1,
      type: step.type,
      label: step.label || (step.type === 'ramp' ? `Ramp to ${targetTemp}°F` : `Hold at ${targetTemp}°F`),
      startTempF: Math.round(currentTemp),
      targetTempF: Math.round(targetTemp),
      ratePerHour: step.ratePerHour || null,
      durationMinutes: Math.round(durationMinutes * 10) / 10,
      startMinutes: Math.round(startMinutes * 10) / 10,
      endMinutes: Math.round(endMinutes * 10) / 10
    });

    currentMinutes = endMinutes;
    currentTemp = targetTemp;
  });

  return segments;
}

// Compute the ideal planned schedule curve coordinates
function computeScheduleCurve(schedule, startTempF = 72, startStepIndex = 0) {
  const segments = computeStepSegments(schedule, startTempF);
  const points = [];
  
  if (!segments.length) {
    return [{ x: 0, y: Math.round(startTempF) }];
  }

  // Initial starting point
  points.push({ x: 0, y: Math.round(startTempF) });

  for (let i = startStepIndex; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.type === 'ramp') {
      points.push({ x: seg.endMinutes, y: seg.targetTempF, stepIndex: seg.index, label: seg.label });
    } else if (seg.type === 'hold') {
      points.push({ x: seg.startMinutes, y: seg.targetTempF, stepIndex: seg.index, label: seg.label });
      points.push({ x: seg.endMinutes, y: seg.targetTempF, stepIndex: seg.index, label: seg.label });
    }
  }

  return points;
}

function calculateStepProgressFallback(step, status, currentTemp) {
  if (!step) return 0;
  if (step.type === 'ramp') {
    const from = (status && status.stepStartTemp != null) ? status.stepStartTemp : 72;
    const to = step.targetTempF || from;
    const delta = Math.abs(to - from);
    if (delta <= 0) return 100;
    const progress = Math.abs((currentTemp || from) - from);
    return Math.min(100, Math.max(0, Math.round((progress / delta) * 100)));
  } else if (step.type === 'hold') {
    const totalSec = (step.durationMinutes || 1) * 60;
    const elapsedSec = Math.floor((status?.trueHoldTimeMs || 0) / 1000);
    return Math.min(100, Math.max(0, Math.round((elapsedSec / totalSec) * 100)));
  }
  return 0;
}

// Custom Chart.js plugin to draw step visual zones, dividers, badges, and the live NOW cursor
const stepProgressChartPlugin = {
  id: 'stepProgressChartPlugin',
  beforeDraw(chart) {
    const { ctx, chartArea, scales } = chart;
    if (!chartArea || !scales.x || !scales.y || !chart.stepSegments) return;
    const { left, right, top, bottom, height } = chartArea;
    const xScale = scales.x;
    const segments = chart.stepSegments;
    const activeIdx = chart.activeStepIndex != null ? chart.activeStepIndex : -1;
    const isFiring = chart.isFiringActive;

    ctx.save();
    segments.forEach((seg, i) => {
      const xStart = Math.max(left, Math.min(right, xScale.getPixelForValue(seg.startMinutes)));
      const xEnd = Math.max(left, Math.min(right, xScale.getPixelForValue(seg.endMinutes)));
      const segWidth = xEnd - xStart;
      if (segWidth <= 0) return;

      // 1. Shading background
      if (isFiring && i === activeIdx) {
        // Active step glowing vertical amber column
        const grad = ctx.createLinearGradient(0, top, 0, bottom);
        grad.addColorStop(0, 'rgba(255, 107, 53, 0.18)');
        grad.addColorStop(0.4, 'rgba(255, 107, 53, 0.08)');
        grad.addColorStop(1, 'rgba(255, 107, 53, 0.02)');
        ctx.fillStyle = grad;
        ctx.fillRect(xStart, top, segWidth, height);

        // Highlight border
        ctx.strokeStyle = 'rgba(255, 107, 53, 0.35)';
        ctx.lineWidth = 1;
        ctx.strokeRect(xStart, top, segWidth, height);
      } else if (isFiring && i < activeIdx) {
        // Completed step
        ctx.fillStyle = 'rgba(76, 175, 80, 0.04)';
        ctx.fillRect(xStart, top, segWidth, height);
      } else if (i % 2 === 1) {
        // Subtle alternating band
        ctx.fillStyle = 'rgba(255, 255, 255, 0.015)';
        ctx.fillRect(xStart, top, segWidth, height);
      }

      // 2. Vertical Divider line
      if (i > 0 && xStart >= left && xStart <= right) {
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = (isFiring && (i === activeIdx || i === activeIdx + 1))
          ? 'rgba(255, 107, 53, 0.5)'
          : 'rgba(255, 255, 255, 0.12)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(xStart, top);
        ctx.lineTo(xStart, bottom);
        ctx.stroke();
      }
    });
    ctx.restore();
  },

  afterDraw(chart) {
    const { ctx, chartArea, scales } = chart;
    if (!chartArea || !scales.x || !scales.y || !chart.stepSegments) return;
    const { left, right, top, bottom } = chartArea;
    const xScale = scales.x;
    const segments = chart.stepSegments;
    const activeIdx = chart.activeStepIndex != null ? chart.activeStepIndex : -1;
    const isFiring = chart.isFiringActive;
    const elapsedMins = chart.currentElapsedMinutes;

    ctx.save();

    // 1. Draw Step Header Badges along the top of each step column
    segments.forEach((seg, i) => {
      const xStart = xScale.getPixelForValue(seg.startMinutes);
      const xEnd = xScale.getPixelForValue(seg.endMinutes);
      const colWidth = xEnd - xStart;
      if (colWidth < 28 || xStart > right || xEnd < left) return;

      const badgeX = Math.max(left + 8, Math.min(right - 70, (xStart + xEnd) / 2));
      const isActive = isFiring && i === activeIdx;
      const isDone = isFiring && i < activeIdx;

      const badgeText = colWidth > 85
        ? `Step ${seg.stepNumber}: ${seg.type === 'ramp' ? seg.targetTempF + '°' : seg.durationMinutes + 'm'}`
        : `S${seg.stepNumber}`;

      ctx.font = '600 10px Outfit, sans-serif';
      const textWidth = ctx.measureText(badgeText).width;
      const padX = 7;
      const pillW = textWidth + padX * 2 + (isActive ? 10 : 0);
      const pillH = 18;
      const pillX = Math.max(left + 4, Math.min(right - pillW - 4, badgeX - pillW / 2));
      const pillY = top + 6;

      drawRoundRect(ctx, pillX, pillY, pillW, pillH, 9);
      if (isActive) {
        ctx.fillStyle = 'rgba(255, 107, 53, 0.9)';
        ctx.shadowColor = 'rgba(255, 107, 53, 0.6)';
        ctx.shadowBlur = 8;
        ctx.fill();
        ctx.shadowBlur = 0;

        // Pulsing white dot
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(pillX + 8, pillY + 9, 2.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillText(badgeText, pillX + 15, pillY + 12.5);
      } else if (isDone) {
        ctx.fillStyle = 'rgba(76, 175, 80, 0.15)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(76, 175, 80, 0.4)';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = '#81c784';
        ctx.fillText(badgeText, pillX + padX, pillY + 12.5);
      } else {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = '#9898b8';
        ctx.fillText(badgeText, pillX + padX, pillY + 12.5);
      }
    });

    // 2. Draw "NOW" Live Firing Cursor Line
    if (isFiring && elapsedMins != null && elapsedMins >= 0) {
      const xNow = xScale.getPixelForValue(elapsedMins);
      if (xNow >= left && xNow <= right) {
        // Glowing vertical line
        ctx.shadowColor = '#ff6b35';
        ctx.shadowBlur = 10;
        ctx.strokeStyle = '#ff6b35';
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(xNow, top);
        ctx.lineTo(xNow, bottom);
        ctx.stroke();

        // Bead on current actual temperature
        const tempF = chart.currentKilnTempF;
        if (tempF != null) {
          const yNow = scales.y.getPixelForValue(tempF);
          if (yNow >= top && yNow <= bottom) {
            ctx.fillStyle = 'rgba(255, 107, 53, 0.4)';
            ctx.beginPath();
            ctx.arc(xNow, yNow, 9, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(xNow, yNow, 3.5, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        // Top Flag
        const flagText = tempF != null ? `NOW • ${Math.round(tempF)}°F` : 'NOW';
        ctx.font = '700 9px "JetBrains Mono", monospace';
        const flagW = ctx.measureText(flagText).width + 10;
        const flagH = 16;
        const flagX = Math.max(left, Math.min(right - flagW, xNow - flagW / 2));
        const flagY = top + 28;

        drawRoundRect(ctx, flagX, flagY, flagW, flagH, 4);
        ctx.fillStyle = '#ff6b35';
        ctx.shadowColor = 'rgba(255, 107, 53, 0.7)';
        ctx.shadowBlur = 6;
        ctx.fill();

        ctx.shadowBlur = 0;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(flagText, flagX + 5, flagY + 11.5);
      }
    }

    ctx.restore();
  }
};

function initFiringChart(schedule, startTempF = 72, startStepIndex = 0) {
  const canvas = document.getElementById('firing-overview-chart');
  const placeholder = document.getElementById('firing-overview-placeholder');
  if (!canvas || !schedule) return;

  if (state.firingChart) {
    state.firingChart.destroy();
    state.firingChart = null;
  }

  canvas.style.display = 'block';
  if (placeholder) placeholder.style.display = 'none';

  state.stepSegments = computeStepSegments(schedule, startTempF);
  const plannedCurve = computeScheduleCurve(schedule, startTempF, startStepIndex);
  const totalMinutes = state.stepSegments.length
    ? state.stepSegments[state.stepSegments.length - 1].endMinutes
    : (plannedCurve[plannedCurve.length - 1]?.x || 60);

  const ctx = canvas.getContext('2d');
  state.firingChart = new Chart(ctx, {
    type: 'scatter',
    data: {
      datasets: [
        {
          label: 'Actual Temp (°F)',
          data: [],
          borderColor: '#ff6b35',
          backgroundColor: 'rgba(255,107,53,0.18)',
          borderWidth: 2.5,
          pointRadius: 0,
          showLine: true,
          fill: true,
          tension: 0.25,
          yAxisID: 'y',
          order: 1
        },
        {
          label: 'Planned Schedule (°F)',
          data: plannedCurve,
          borderColor: 'rgba(100,200,255,0.85)',
          backgroundColor: 'transparent',
          borderWidth: 1.8,
          pointRadius: 0,
          showLine: true,
          fill: false,
          tension: 0.05,
          borderDash: [6, 4],
          order: 2,
          yAxisID: 'y'
        },
        {
          label: 'Ramp Rate (°F/hr)',
          data: [],
          borderColor: '#4fc3f7',
          backgroundColor: '#4fc3f7',
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 6,
          showLine: true,
          borderDash: [4, 4],
          tension: 0.3,
          order: 3,
          yAxisID: 'y1'
        }
      ]
    },
    plugins: [stepProgressChartPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 0 },
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(20,20,30,0.95)',
          borderColor: 'rgba(255,107,53,0.35)',
          borderWidth: 1,
          titleColor: '#9898b8',
          bodyColor: '#f0f0f8',
          padding: 10,
          callbacks: {
            title: items => {
              const mins = items[0]?.parsed?.x;
              if (mins == null) return '';
              const h = Math.floor(mins / 60);
              const m = Math.round(mins % 60);
              return `${h > 0 ? h + 'h ' : ''}${m}m elapsed`;
            },
            beforeBody: items => {
              const mins = items[0]?.parsed?.x;
              if (mins == null || !state.stepSegments) return '';
              const seg = state.stepSegments.find(s => mins >= s.startMinutes && mins <= s.endMinutes)
                || state.stepSegments[state.stepSegments.length - 1];
              if (!seg) return '';
              return `Step ${seg.stepNumber}: ${seg.label} (${seg.type === 'ramp' ? seg.targetTempF + '°F' : seg.durationMinutes + 'm'})`;
            },
            label: ctx => {
              if (ctx.dataset.label.includes('Ramp')) {
                const pt = ctx.raw;
                const range = (pt.fromTemp != null && pt.toTemp != null)
                  ? ` (${Math.round(pt.fromTemp)}°F → ${Math.round(pt.toTemp)}°F)`
                  : '';
                return `Rate: ${Math.round(ctx.parsed.y)}°F/hr${range}`;
              }
              return `${ctx.dataset.label}: ${Math.round(ctx.parsed.y)}°F`;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          min: 0,
          max: totalMinutes,
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: {
            color: '#8888aa',
            font: { size: 10, family: 'JetBrains Mono' },
            maxTicksLimit: 10,
            callback: v => {
              const h = Math.floor(v / 60);
              const m = Math.round(v % 60);
              return h > 0 ? `${h}h${String(m).padStart(2,'0')}m` : `${m}m`;
            }
          },
          title: { display: true, text: 'Firing Timeline (Elapsed Minutes)', color: '#686888', font: { size: 10 } }
        },
        y: {
          type: 'linear', position: 'left',
          grid: { color: 'rgba(255,255,255,0.05)' },
          suggestedMin: 0,
          ticks: { color: '#ff9060', font: { size: 10 }, precision: 0, callback: v => `${v}°F` }
        },
        y1: {
          type: 'linear', position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { color: '#4fc3f7', font: { size: 10 }, callback: v => `${Math.round(v)}/hr` }
        }
      }
    }
  });

  state.firingChart.totalPlannedMinutes = totalMinutes;
  state.firingChart.stepSegments = state.stepSegments;
  state.firingChart.activeStepIndex = 0;
  state.firingChart.isFiringActive = false;
  state.firingChart.currentElapsedMinutes = 0;
}

function pushFiringActualData(elapsedMinutes, kilnTempF, activeStepIndex, kilnStatus) {
  if (!state.firingChart || kilnTempF == null) return;
  
  const currentX = Math.round(elapsedMinutes * 10) / 10;
  state.firingChart.currentElapsedMinutes = currentX;
  state.firingChart.currentKilnTempF = kilnTempF;
  state.firingChart.activeStepIndex = activeStepIndex != null ? activeStepIndex : 0;
  state.firingChart.isFiringActive = true;

  const actualDs = state.firingChart.data.datasets.find(d => d.label.includes('Actual Temp'));
  const rateDs = state.firingChart.data.datasets.find(d => d.label.includes('Ramp Rate'));

  if (actualDs) {
    const lastPt = actualDs.data[actualDs.data.length - 1];
    if (!lastPt || Math.abs(lastPt.x - currentX) >= 0.05) {
      actualDs.data.push({ x: currentX, y: Math.round(kilnTempF) });
    } else {
      lastPt.y = Math.round(kilnTempF);
    }

    // Auto-expand X-axis if actual firing runs longer than planned
    if (currentX > state.firingChart.options.scales.x.max && state.graphViewMode === 'all') {
      state.firingChart.options.scales.x.max = Math.ceil((currentX + 30) / 30) * 30;
    }

    // Compute live ramp rate every 30 mins
    if (rateDs && actualDs.data.length > 0) {
      const thirtyMinMark = Math.floor(currentX / 30) * 30;
      if (thirtyMinMark > 0 && !rateDs.data.some(d => d.x === thirtyMinMark)) {
        const current = actualDs.data.reduce((p, c) => Math.abs(c.x - thirtyMinMark) < Math.abs(p.x - thirtyMinMark) ? c : p);
        const past = actualDs.data.reduce((p, c) => Math.abs(c.x - (thirtyMinMark - 30)) < Math.abs(p.x - (thirtyMinMark - 30)) ? c : p);
        const deltaHr = (current.x - past.x) / 60;
        if (deltaHr > 0.1) {
          const rate = Math.round((current.y - past.y) / deltaHr);
          rateDs.data.push({ x: thirtyMinMark, y: rate, fromTemp: past.y, toTemp: current.y });
        }
      }
    }
  }

  state.firingChart.update('none');
}

function setGraphView(viewMode, targetStepIndex = null) {
  state.graphViewMode = viewMode;
  state.focusedStepIndex = targetStepIndex;

  const btnAll = document.getElementById('btn-view-all');
  const btnStep = document.getElementById('btn-view-step');
  const btnLive = document.getElementById('btn-view-live');
  const overviewCanvas = document.getElementById('firing-overview-chart');
  const tempCanvas = document.getElementById('temp-chart');

  [btnAll, btnStep, btnLive].forEach(b => b && b.classList.remove('active'));

  if (viewMode === 'live') {
    if (btnLive) btnLive.classList.add('active');
    if (overviewCanvas) overviewCanvas.style.display = 'none';
    if (tempCanvas) tempCanvas.style.display = 'block';
    if (state.chart) state.chart.resize();
    return;
  }

  if (overviewCanvas) overviewCanvas.style.display = 'block';
  if (tempCanvas) tempCanvas.style.display = 'none';

  if (!state.firingChart) return;

  const totalMin = state.firingChart.totalPlannedMinutes || 60;

  if (viewMode === 'all') {
    if (btnAll) btnAll.classList.add('active');
    state.firingChart.options.scales.x.min = 0;
    state.firingChart.options.scales.x.max = Math.max(totalMin, (state.firingChart.currentElapsedMinutes || 0) + 10);
    delete state.firingChart.options.scales.y.min;
    delete state.firingChart.options.scales.y.max;
    state.firingChart.options.scales.y.suggestedMin = 0;
  } else if (viewMode === 'step') {
    if (btnStep) btnStep.classList.add('active');
    const stepIdx = targetStepIndex != null
      ? targetStepIndex
      : (state.live?.kilnStatus?.stepIndex || 0);

    const seg = state.stepSegments && state.stepSegments[stepIdx];
    if (seg) {
      state.firingChart.options.scales.x.min = Math.max(0, seg.startMinutes - 1);
      state.firingChart.options.scales.x.max = seg.endMinutes + 1;
      const minTemp = Math.min(seg.startTempF, seg.targetTempF);
      const maxTemp = Math.max(seg.startTempF, seg.targetTempF);
      const pad = Math.max(30, (maxTemp - minTemp) * 0.15);
      state.firingChart.options.scales.y.min = Math.max(0, Math.floor((minTemp - pad) / 50) * 50);
      state.firingChart.options.scales.y.max = Math.ceil((maxTemp + pad) / 50) * 50;
    }
  }

  state.firingChart.resize();
  state.firingChart.update();
}

function previewScheduleOnGraph(schedule) {
  if (!schedule || !schedule.steps || !schedule.steps.length) return;
  const tempF = (state.live && state.live.kilnTempF) || 72;
  initFiringChart(schedule, tempF, 0);
  renderStepJourney(schedule, 0, null, tempF);
  const subTitle = document.getElementById('graph-main-subtitle');
  if (subTitle) {
    subTitle.textContent = `Schedule Preview: ${schedule.name} • ${schedule.steps.length} Steps • ${calcScheduleDuration(schedule)}`;
  }
}

function renderStepJourney(schedule, activeStepIndex, kilnStatus, kilnTempF) {
  const container = document.getElementById('step-progress-container');
  const track = document.getElementById('step-track');
  const count = document.getElementById('step-progress-count');
  const banner = document.getElementById('active-step-banner');
  if (!track || !schedule || !schedule.steps) return;

  const total = schedule.steps.length;
  const isFiring = kilnStatus && (kilnStatus.state === 'FIRING' || kilnStatus.state === 'HOLD');
  const isComplete = kilnStatus && kilnStatus.state === 'COMPLETE';
  const currentIdx = activeStepIndex != null ? activeStepIndex : (isComplete ? total : 0);

  // 1. Update Header
  if (count) {
    if (isFiring) {
      count.textContent = `Step ${currentIdx + 1} of ${total} active`;
    } else if (isComplete) {
      count.textContent = `All ${total} steps complete`;
    } else {
      count.textContent = `${total} steps planned (${calcScheduleDuration(schedule)})`;
    }
  }

  // 2. Active Step Hero Banner
  if (banner) {
    if (isFiring && schedule.steps[currentIdx]) {
      banner.style.display = 'grid';
      const step = schedule.steps[currentIdx];
      const pill = document.getElementById('active-step-pill');
      const typePill = document.getElementById('active-step-type');
      const statusChip = document.getElementById('active-step-status');
      const nameEl = document.getElementById('active-step-name');
      const detailsEl = document.getElementById('active-step-details');
      const pctEl = document.getElementById('active-step-pct');
      const barFill = document.getElementById('active-step-bar-fill');
      const subtextEl = document.getElementById('active-step-subtext');
      const elapsedEl = document.getElementById('active-step-elapsed');
      const remEl = document.getElementById('active-step-remaining');
      const totalProgEl = document.getElementById('active-total-progress');

      if (pill) pill.textContent = `STEP ${currentIdx + 1} OF ${total}`;
      if (typePill) typePill.textContent = step.type.toUpperCase();
      if (statusChip) {
        statusChip.textContent = kilnStatus.isWaitingForCoolDown ? 'COOLING' : (step.type === 'hold' ? 'HOLDING' : 'HEATING');
      }
      if (nameEl) nameEl.textContent = step.label || (step.type === 'ramp' ? `Ramp to ${step.targetTempF}°F` : `Hold at ${step.tempF}°F`);
      if (detailsEl) {
        detailsEl.textContent = step.type === 'ramp'
          ? `Target: ${step.targetTempF}°F @ ${step.ratePerHour || 100}°F/hr`
          : `Soak at ${step.tempF}°F for ${step.durationMinutes} min`;
      }

      const progressPct = kilnStatus.stepProgressPercent != null
        ? kilnStatus.stepProgressPercent
        : calculateStepProgressFallback(step, kilnStatus, kilnTempF);

      if (pctEl) pctEl.textContent = `${progressPct}%`;
      if (barFill) barFill.style.width = `${progressPct}%`;

      if (subtextEl) {
        if (step.type === 'ramp') {
          const from = kilnStatus.stepStartTemp != null ? Math.round(kilnStatus.stepStartTemp) : 72;
          subtextEl.textContent = `Current: ${Math.round(kilnTempF || 72)}°F / Target: ${step.targetTempF}°F (from ${from}°F)`;
        } else {
          const holdElapsedMin = Math.floor((kilnStatus.trueHoldTimeMs || 0) / 60000);
          subtextEl.textContent = `Hold elapsed: ${holdElapsedMin}m of ${step.durationMinutes}m`;
        }
      }

      if (elapsedEl) {
        const stepSec = kilnStatus.stepElapsedSeconds != null
          ? kilnStatus.stepElapsedSeconds
          : (kilnStatus.stepStartTime ? Math.floor((Date.now() - kilnStatus.stepStartTime) / 1000) : 0);
        elapsedEl.textContent = formatDuration(stepSec);
      }

      if (remEl) {
        if (kilnStatus.stepRemainingSeconds != null) {
          remEl.textContent = formatDurationMinutes(Math.round(kilnStatus.stepRemainingSeconds / 60));
        } else {
          remEl.textContent = '—';
        }
      }

      if (totalProgEl) {
        const overallPct = Math.min(100, Math.round(((currentIdx + (progressPct / 100)) / total) * 100));
        totalProgEl.textContent = `${overallPct}%`;
      }
    } else {
      banner.style.display = 'none';
    }
  }

  // 3. Step Track Rail
  track.innerHTML = '';
  const segments = state.stepSegments && state.stepSegments.length ? state.stepSegments : computeStepSegments(schedule, kilnTempF || 72);

  segments.forEach((seg, i) => {
    const isDone = isFiring ? i < currentIdx : isComplete;
    const isActive = isFiring && i === currentIdx;
    const isUpcoming = isFiring ? i > currentIdx : !isComplete;

    let progress = 0;
    if (isDone) progress = 100;
    else if (isActive) {
      progress = kilnStatus.stepProgressPercent != null
        ? kilnStatus.stepProgressPercent
        : calculateStepProgressFallback(schedule.steps[i], kilnStatus, kilnTempF);
    }

    const card = document.createElement('div');
    card.className = `step-journey-card ${isActive ? 'active' : (isDone ? 'done' : 'upcoming')}`;
    card.dataset.stepIndex = i;
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');

    const statusBadge = isDone
      ? '<span style="color:var(--success); font-weight:700; font-size:0.65rem;">✓ DONE</span>'
      : isActive
        ? '<span style="color:var(--ember); font-weight:700; font-size:0.65rem;">⚡ ACTIVE</span>'
        : '<span style="color:var(--text-muted); font-size:0.65rem;">⏳ UPCOMING</span>';

    card.innerHTML = `
      <div class="step-card-top">
        <div class="step-icon-badge">
          <span class="step-symbol">${isDone ? '✓' : (isActive ? '⚡' : (i + 1))}</span>
          <span>Step ${i + 1}</span>
        </div>
        <span class="step-card-type-chip ${seg.type}">${seg.type.toUpperCase()}</span>
        ${statusBadge}
      </div>
      <div class="step-card-title">${escHtml(seg.label)}</div>
      <div class="step-card-metrics">
        <span class="step-metric-target">${seg.type === 'ramp' ? `→ ${seg.targetTempF}°F` : `${seg.targetTempF}°F`}</span>
        <span class="step-metric-rate">${seg.type === 'ramp' ? `@ ${seg.ratePerHour}°F/hr` : `for ${seg.durationMinutes}m`}</span>
      </div>
      <div class="step-card-bar-track">
        <div class="step-card-bar-fill" style="width: ${progress}%;"></div>
      </div>
      <div class="step-card-footer">
        <span class="step-card-duration">⏱ ${formatDurationMinutes(seg.durationMinutes)}</span>
        <span class="step-card-pct">${progress}%</span>
      </div>
    `;

    // Click to focus step
    card.addEventListener('click', () => {
      setGraphView('step', i);
    });

    track.appendChild(card);
  });
}

function bindGraphControls() {
  const btnAll = document.getElementById('btn-view-all');
  const btnStep = document.getElementById('btn-view-step');
  const btnLive = document.getElementById('btn-view-live');

  if (btnAll) btnAll.addEventListener('click', () => setGraphView('all'));
  if (btnStep) btnStep.addEventListener('click', () => setGraphView('step'));
  if (btnLive) btnLive.addEventListener('click', () => setGraphView('live'));
}

// ============================================================
// SCHEDULES
// ============================================================
async function loadSchedules() {
  try {
    const res = await fetch(API.schedules);
    state.schedules = await res.json();
    renderSchedules();
    populateScheduleSelect();

    // If kiln is idle, prime the graph with the first/default schedule
    const isFiring = state.live?.kilnStatus && (state.live.kilnStatus.state === 'FIRING' || state.live.kilnStatus.state === 'HOLD');
    if (!isFiring && state.schedules.length > 0 && !state.firingChart) {
      const defaultSched = state.schedules.find(s => s.id === 'schedule-med-bisque-06') || state.schedules[0];
      previewScheduleOnGraph(defaultSched);
    }
  } catch (e) {
    console.error('Failed to load schedules', e);
  }
}

// Delegated handler for all schedule card buttons
document.addEventListener('DOMContentLoaded', () => {
  const grid = document.getElementById('schedules-grid');
  if (grid) {
    grid.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      const name = btn.dataset.name || '';
      if (action === 'edit') openEditSchedule(id);
      else if (action === 'delete') deleteSchedule(id, name);
      else if (action === 'reset') resetSchedule(id, name);
      else if (action === 'fire') quickStartSchedule(id);
      else if (action === 'tune') openTuningModal(id, name);
    });
  }
});

function renderSchedules() {
  const grid = document.getElementById('schedules-grid');
  if (!grid) return;

  if (!state.schedules.length) {
    grid.innerHTML = '<div class="loading-state">No schedules yet. Create one to get started.</div>';
    return;
  }

  grid.innerHTML = '';
  const PRESET_IDS = ['schedule-med-bisque-06', 'schedule-slow-bisque-04', 'schedule-fast-glaze-6', 'schedule-med-glaze-6', 'schedule-low-glaze-04'];

  state.schedules.forEach(s => {
    const isPreset = PRESET_IDS.includes(s.id);
    const card = document.createElement('div');
    card.className = 'schedule-card';
    card.innerHTML = `
      <div class="schedule-card-header">
        <div>
          <div class="schedule-card-name">${escHtml(s.name)}</div>
          ${s.description ? `<div class="schedule-card-desc">${escHtml(s.description)}</div>` : ''}
        </div>
      </div>
      <div class="schedule-card-meta">
        <span>⚡ ${(s.kilnWatts || 2400).toLocaleString()}W</span>
        <span>📋 ${s.steps.length} steps</span>
        <span>⏱ ${calcScheduleDuration(s)}</span>
      </div>
      <div class="schedule-steps-preview">
        ${s.steps.map(step => `
          <div class="step-preview-item">
            <span class="step-type-pill ${step.type}">${step.type}</span>
            ${step.type === 'ramp'
              ? `<span>${escHtml(step.label || '')} → ${step.targetTempF}°F @ ${step.ratePerHour}°/hr</span>`
              : `<span>${escHtml(step.label || '')} @ ${step.tempF}°F for ${step.durationMinutes}min</span>`
            }
          </div>
        `).join('')}
      </div>
      <div class="schedule-card-actions">
        <button class="btn btn-sm btn-outline" data-action="edit" data-id="${s.id}">✏️ Edit</button>
        <button class="btn btn-sm btn-outline" style="border-color:var(--text-muted);" data-action="tune" data-id="${s.id}" data-name="${escHtml(s.name)}">🤖 Auto-Tune</button>
        <button class="btn btn-sm btn-danger" data-action="delete" data-id="${s.id}" data-name="${escHtml(s.name)}">🗑️</button>
        ${isPreset ? `<button class="btn btn-sm btn-outline" data-action="reset" data-id="${s.id}" data-name="${escHtml(s.name)}">🔄</button>` : ''}
        <button class="btn btn-sm btn-fire" style="margin-left:auto" data-action="fire" data-id="${s.id}">🔥 Fire</button>
      </div>
    `;
    grid.appendChild(card);
  });
}

function populateScheduleSelect() {
  const sel = document.getElementById('start-schedule-select');
  const studioSel = document.getElementById('studio-dropdown-select');
  const libCountEl = document.getElementById('qcard-library-count');

  if (libCountEl) {
    libCountEl.textContent = `${state.schedules.length} Programs`;
  }

  if (sel) {
    const current = sel.value;
    sel.innerHTML = '<option value="">Select a schedule…</option>';
    state.schedules.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      sel.appendChild(opt);
    });
    if (current) sel.value = current;
    const startBtn = document.getElementById('btn-start-fire');
    if (startBtn) startBtn.disabled = !sel.value;
  }

  if (studioSel) {
    const current = studioSel.value;
    studioSel.innerHTML = '<option value="">Choose saved schedule…</option>';
    state.schedules.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      studioSel.appendChild(opt);
    });
    if (current) studioSel.value = current;
  }
}

function calcScheduleDuration(schedule) {
  let totalMin = 0;
  let prevTemp = 72;
  for (const step of schedule.steps) {
    if (step.type === 'ramp') {
      const delta = Math.abs(step.targetTempF - prevTemp);
      totalMin += (delta / (step.ratePerHour || 100)) * 60;
      prevTemp = step.targetTempF;
    } else if (step.type === 'hold') {
      totalMin += step.durationMinutes || 0;
      prevTemp = step.tempF;
    }
  }
  const h = Math.floor(totalMin / 60);
  const m = Math.round(totalMin % 60);
  return h > 0 ? `~${h}h ${m}m` : `~${m}m`;
}

async function quickStartSchedule(id) {
  const sel = document.getElementById('start-schedule-select');
  if (sel) sel.value = id;
  const studioSel = document.getElementById('studio-dropdown-select');
  if (studioSel) studioSel.value = id;
  await startFiring(id);
  switchTab('dashboard');
}

async function deleteSchedule(id, name) {
  if (!confirm(`Are you sure you want to delete "${name}"?`)) return;
  try {
    const res = await fetch(`/api/schedules/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete failed');
    toast('Schedule deleted', 'info');
    await loadSchedules();
  } catch (err) {
    console.error(err);
    toast('Failed to delete schedule', 'error');
  }
}

async function resetSchedule(id, name) {
  if (!confirm(`Are you sure you want to completely restore "${name}" to its original default preset?\n\nThis will wipe out any edits you've made to it.`)) return;
  try {
    const res = await fetch(`/api/schedules/${id}/reset`, { method: 'POST' });
    if (!res.ok) throw new Error('Reset failed');
    toast(`Preset restored: ${name}`, 'success');
    await loadSchedules();
  } catch (err) {
    console.error(err);
    toast('Failed to reset schedule', 'error');
  }
}

// ============================================================
// SCHEDULE EDITOR MODAL
// ============================================================
function openNewSchedule() {
  state.editingScheduleId = null;
  state.tempSteps = [];
  document.getElementById('modal-title').textContent = 'New Schedule';
  document.getElementById('modal-save').textContent = 'Create Schedule';
  const copyBtn = document.getElementById('modal-save-copy');
  if (copyBtn) copyBtn.style.display = 'none';
  document.getElementById('sched-name').value = '';
  document.getElementById('sched-desc').value = '';
  document.getElementById('sched-watts').value = state.settings.defaultKilnWatts || 2400;
  renderStepsEditor();
  document.getElementById('schedule-modal').classList.remove('hidden');
}

function openEditSchedule(id) {
  const s = state.schedules.find(x => x.id === id);
  if (!s) return;
  state.editingScheduleId = id;
  state.tempSteps = s.steps.map(step => ({ ...step }));
  document.getElementById('modal-title').textContent = `Edit: ${s.name}`;
  document.getElementById('modal-save').textContent = 'Save Changes';
  const copyBtn = document.getElementById('modal-save-copy');
  if (copyBtn) copyBtn.style.display = 'inline-block';
  document.getElementById('sched-name').value = s.name;
  document.getElementById('sched-desc').value = s.description || '';
  document.getElementById('sched-watts').value = s.kilnWatts || 2400;
  renderStepsEditor();
  document.getElementById('schedule-modal').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('schedule-modal').classList.add('hidden');
}

function addStep(type) {
  const id = 'step-' + Date.now();
  if (type === 'ramp') {
    const lastTemp = getLastStepTemp();
    state.tempSteps.push({ id, type: 'ramp', label: '', targetTempF: lastTemp + 200, ratePerHour: 150 });
  } else {
    const lastTemp = getLastStepTemp();
    state.tempSteps.push({ id, type: 'hold', label: '', tempF: lastTemp, durationMinutes: 30 });
  }
  renderStepsEditor();
}

function getLastStepTemp() {
  for (let i = state.tempSteps.length - 1; i >= 0; i--) {
    const s = state.tempSteps[i];
    if (s.type === 'ramp') return s.targetTempF || 72;
    if (s.type === 'hold') return s.tempF || 72;
  }
  return 72;
}

function removeStep(id) {
  state.tempSteps = state.tempSteps.filter(s => s.id !== id);
  renderStepsEditor();
}

function moveStepUp(index) {
  if (index <= 0) return;
  const temp = state.tempSteps[index];
  state.tempSteps[index] = state.tempSteps[index - 1];
  state.tempSteps[index - 1] = temp;
  renderStepsEditor();
}

function moveStepDown(index) {
  if (index >= state.tempSteps.length - 1) return;
  const temp = state.tempSteps[index];
  state.tempSteps[index] = state.tempSteps[index + 1];
  state.tempSteps[index + 1] = temp;
  renderStepsEditor();
}

function renderStepsEditor() {
  const list = document.getElementById('steps-list');
  if (!list) return;
  list.innerHTML = '';

  if (!state.tempSteps.length) {
    list.innerHTML = '<div style="padding:1rem;color:var(--text-muted);font-size:0.82rem;text-align:center;">No steps yet. Add a Ramp or Hold step above.</div>';
    return;
  }

  state.tempSteps.forEach((step, i) => {
    const row = document.createElement('div');
    row.className = 'step-editor-row';

    if (step.type === 'ramp') {
      row.innerHTML = `
        <span class="step-type-pill ramp">Ramp</span>
        <div class="step-field-group">
          <span class="step-input-label">Label (optional)</span>
          <input class="step-input" id="step-label-${i}" type="text" value="${escHtml(step.label || '')}" placeholder="e.g. Water Smoking" oninput="updateStep(${i}, 'label', this.value)" />
        </div>
        <div class="step-field-group" style="max-width:110px">
          <span class="step-input-label">Target °F</span>
          <input class="step-input" id="step-target-${i}" type="number" value="${step.targetTempF || ''}" placeholder="1000" oninput="updateStep(${i}, 'targetTempF', +this.value)" />
        </div>
        <div class="step-field-group" style="max-width:120px">
          <span class="step-input-label">°F/hr Rate</span>
          <input class="step-input" id="step-rate-${i}" type="number" value="${step.ratePerHour || ''}" placeholder="150" oninput="updateStep(${i}, 'ratePerHour', +this.value)" />
        </div>
        <div style="display: flex; flex-direction: column; gap: 4px; margin-right: 8px;">
          <button type="button" style="padding: 0px 6px; font-size: 10px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; cursor: pointer; color: white;" onclick="moveStepUp(${i})" title="Move Up" ${i === 0 ? 'disabled style="opacity: 0.3; cursor: not-allowed; padding: 0px 6px; font-size: 10px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: white;"' : ''}>▲</button>
          <button type="button" style="padding: 0px 6px; font-size: 10px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; cursor: pointer; color: white;" onclick="moveStepDown(${i})" title="Move Down" ${i === state.tempSteps.length - 1 ? 'disabled style="opacity: 0.3; cursor: not-allowed; padding: 0px 6px; font-size: 10px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: white;"' : ''}>▼</button>
        </div>
        <button class="step-delete-btn" onclick="removeStep('${step.id}')" title="Remove step">✕</button>
      `;
    } else {
      row.innerHTML = `
        <span class="step-type-pill hold">Hold</span>
        <div class="step-field-group">
          <span class="step-input-label">Label (optional)</span>
          <input class="step-input" id="step-label-${i}" type="text" value="${escHtml(step.label || '')}" placeholder="e.g. Quartz Hold" oninput="updateStep(${i}, 'label', this.value)" />
        </div>
        <div class="step-field-group" style="max-width:100px">
          <span class="step-input-label">Temp °F</span>
          <input class="step-input" id="step-temp-${i}" type="number" value="${step.tempF || ''}" placeholder="1000" oninput="updateStep(${i}, 'tempF', +this.value)" />
        </div>
        <div class="step-field-group" style="max-width:110px">
          <span class="step-input-label">Duration (min)</span>
          <input class="step-input" id="step-dur-${i}" type="number" value="${step.durationMinutes || ''}" placeholder="30" oninput="updateStep(${i}, 'durationMinutes', +this.value)" />
        </div>
        <div style="display: flex; flex-direction: column; gap: 4px; margin-right: 8px;">
          <button type="button" style="padding: 0px 6px; font-size: 10px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; cursor: pointer; color: white;" onclick="moveStepUp(${i})" title="Move Up" ${i === 0 ? 'disabled style="opacity: 0.3; cursor: not-allowed; padding: 0px 6px; font-size: 10px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: white;"' : ''}>▲</button>
          <button type="button" style="padding: 0px 6px; font-size: 10px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; cursor: pointer; color: white;" onclick="moveStepDown(${i})" title="Move Down" ${i === state.tempSteps.length - 1 ? 'disabled style="opacity: 0.3; cursor: not-allowed; padding: 0px 6px; font-size: 10px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: white;"' : ''}>▼</button>
        </div>
        <button class="step-delete-btn" onclick="removeStep('${step.id}')" title="Remove step">✕</button>
      `;
    }
    list.appendChild(row);
  });
}

function updateStep(index, field, value) {
  if (state.tempSteps[index]) {
    state.tempSteps[index][field] = value;
  }
}

document.getElementById('modal-save').addEventListener('click', () => saveSchedule(false));
document.getElementById('modal-save-copy').addEventListener('click', () => saveSchedule(true));

async function saveSchedule(asCopy = false) {
  const name = document.getElementById('sched-name').value.trim();
  if (!name) { toast('Please enter a schedule name', 'error'); return; }
  if (!state.tempSteps.length) { toast('Add at least one step', 'error'); return; }

  const payload = {
    name: asCopy ? `${name} (Copy)` : name,
    description: document.getElementById('sched-desc').value.trim(),
    kilnWatts: parseInt(document.getElementById('sched-watts').value) || 2400,
    steps: state.tempSteps
  };

  const isEditing = state.editingScheduleId && !asCopy;

  try {
    if (isEditing) {
      const res = await fetch(`${API.schedules}/${state.editingScheduleId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Update failed on server');
      }
      toast(`Schedule "${name}" updated!`, 'success');
    } else {
      const res = await fetch(API.schedules, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Creation failed on server');
      }
      toast(`Schedule "${payload.name}" created!`, 'success');
    }
    closeModal();
    await loadSchedules();
  } catch (e) {
    console.error('Save error:', e);
    toast(`Failed to save schedule: ${e.message}`, 'error');
  }
}

// ============================================================
// KILN CONTROLS
// ============================================================
async function startFiring(scheduleId, stepIndex) {
  const id = scheduleId || document.getElementById('start-schedule-select')?.value;
  const startStepIndex = (stepIndex !== undefined && stepIndex !== null)
    ? stepIndex
    : (document.getElementById('start-step-select')?.value || 0);
  if (!id) { toast('Select a schedule first', 'warning'); return; }
  try {
    const res = await fetch(API.kilnStart, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheduleId: id, startStepIndex })
    });
    if (!res.ok) {
      const err = await res.json();
      toast(`Error: ${err.error}`, 'error');
    } else {
      // Reset chart for new firing session
      state.chart.data.labels = [];
      state.chart.data.datasets.forEach(ds => ds.data = []);
      state.chart.update();
      toast('🔥 Firing started!', 'success');
    }
  } catch (e) {
    toast('Failed to start kiln', 'error');
  }
}

async function startWarmup() {
  try {
    const res = await fetch(API.kilnWarmup, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) {
      const err = await res.json();
      toast(`Error: ${err.error}`, 'error');
    } else {
      // Reset chart for new firing session
      state.chart.data.labels = [];
      state.chart.data.datasets.forEach(ds => ds.data = []);
      state.chart.update();
      toast('🔥 Warming up kiln to 250°F!', 'success');
    }
  } catch (e) {
    toast('Failed to start warmup', 'error');
  }
}

function showStopConfirm() {
  return new Promise(resolve => {
    const modal = document.getElementById('stop-confirm-modal');
    const okBtn = document.getElementById('stop-confirm-ok');
    const cancelBtn = document.getElementById('stop-confirm-cancel');
    if (!modal) { resolve(false); return; }

    modal.style.display = 'flex';

    const cleanup = (result) => {
      modal.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onOverlay);
      resolve(result);
    };
    const onOk      = () => cleanup(true);
    const onCancel  = () => cleanup(false);
    const onOverlay = (e) => { if (e.target === modal) cleanup(false); };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onOverlay);
  });
}

async function stopFiring() {
  const confirmed = await showStopConfirm();
  if (!confirmed) return;
  try {
    await fetch(API.kilnStop, { method: 'POST' });
    toast('Kiln stopped', 'warning');
  } catch (e) {
    toast('Failed to stop kiln', 'error');
  }
}

// ============================================================
// RECORDS
// ============================================================
async function loadRecords() {
  try {
    const res = await fetch(API.records);
    state.records = await res.json();
    renderRecords();
  } catch (e) {
    console.error('Failed to load records', e);
  }
}

function renderRecords() {
  const tbody = document.getElementById('records-tbody');
  const countEl = document.getElementById('records-count');
  if (!tbody) return;

  countEl.textContent = `${state.records.length} firing${state.records.length !== 1 ? 's' : ''}`;

  if (!state.records.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No firing records yet. Complete a firing to see records here.</td></tr>';
    return;
  }

  // Sort
  const sorted = [...state.records].sort((a, b) => {
    const col = state.recordsSortCol;
    let va = a[col], vb = b[col];
    if (col === 'startTime') { va = new Date(va); vb = new Date(vb); }
    if (col === 'duration') {
      va = getDurationSec(a.startTime, a.endTime);
      vb = getDurationSec(b.startTime, b.endTime);
    }
    if (va < vb) return state.recordsSortAsc ? -1 : 1;
    if (va > vb) return state.recordsSortAsc ? 1 : -1;
    return 0;
  });

  tbody.innerHTML = '';
  sorted.forEach(r => {
    const durationSec = getDurationSec(r.startTime, r.endTime);
    const startDate = r.startTime ? new Date(r.startTime) : null;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="record-date">${startDate ? startDate.toLocaleDateString() + ' ' + startDate.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '—'}</td>
      <td>${escHtml(r.scheduleName || '—')}</td>
      <td class="record-peak">${r.peakTempF != null ? r.peakTempF + '°F' : '—'}</td>
      <td class="mono">${formatDuration(durationSec)}</td>
      <td class="mono">${r.totalKWh != null ? r.totalKWh.toFixed(3) : '—'}</td>
      <td class="record-cost">${r.totalCost != null ? '$' + r.totalCost.toFixed(2) : '—'}</td>
      <td>${r.humidity != null ? r.humidity + '%' : '—'}</td>
      <td>${r.ambientTempF != null ? r.ambientTempF + '°F' : '—'}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-sm btn-outline replay-btn"
          data-id="${r.id}"
          data-name="${escHtml(r.scheduleName || 'Firing')}"
          data-start="${r.startTime || ''}">📈 Replay</button>
        <button class="btn btn-sm btn-danger delete-btn" data-id="${r.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // Delegated click handler for replay buttons — avoids quote-escaping issues with onclick
  tbody.querySelectorAll('.replay-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      replayRecord(btn.dataset.id, btn.dataset.name, btn.dataset.start);
    });
  });

  // Delegated click handler for delete buttons
  tbody.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      deleteRecord(btn.dataset.id);
    });
  });
}

async function deleteRecord(id) {
  if (!confirm('Delete this firing record?')) return;
  try {
    const res = await fetch(`${API.records}/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete failed on server');
    toast('Record deleted', 'success');
    await loadRecords();
  } catch (e) {
    toast('Failed to delete record', 'error');
  }
}

async function replayRecord(id, name, startTimeStr) {
  try {
    const modal = document.getElementById('replay-modal');
    const titleEl = document.getElementById('replay-title');
    const statusEl = document.getElementById('replay-status');
    const canvas = document.getElementById('replay-chart');
    if (!modal || !statusEl) return;

    // Destroy previous replay chart if it exists
    if (window._replayChart) {
      window._replayChart.destroy();
      window._replayChart = null;
    }

    // Prepare adaptive tuning box
    const tuningBox = document.getElementById('replay-adaptive-tuning');
    const tuningIdField = document.getElementById('tuning-record-id');
    const tuningMsg = document.getElementById('tuning-result-msg');
    if (tuningBox) tuningBox.style.display = 'block';
    if (tuningIdField) tuningIdField.value = id;
    if (tuningMsg) { tuningMsg.style.display = 'none'; tuningMsg.textContent = ''; }

    // Immediately pop the modal to give user feedback
    modal.style.display = 'flex';
    titleEl.textContent = `📈 ${name}`;
    statusEl.innerHTML = '<span style="color:var(--text-primary);">Loading temperature data...</span>';
    if (canvas) canvas.style.display = 'none';

    const res = await fetch(`${API.records}/${id}/readings`);
    const readings = await res.json();

    if (!readings || readings.length === 0) {
      statusEl.innerHTML = `
        <div style="padding: 3rem 1rem; text-align: center; background: rgba(0,0,0,0.2); border-radius: 8px; margin-top: 1rem;">
          <div style="font-size: 2rem; margin-bottom: 1rem;">🗄️</div>
          <h3 style="color: var(--text-primary); margin-bottom: 0.5rem;">No Curve Data Found</h3>
          <p style="color: var(--text-muted); font-size: 0.9rem; max-width: 400px; margin: 0 auto;">
            This firing was recorded before the KilnForge SQLite upgrade. 
            <br/><br/>
            Only new firings will have their full 2-second telemetry curves permanently saved and replayable here.
          </p>
        </div>
      `;
      return;
    }

    statusEl.textContent = `${readings.length} readings • ${name}${startTimeStr ? ' • ' + new Date(startTimeStr).toLocaleDateString() : ''}`;
    if (canvas) canvas.style.display = 'block';

    const firingStart = readings[0].timestamp;
    const chartData = readings.map(r => ({
      x: Math.round(((r.timestamp - firingStart) / 60000) * 10) / 10,
      y: Math.round(r.kilnTempF)
    }));

    const totalMinutes = chartData[chartData.length - 1]?.x || 60;

    // Calculate Ramp Rate Data (sampled every 30 mins)
    const rateData = [];
    if (chartData.length > 0) {
      for (let m = 30; m <= totalMinutes; m += 30) {
        const current = chartData.reduce((p, c) => Math.abs(c.x - m) < Math.abs(p.x - m) ? c : p);
        const past = chartData.reduce((p, c) => Math.abs(c.x - (m - 30)) < Math.abs(p.x - (m - 30)) ? c : p);
        const deltaHr = (current.x - past.x) / 60;
        if (deltaHr > 0.1) {
          const rate = Math.round((current.y - past.y) / deltaHr);
          rateData.push({ x: current.x, y: rate, fromTemp: past.y, toTemp: current.y });
        }
      }
    }

    const ctx = canvas.getContext('2d');
    window._replayChart = new Chart(ctx, {
      type: 'scatter',
      data: {
        datasets: [{
          label: 'Kiln Temp (°F)',
          data: chartData,
          borderColor: '#ff6b35',
          backgroundColor: 'rgba(255,107,53,0.12)',
          borderWidth: 2,
          pointRadius: 0,
          showLine: true,
          fill: true,
          tension: 0.3,
          yAxisID: 'y'
        }, {
          label: 'Ramp Rate (°F/hr)',
          data: rateData,
          borderColor: '#4fc3f7',
          backgroundColor: '#4fc3f7',
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 6,
          showLine: true,
          borderDash: [4, 4],
          tension: 0.3,
          yAxisID: 'y1'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 600 },
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(26,26,36,0.95)',
            callbacks: {
              title: items => {
                const mins = items[0]?.parsed?.x;
                const h = Math.floor(mins / 60);
                const m = Math.round(mins % 60);
                return `${h}h ${String(m).padStart(2,'0')}m elapsed`;
              },
              label: ctx => {
                if (ctx.datasetIndex === 1) {
                  const pt = ctx.raw;
                  const range = (pt.fromTemp != null && pt.toTemp != null)
                    ? ` (${Math.round(pt.fromTemp)}°F → ${Math.round(pt.toTemp)}°F)`
                    : '';
                  return `Rate: ${Math.round(ctx.parsed.y)}°F/hr${range}`;
                }
                return `Temp: ${Math.round(ctx.parsed.y)}°F`;
              }
            }
          }
        },
        scales: {
          x: {
            type: 'linear', min: 0, max: totalMinutes,
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: {
              color: '#5a5a78', font: { size: 10 }, maxTicksLimit: 10,
              callback: v => { const h = Math.floor(v/60); const m = Math.round(v%60); return h > 0 ? `${h}h${String(m).padStart(2,'0')}m` : `${m}m`; }
            },
            title: { display: true, text: 'Elapsed Time', color: '#5a5a78', font: { size: 10 } }
          },
          y: {
            type: 'linear', position: 'left',
            grid: { color: 'rgba(255,255,255,0.05)' },
            suggestedMin: 0,
            ticks: { color: '#ff6b35', font: { size: 10 }, precision: 0, callback: v => `${v}°F` }
          },
          y1: {
            type: 'linear', position: 'right',
            grid: { drawOnChartArea: false },
            title: { display: true, text: 'Ramp Rate °F/hr', color: '#4fc3f7', font: { size: 10 } },
            ticks: { color: '#4fc3f7', font: { size: 10 }, callback: v => `${Math.round(v)}/hr` }
          }
        }
      }
    });

    // ---- Ramp Rate Summary Table ----
    const tableEl = document.getElementById('replay-ramp-table');
    if (tableEl) {
      if (rateData.length === 0) {
        tableEl.innerHTML = '';
      } else {
        const rows = rateData.map(pt => {
          const tMark = pt.x;
          const h = Math.floor(tMark / 60);
          const m = Math.round(tMark % 60);
          const timeLabel = h > 0 ? `${h}h ${String(m).padStart(2,'0')}m` : `${m}m`;
          const direction = pt.y >= 0 ? '▲' : '▼';
          const color = Math.abs(pt.y) >= 300 ? '#4ade80' : Math.abs(pt.y) >= 150 ? '#facc15' : pt.y >= 0 ? '#ff9060' : '#f87171';
          return `
            <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
              <td style="color:var(--text-muted); padding:0.35rem 0.75rem;">${timeLabel}</td>
              <td style="padding:0.35rem 0.75rem;">${Math.round(pt.fromTemp ?? 0)}°F → ${Math.round(pt.toTemp ?? 0)}°F</td>
              <td style="padding:0.35rem 0.75rem; font-weight:600; color:${color};">${direction} ${Math.abs(pt.y)}°F/hr</td>
            </tr>`;
        }).join('');
        tableEl.innerHTML = `
          <div style="font-size:0.75rem; font-weight:600; letter-spacing:0.08em; color:var(--text-muted); margin-bottom:0.5rem; text-transform:uppercase;">Ramp Rate Log (30-min intervals)</div>
          <table style="width:100%; border-collapse:collapse; font-size:0.82rem;">
            <thead>
              <tr style="border-bottom:1px solid rgba(255,255,255,0.07);">
                <th style="text-align:left; padding:0.35rem 0.75rem; color:var(--text-muted); font-weight:500;">Elapsed</th>
                <th style="text-align:left; padding:0.35rem 0.75rem; color:var(--text-muted); font-weight:500;">Temp Range</th>
                <th style="text-align:left; padding:0.35rem 0.75rem; color:var(--text-muted); font-weight:500;">Rate</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>`;
      }
    }

  } catch (e) {
    statusEl.textContent = '❌ Failed to load temperature data.';
    console.error(e);
  }
}

function closeReplayModal() {
  const modal = document.getElementById('replay-modal');
  if (modal) modal.style.display = 'none';
  if (window._replayChart) { window._replayChart.destroy(); window._replayChart = null; }
  const tableEl = document.getElementById('replay-ramp-table');
  if (tableEl) tableEl.innerHTML = '';
}


// ============================================================
// SETTINGS
// ============================================================
async function loadSettings() {
  try {
    const res = await fetch(API.settings);
    state.settings = await res.json();
    applySettingsToForm(state.settings);
  } catch (e) {
    console.error('Failed to load settings', e);
  }
}

function applySettingsToForm(s) {
  setVal('set-location-query', s.locationQuery || '');
  const infoEl = document.getElementById('info-location-name');
  if (infoEl) {
    infoEl.textContent = s.locationName ? `${s.locationName} (${s.latitude.toFixed(2)}, ${s.longitude.toFixed(2)})` : '—';
  }
  setVal('set-rate', s.electricityRate || '0.12');
  setVal('set-watts', s.defaultKilnWatts || '2400');
  setVal('set-emporia-email', s.emporiaEmail || '');
  setVal('set-emporia-password', s.emporiaPassword || '');
  setVal('set-emporia-gid', s.emporiaDeviceGid || '');
  setVal('set-emporia-channel', s.emporiaChannelNum || '1');
  setVal('set-ai-api-key', s.aiVisionApiKey || '');

  // Adaptive learning checkbox
  const adaptiveCheckbox = document.getElementById('set-adaptive-learning');
  if (adaptiveCheckbox) {
    adaptiveCheckbox.checked = s.adaptiveLearningEnabled !== false; // default ON
  }
  const adaptiveStatus = document.getElementById('adaptive-learning-status');
  if (adaptiveStatus) {
    if (s.adaptiveLearningEnabled === false) {
      adaptiveStatus.textContent = '🔒 Locked — kiln will use existing thermal profile without updating it.';
      adaptiveStatus.style.color = 'var(--ember)';
    } else {
      adaptiveStatus.textContent = '🟢 Active — kiln is learning and updating the thermal profile after each ramp.';
      adaptiveStatus.style.color = 'var(--success, #4caf50)';
    }
  }

  const statEl = document.getElementById('emporia-status');
  const statLabel = document.getElementById('emporia-status-label');
  if (s.emporiaEmail) {
    statEl.classList.add('connected');
    statLabel.textContent = `Connected: ${s.emporiaEmail}`;
  } else {
    statEl.classList.remove('connected');
    statLabel.textContent = 'Not configured';
  }

  // Controller engine mode
  const mode = s.controllerMode || 'standard';
  const rStd = document.getElementById('mode-standard');
  const rPred = document.getElementById('mode-predictive');
  if (rStd) rStd.checked = (mode === 'standard');
  if (rPred) rPred.checked = (mode === 'predictive');

  const rStdCalc = document.getElementById('mode-standard-calcifer');
  const rPredCalc = document.getElementById('mode-predictive-calcifer');
  if (rStdCalc) rStdCalc.checked = (mode === 'standard');
  if (rPredCalc) rPredCalc.checked = (mode === 'predictive');

  updateControllerModeDisplay(mode);
}

function updateControllerModeDisplay(mode) {
  const isStd = mode === 'standard';
  const statusEl = document.getElementById('controller-mode-status');
  if (statusEl) {
    if (isStd) {
      statusEl.textContent = '🟢 Standard Active: Pure deterministic schedule pacing. No machine learning.';
      statusEl.style.color = 'var(--success, #4ade80)';
    } else {
      statusEl.textContent = '🧠 Predictive Active: Thermal profile lookups & coasting predictions enabled.';
      statusEl.style.color = 'var(--ember, #ff6b35)';
    }
  }

  const calcStatusEl = document.getElementById('controller-mode-status-calcifer');
  if (calcStatusEl) {
    calcStatusEl.textContent = isStd ? '🟢 Standard Classic Active' : '🧠 Demon Predictive Magic Active';
  }

  const heroBadge = document.getElementById('active-control-mode');
  if (heroBadge) {
    heroBadge.textContent = isStd ? 'Classic' : 'Adaptive (ML)';
    heroBadge.style.color = isStd ? 'var(--success, #4ade80)' : 'var(--ember, #ff6b35)';
  }
}

function setVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}

async function saveSettingsGroup(fields) {
  const payload = {};
  fields.forEach(({ key, id, transform }) => {
    const el = document.getElementById(id);
    if (el) {
      let val = el.value.trim();
      if (transform) val = transform(val);
      payload[key] = val;
    }
  });

  try {
    const res = await fetch(API.settings, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    state.settings = await res.json();
    return true;
  } catch (e) {
    toast('Failed to save settings', 'error');
    return false;
  }
}

// ============================================================
// LAYOUT SWITCHER (FAIL-SAFE CLASSIC / STUDIO TOGGLE)
// ============================================================
function initLayoutSwitcher() {
  const saved = localStorage.getItem('kilnforge_layout') || 'studio';
  setLayoutMode(saved, false);

  document.getElementById('btn-layout-studio')?.addEventListener('click', () => {
    setLayoutMode('studio', true);
  });

  document.getElementById('btn-layout-classic')?.addEventListener('click', () => {
    setLayoutMode('classic', true);
  });
}

function setLayoutMode(mode, showToast = true) {
  const isClassic = mode === 'classic';
  document.body.classList.toggle('layout-classic', isClassic);

  const btnStudio = document.getElementById('btn-layout-studio');
  const btnClassic = document.getElementById('btn-layout-classic');

  if (btnStudio) btnStudio.classList.toggle('active', !isClassic);
  if (btnClassic) btnClassic.classList.toggle('active', isClassic);

  localStorage.setItem('kilnforge_layout', mode);

  if (showToast) {
    toast(`Switched to ${isClassic ? 'Classic' : 'Studio'} View`, 'info');
  }
}

// ============================================================
// STUDIO QUICK ACTION CONTROLS
// ============================================================
let currentStudioSelection = null;

function bindStudioControls() {
  const cards = document.querySelectorAll('.quick-card');
  const studioSel = document.getElementById('studio-dropdown-select');
  const studioStepSel = document.getElementById('studio-step-select');
  const btnIgnite = document.getElementById('btn-studio-ignite');
  const btnStop = document.getElementById('btn-studio-stop');

  // Handle Card Clicks
  cards.forEach(card => {
    card.addEventListener('click', () => {
      // If firing is active, cards are disabled
      if (state.live?.kilnStatus?.state === 'FIRING' || state.live?.kilnStatus?.state === 'HOLD') {
        return;
      }
      selectStudioCard(card.id);
    });

    // Support keyboard selection (Enter / Space)
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        card.click();
      }
    });
  });

  // Handle studio dropdown change (Custom / Library card)
  if (studioSel) {
    studioSel.addEventListener('change', () => {
      const schedId = studioSel.value;
      if (!schedId) {
        if (studioStepSel) {
          studioStepSel.classList.add('hidden');
          studioStepSel.innerHTML = '<option value="0">Start at Step 1</option>';
        }
        if (btnIgnite) btnIgnite.disabled = true;
        updateStudioSelectionDisplay('Select Schedule', 'Choose a schedule from the dropdown to prime', 'Ignite Kiln', false);
        currentStudioSelection = null;
        return;
      }

      const sched = state.schedules.find(s => s.id === schedId);
      if (sched) {
        // Sync with classic select
        const classicSel = document.getElementById('start-schedule-select');
        if (classicSel) classicSel.value = schedId;

        // Populate step selector if schedule has steps
        if (studioStepSel) {
          if (sched.steps && sched.steps.length > 0) {
            studioStepSel.innerHTML = sched.steps.map((st, i) =>
              `<option value="${i}">Start at Step ${i + 1}: ${st.type.toUpperCase()}</option>`
            ).join('');
            studioStepSel.classList.remove('hidden');
          } else {
            studioStepSel.classList.add('hidden');
            studioStepSel.innerHTML = '<option value="0">Start at Step 1</option>';
          }
        }

        const duration = calcScheduleDuration(sched);
        currentStudioSelection = {
          type: 'custom',
          scheduleId: sched.id,
          label: sched.name,
          details: `${sched.name} • ${sched.steps.length} steps • ${duration}`
        };

        if (btnIgnite) btnIgnite.disabled = false;
        updateStudioSelectionDisplay(
          sched.name,
          `${duration} • ${sched.steps.length} steps • Ready to fire`,
          `Ignite: ${sched.name}`,
          true
        );

        if (!state.live?.kilnStatus || (state.live.kilnStatus.state !== 'FIRING' && state.live.kilnStatus.state !== 'HOLD')) {
          previewScheduleOnGraph(sched);
        }
      }
    });
  }

  // Handle studio step select change
  if (studioStepSel) {
    studioStepSel.addEventListener('change', () => {
      const stepIdx = parseInt(studioStepSel.value, 10) || 0;
      // Also sync classic step select
      const classicStepSel = document.getElementById('start-step-select');
      if (classicStepSel) classicStepSel.value = stepIdx;

      if (currentStudioSelection && currentStudioSelection.type === 'custom') {
        const sched = state.schedules.find(s => s.id === currentStudioSelection.scheduleId);
        if (sched) {
          updateStudioSelectionDisplay(
            sched.name,
            `${calcScheduleDuration(sched)} • ${sched.steps.length} steps • Starting at Step ${stepIdx + 1}`,
            `Ignite: ${sched.name}`,
            true
          );
        }
      }
    });
  }

  // Ignite Button
  if (btnIgnite) {
    btnIgnite.addEventListener('click', async () => {
      if (!currentStudioSelection) return;

      if (currentStudioSelection.type === 'warmup') {
        await startWarmup();
      } else if (currentStudioSelection.type === 'preset' || currentStudioSelection.type === 'custom') {
        let stepIdx = 0;
        if (currentStudioSelection.type === 'custom' && studioStepSel && !studioStepSel.classList.contains('hidden')) {
          stepIdx = parseInt(studioStepSel.value, 10) || 0;
        }
        await startFiring(currentStudioSelection.scheduleId, stepIdx);
      }
    });
  }

  // Studio Stop Button (same safe prompt)
  if (btnStop) {
    btnStop.addEventListener('click', stopFiring);
  }
}

function selectStudioCard(cardId) {
  const cards = document.querySelectorAll('.quick-card');
  cards.forEach(c => c.classList.toggle('selected', c.id === cardId));

  const studioSel = document.getElementById('studio-dropdown-select');
  const studioStepSel = document.getElementById('studio-step-select');
  const btnIgnite = document.getElementById('btn-studio-ignite');
  const isFiring = state.live?.kilnStatus && (state.live.kilnStatus.state === 'FIRING' || state.live.kilnStatus.state === 'HOLD');

  if (cardId === 'qcard-warmup') {
    if (studioSel) studioSel.classList.add('hidden');
    if (studioStepSel) studioStepSel.classList.add('hidden');

    currentStudioSelection = {
      type: 'warmup',
      label: 'Warm Up (250°F)',
      details: 'Ramp at 180°F/hr to 250°F and hold indefinitely'
    };

    if (btnIgnite) btnIgnite.disabled = false;
    updateStudioSelectionDisplay(
      'Warm Up (250°F)',
      'Candling hold for moisture removal • Heats to 250°F at 180°/hr and holds',
      'Warm Up Kiln (250°F)',
      true
    );

    if (!isFiring) {
      previewScheduleOnGraph({
        id: 'warmup',
        name: 'Warm Up (250°F)',
        steps: [
          { type: 'ramp', targetTempF: 250, ratePerHour: 180, label: 'Candling to 250°F' },
          { type: 'hold', tempF: 250, durationMinutes: 120, label: 'Moisture Soak' }
        ]
      });
    }

  } else if (cardId === 'qcard-bisque') {
    if (studioSel) studioSel.classList.add('hidden');
    if (studioStepSel) studioStepSel.classList.add('hidden');

    const bisqueSched = state.schedules.find(s => s.id === 'schedule-med-bisque-06') ||
                        state.schedules.find(s => s.name.toLowerCase().includes('bisque')) ||
                        state.schedules[0];

    if (bisqueSched) {
      currentStudioSelection = {
        type: 'preset',
        scheduleId: bisqueSched.id,
        label: bisqueSched.name,
        details: `Cone 06 (~1828°F) • ${calcScheduleDuration(bisqueSched)} • ${bisqueSched.steps.length} steps`
      };

      if (btnIgnite) btnIgnite.disabled = false;
      updateStudioSelectionDisplay(
        bisqueSched.name,
        `Cone 06 (~1828°F) • ${calcScheduleDuration(bisqueSched)} • ${bisqueSched.steps.length} steps`,
        'Ignite: Bisque Firing',
        true
      );

      if (!isFiring) previewScheduleOnGraph(bisqueSched);
    } else {
      updateStudioSelectionDisplay('Bisque Firing', 'No bisque schedule found in library', 'Ignite Kiln', false);
      if (btnIgnite) btnIgnite.disabled = true;
    }

  } else if (cardId === 'qcard-glaze') {
    if (studioSel) studioSel.classList.add('hidden');
    if (studioStepSel) studioStepSel.classList.add('hidden');

    const glazeSched = state.schedules.find(s => s.id === 'schedule-med-glaze-6') ||
                       state.schedules.find(s => s.id === 'schedule-fast-glaze-6') ||
                       state.schedules.find(s => s.name.toLowerCase().includes('glaze'));

    if (glazeSched) {
      currentStudioSelection = {
        type: 'preset',
        scheduleId: glazeSched.id,
        label: glazeSched.name,
        details: `Cone 6 (~2232°F) • ${calcScheduleDuration(glazeSched)} • ${glazeSched.steps.length} steps`
      };

      if (btnIgnite) btnIgnite.disabled = false;
      updateStudioSelectionDisplay(
        glazeSched.name,
        `Cone 6 (~2232°F) • ${calcScheduleDuration(glazeSched)} • ${glazeSched.steps.length} steps`,
        'Ignite: Cone 6 Glaze',
        true
      );

      if (!isFiring) previewScheduleOnGraph(glazeSched);
    } else {
      updateStudioSelectionDisplay('Mid-Fire Glaze', 'No glaze schedule found in library', 'Ignite Kiln', false);
      if (btnIgnite) btnIgnite.disabled = true;
    }

  } else if (cardId === 'qcard-custom') {
    if (studioSel) studioSel.classList.remove('hidden');

    if (studioSel && studioSel.value) {
      const sched = state.schedules.find(s => s.id === studioSel.value);
      if (sched) {
        currentStudioSelection = {
          type: 'custom',
          scheduleId: sched.id,
          label: sched.name,
          details: `${sched.name} • ${sched.steps.length} steps • ${calcScheduleDuration(sched)}`
        };
        if (btnIgnite) btnIgnite.disabled = false;
        updateStudioSelectionDisplay(
          sched.name,
          `${calcScheduleDuration(sched)} • ${sched.steps.length} steps • Ready to fire`,
          `Ignite: ${sched.name}`,
          true
        );

        if (!isFiring) previewScheduleOnGraph(sched);
      }
    } else {
      currentStudioSelection = null;
      if (btnIgnite) btnIgnite.disabled = true;
      updateStudioSelectionDisplay(
        'Library Schedule',
        'Choose a saved program from the dropdown below to prime',
        'Ignite Kiln',
        false
      );
    }
  }
}

function updateStudioSelectionDisplay(title, details, buttonText, isPrimed) {
  const nameEl = document.getElementById('studio-sel-name');
  const detailsEl = document.getElementById('studio-sel-details');
  const btnText = document.getElementById('btn-studio-ignite-text');

  if (nameEl) nameEl.textContent = title;
  if (detailsEl) detailsEl.textContent = details;
  if (btnText && buttonText) btnText.textContent = buttonText;
}

// ============================================================
// BIND CONTROLS
// ============================================================
function bindControls() {
  // Tab nav
  // (already done in initTabs)

  // Initialize Layout Switcher & Studio Controls
  initLayoutSwitcher();
  bindStudioControls();

  // Schedule select → enable start button and populate step selector
  const schedSel = document.getElementById('start-schedule-select');
  const stepSel = document.getElementById('start-step-select');
  if (schedSel) {
    schedSel.addEventListener('change', () => {
      const startBtn = document.getElementById('btn-start-fire');
      if (startBtn) startBtn.disabled = !schedSel.value;
      
      if (schedSel.value && stepSel) {
        const sched = state.schedules.find(s => s.id === schedSel.value);
        if (sched && sched.steps) {
          stepSel.innerHTML = sched.steps.map((st, i) => `<option value="${i}">Start at Step ${i+1}: ${st.type.toUpperCase()}</option>`).join('');
          stepSel.style.display = 'inline-block';
          if (!state.live?.kilnStatus || (state.live.kilnStatus.state !== 'FIRING' && state.live.kilnStatus.state !== 'HOLD')) {
            previewScheduleOnGraph(sched);
          }
        }
      } else if (stepSel) {
        stepSel.style.display = 'none';
        stepSel.innerHTML = '<option value="0">Start at Step 1</option>';
      }
    });
  }

  // Start / Stop
  const btnStart = document.getElementById('btn-start-fire');
  if (btnStart) btnStart.addEventListener('click', () => startFiring());

  const btnWarmup = document.getElementById('btn-warmup-fire');
  if (btnWarmup) btnWarmup.addEventListener('click', startWarmup);

  const btnStop = document.getElementById('btn-stop-fire');
  if (btnStop) btnStop.addEventListener('click', stopFiring);

  // New schedule button
  const btnNew = document.getElementById('btn-new-schedule');
  if (btnNew) btnNew.addEventListener('click', openNewSchedule);

  // Modal
  document.getElementById('modal-close')?.addEventListener('click', closeModal);
  document.getElementById('modal-cancel')?.addEventListener('click', closeModal);
  document.getElementById('btn-add-ramp')?.addEventListener('click', () => addStep('ramp'));
  document.getElementById('btn-add-hold')?.addEventListener('click', () => addStep('hold'));

  // Close modal on overlay click
  document.getElementById('schedule-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });

  // Records sort
  document.querySelectorAll('.records-table th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (state.recordsSortCol === col) {
        state.recordsSortAsc = !state.recordsSortAsc;
      } else {
        state.recordsSortCol = col;
        state.recordsSortAsc = false;
      }
      renderRecords();
    });
  });

  // Settings saves
  document.getElementById('btn-save-location')?.addEventListener('click', async () => {
    const ok = await saveSettingsGroup([
      { key: 'locationQuery', id: 'set-location-query' }
    ]);
    if (ok) {
      toast('Location saved! Geocoding...', 'success');
      // Reload settings in 1.5 seconds to pull the geocoded name/coordinates back from the server
      setTimeout(loadSettings, 1500);
    }
  });

  document.getElementById('btn-save-power')?.addEventListener('click', async () => {
    const ok = await saveSettingsGroup([
      { key: 'electricityRate', id: 'set-rate', transform: parseFloat },
      { key: 'defaultKilnWatts', id: 'set-watts', transform: parseInt }
    ]);
    if (ok) toast('Power settings saved!', 'success');
  });

  document.getElementById('btn-save-emporia')?.addEventListener('click', async () => {
    const ok = await saveSettingsGroup([
      { key: 'emporiaEmail', id: 'set-emporia-email' },
      { key: 'emporiaPassword', id: 'set-emporia-password' },
      { key: 'emporiaDeviceGid', id: 'set-emporia-gid', transform: v => v ? parseInt(v) : null },
      { key: 'emporiaChannelNum', id: 'set-emporia-channel', transform: parseInt }
    ]);
    if (ok) {
      toast('Emporia settings saved!', 'success');
      loadSettings(); // refresh status display
    }
  });

  document.getElementById('btn-save-ai')?.addEventListener('click', async () => {
    const ok = await saveSettingsGroup([
      { key: 'aiVisionApiKey', id: 'set-ai-api-key' }
    ]);
    if (ok) toast('AI Vision settings saved!', 'success');
  });

  // Adaptive learning lock toggle
  document.getElementById('btn-save-adaptive')?.addEventListener('click', async () => {
    const checkbox = document.getElementById('set-adaptive-learning');
    if (!checkbox) return;
    const enabled = checkbox.checked;
    try {
      const res = await fetch(API.settings, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adaptiveLearningEnabled: enabled })
      });
      state.settings = await res.json();
      applySettingsToForm(state.settings);
      toast(enabled ? '🟢 Adaptive Learning enabled!' : '🔒 Adaptive Learning locked!', 'success');
    } catch (e) {
      toast('Failed to save learning state', 'error');
    }
  });

  // Controller engine mode save
  const handleSaveControllerMode = async (selectedMode) => {
    try {
      const res = await fetch(API.settings, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ controllerMode: selectedMode })
      });
      state.settings = await res.json();
      applySettingsToForm(state.settings);
      const isStd = selectedMode === 'standard';
      toast(isStd ? '⚡ Standard Classic Mode Active' : '🧠 Adaptive ML Mode Active', 'success');
    } catch (e) {
      toast('Failed to save control engine mode', 'error');
    }
  };

  document.getElementById('btn-save-controller-mode')?.addEventListener('click', async () => {
    const selectedMode = document.querySelector('input[name="controller-mode"]:checked')?.value || 'standard';
    await handleSaveControllerMode(selectedMode);
  });

  document.getElementById('btn-save-controller-mode-calcifer')?.addEventListener('click', async () => {
    const selectedMode = document.querySelector('input[name="controller-mode-calcifer"]:checked')?.value || 'standard';
    await handleSaveControllerMode(selectedMode);
  });

  document.getElementById('btn-test-emporia')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-test-emporia');
    const oldText = btn.textContent;
    btn.textContent = 'Testing...';
    btn.disabled = true;
    try {
      const res = await fetch('/api/emporia/test');
      const data = await res.json();
      if (data.success) {
        toast(`Success! Connected to "${data.deviceName}". Current draw: ${data.watts}W`, 'success');
      } else {
        toast(`Connection failed: ${data.error}`, 'error');
      }
    } catch (e) {
      toast('Test request failed completely', 'error');
    } finally {
      btn.textContent = oldText;
      btn.disabled = false;
    }
  });
}

// ============================================================
// UTILITIES
// ============================================================
function formatDuration(totalSec) {
  if (!totalSec || totalSec < 0) return '—';
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  if (h > 0) return `${h}h ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2,'0')}s`;
  return `${s}s`;
}

function getDurationSec(start, end) {
  if (!start || !end) return 0;
  return Math.max(0, Math.floor((new Date(end) - new Date(start)) / 1000));
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toast(message, type = 'success', duration = 3000) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icons = { success: '✅', error: '❌', warning: '⚠️' };
  el.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ️'}</span><span>${message}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.style.animation = 'toast-out 0.3s ease forwards';
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// ============================================================
// TUNING LOGIC & EVENT LISTENERS
// ============================================================
function openTuningModal(id, name) {
  state.tuningScheduleId = id;
  document.getElementById('tuning-sched-name').textContent = name;
  document.getElementById('vision-results').style.display = 'none';
  document.getElementById('auto-tune-prompt-box').style.display = 'none';
  document.getElementById('cone-file-input').value = '';
  document.getElementById('cone-target-num').value = '';
  document.getElementById('tuning-modal').classList.remove('hidden');
}

function closeTuningModal() {
  document.getElementById('tuning-modal').classList.add('hidden');
  state.tuningScheduleId = null;
}

document.getElementById('tuning-close')?.addEventListener('click', closeTuningModal);
document.getElementById('btn-cancel-tuning')?.addEventListener('click', closeTuningModal);

document.getElementById('btn-analyze-cone')?.addEventListener('click', async () => {
  const fileInput = document.getElementById('cone-file-input');
  if (!fileInput.files.length) return toast('Please select an image file first', 'error');

  const file = fileInput.files[0];
  const reader = new FileReader();
  
  reader.onloadend = async () => {
    const base64String = reader.result.replace(/^data:(.*,)?/, '');
    const mimeType = file.type;
    const targetCone = document.getElementById('cone-target-num').value.trim();

    const btn = document.getElementById('btn-analyze-cone');
    btn.classList.add('hidden');
    document.getElementById('ai-loading').classList.remove('hidden');

    try {
      const res = await fetch('/api/analyze-cone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64Data: base64String, mimeType, targetCone })
      });
      const data = await res.json();
      
      if (data.success) {
        document.getElementById('ai-loading').classList.add('hidden');
        document.getElementById('vision-results').style.display = 'flex';
        document.getElementById('res-bend').textContent = data.estimatedBend;
        document.getElementById('res-maturity').textContent = data.maturity.toUpperCase();
        document.getElementById('res-analysis').textContent = data.analysis;

        // Automatically map defects based on maturity
        let defects = [];
        if (data.maturity.toLowerCase().includes('underfired')) {
          defects.push('underfired');
        }

        // Only trigger an auto-tune suggestion if a defect is found
        if (defects.length > 0) {
          const tuneRes = await fetch('/api/auto-tune-schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scheduleId: state.tuningScheduleId, defects })
          });
          const tuneData = await tuneRes.json();
          if (tuneData.success) {
            state.tempTunedId = tuneData.newSchedule.id;
            document.getElementById('auto-tune-prompt-box').style.display = 'block';
            document.getElementById('tuned-preview-name').textContent = tuneData.newSchedule.name;
          }
        } else {
          document.getElementById('auto-tune-prompt-box').style.display = 'none';
        }

      } else {
        toast('Vision API Error: ' + data.error, 'error');
      }
    } catch (err) {
      toast('Request failed', 'error');
    } finally {
      document.getElementById('ai-loading').classList.add('hidden');
      document.getElementById('btn-analyze-cone').classList.remove('hidden');
    }
  };
  reader.readAsDataURL(file);
});

document.getElementById('btn-tuning-confirm')?.addEventListener('click', async () => {
  toast('Schedule successfully tuned and saved!', 'success');
  closeTuningModal();
  await loadSchedules();
  switchTab('schedules');
});

document.getElementById('btn-tuning-deny')?.addEventListener('click', async () => {
  // If denied, clean up the temporary spawned schedule from the backend
  if (state.tempTunedId) {
    try {
      await fetch(`/api/schedules/${state.tempTunedId}`, { method: 'DELETE' });
    } catch(e) {}
  }
  toast('Tuned schedule discarded.', 'success');
  closeTuningModal();
});

// Expose for inline onclick handlers
window.openEditSchedule = openEditSchedule;
window.deleteSchedule = deleteSchedule;
window.resetSchedule = resetSchedule;
window.quickStartSchedule = quickStartSchedule;
window.removeStep = removeStep;
window.updateStep = updateStep;
window.deleteRecord = deleteRecord;
window.openTuningModal = openTuningModal;

// ============================================================
// DRAGGABLE MODALS
// ============================================================
function makeDraggable(el, handle) {
  let isDragging = false;
  let startX, startY, initialLeft, initialTop;

  if (window.getComputedStyle(el).position === 'static') {
    el.style.position = 'relative';
  }

  handle.style.cursor = 'grab';
  handle.style.userSelect = 'none';

  handle.addEventListener('mousedown', (e) => {
    isDragging = true;
    handle.style.cursor = 'grabbing';
    startX = e.clientX;
    startY = e.clientY;
    
    const style = window.getComputedStyle(el);
    initialLeft = parseFloat(style.left) || 0;
    initialTop = parseFloat(style.top) || 0;
    
    // Clear out constraints so dragging relies strictly on top/left
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.margin = '0'; // just in case margins conflict loosely 
    
    e.preventDefault(); 
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    el.style.left = initialLeft + dx + 'px';
    el.style.top = initialTop + dy + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      handle.style.cursor = 'grab';
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  // Main Edit Modal (Schedule Editor)
  const editModal = document.querySelector('#schedule-modal .modal');
  const editHandle = document.querySelector('#schedule-modal .modal-header');
  if (editModal && editHandle) makeDraggable(editModal, editHandle);

  // Main Edit Modal (Analysis Modal)
  const tuneModal = document.querySelector('#tuning-modal .modal');
  const tuneHandle = document.querySelector('#tuning-modal .modal-header');
  if (tuneModal && tuneHandle) makeDraggable(tuneModal, tuneHandle);

  // Floating Cone Reference
  const coneRef = document.querySelector('.cone-reference');
  const coneHandle = coneRef?.querySelector('h4'); // The "Orton Cone Target °F" text acts as the handle
  if (coneRef && coneHandle) {
    // Add a visual hint to the header
    coneHandle.title = "Drag to move";
    coneHandle.style.padding = "0.5rem 0";
    coneHandle.style.marginTop = "-0.5rem";
    makeDraggable(coneRef, coneHandle);
  }
});

// ============================================================
// ADAPTIVE TUNING
// ============================================================
async function submitConeTuning() {
  const recordId = document.getElementById('tuning-record-id').value;
  const resultSelect = document.getElementById('tuning-physical-result').value;
  const msgEl = document.getElementById('tuning-result-msg');
  
  if (!resultSelect) return;

  try {
    msgEl.style.display = 'block';
    msgEl.style.color = 'var(--text-dim)';
    msgEl.textContent = 'Cloning...';

    const res = await fetch(`/api/records/${recordId}/calibrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: resultSelect })
    });
    
    const data = await res.json();
    
    if (data.success) {
      msgEl.style.color = 'var(--success)';
      msgEl.textContent = data.message;
      loadSchedules(); // reload schedules list to show the new mapped clone
    } else {
      msgEl.style.color = 'var(--danger)';
      msgEl.textContent = data.error || 'Failed to clone schedule.';
    }
  } catch (e) {
    msgEl.style.display = 'block';
    msgEl.style.color = 'var(--danger)';
    msgEl.textContent = 'Network error during calibration submission.';
  }
}
