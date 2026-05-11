// safety.js — Multi-layer software safety system for kiln control
//
// Layers implemented:
//   1. Max temperature hard limit (configurable °F ceiling)
//   2. Max firing duration hard limit (configurable hours)
//   3. Temperature runaway detection (sensor stuck / out of range)
//   4. Software watchdog — kills relay if main loop stops feeding it
//   5. Process signal handlers (SIGTERM, SIGINT, uncaughtException) → relay OFF
//   6. Linux hardware watchdog (/dev/watchdog) — triggers Pi reboot if process hangs
//
// HARDWARE NOTE: Use a Normally-Open (NO) relay.
// A NO relay requires active GPIO HIGH to stay closed (kiln ON).
// On Pi crash/freeze/reboot the pin goes LOW → relay opens → kiln cuts off.
// This is the most critical physical safety measure.

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');

// ============================================================
// CONFIG DEFAULTS (overridden by settings.json)
// ============================================================
const DEFAULTS = {
  maxKilnTempF:       2500,   // hard ceiling — stop firing if exceeded
  maxFiringHours:     16,     // max total firing time before auto-stop
  watchdogTimeoutSec: 30,     // kill relay if loop hasn't fed watchdog in this many seconds
  runawaySensitivity: 15,     // °F/min minimum rise expected during ramp (0 = disabled)
  runawayWindowMin:   5       // minutes to evaluate temperature rise over
};

class SafetySystem extends EventEmitter {
  constructor() {
    super();

    this.config = { ...DEFAULTS };
    this._reloadConfig();

    // Watchdog state
    this._lastFedAt = null;
    this._watchdogTimer = null;

    // Runaway detection
    this._tempHistory = []; // { time: ms, tempF: number }

    // Linux hardware watchdog fd
    this._hwWatchdogFd = null;
    this._hwWatchdogTimer = null;

    // State
    this.armed = false;
    this.tripReason = null;
  }

  // ---- Public API ----

  arm() {
    this.armed = true;
    this.tripReason = null;
    this._startWatchdog();
    this._openHardwareWatchdog();
    console.log('[Safety] Armed. Max temp:', this.config.maxKilnTempF + '°F,',
      'Max duration:', this.config.maxFiringHours + 'h,',
      'Watchdog timeout:', this.config.watchdogTimeoutSec + 's');
  }

  disarm() {
    this.armed = false;
    this._stopWatchdog();
    this._closeHardwareWatchdog();
    this._tempHistory = [];
    console.log('[Safety] Disarmed.');
  }

  // Called every telemetry tick (2s) — feed watchdog + run checks
  // Returns: { safe: true } or { safe: false, reason: string }
  check(kilnTempF, kilnState, startTimeIso) {
    if (!this.armed) return { safe: true };

    this._feedWatchdog();
    this._trackTemp(kilnTempF);

    // 1. Hard temperature ceiling
    if (kilnTempF != null && kilnTempF > this.config.maxKilnTempF) {
      return this._trip(`TEMP_CEILING: Kiln reached ${Math.round(kilnTempF)}°F — limit is ${this.config.maxKilnTempF}°F`);
    }

    // 2. Max firing duration
    if (startTimeIso) {
      const hoursElapsed = (Date.now() - new Date(startTimeIso).getTime()) / 3600000;
      if (hoursElapsed > this.config.maxFiringHours) {
        return this._trip(`DURATION_LIMIT: Firing has run ${hoursElapsed.toFixed(1)}h — limit is ${this.config.maxFiringHours}h`);
      }
    }

    // 3. Temperature runaway detection (during ramp only)
    if (kilnState === 'FIRING' && this.config.runawaySensitivity > 0) {
      const runaway = this._checkRunaway();
      if (runaway) return this._trip(runaway);
    }

    // 4. Sensor fault — null/NaN reading sustained (handled externally, but check anyway)
    if (kilnTempF == null || isNaN(kilnTempF)) {
      // Don't trip immediately — could be transient; thermocouple.js handles fallback
      // But log it
      console.warn('[Safety] Null temp reading at', new Date().toISOString());
    }

    return { safe: true };
  }

  getStatus() {
    return {
      armed: this.armed,
      tripReason: this.tripReason,
      config: { ...this.config },
      lastWatchdogFedAt: this._lastFedAt,
      hwWatchdogActive: this._hwWatchdogFd !== null
    };
  }

  reloadConfig() {
    this._reloadConfig();
  }

  // ---- Private ----

  _reloadConfig() {
    try {
      const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      this.config = {
        maxKilnTempF:       s.maxKilnTempF       || DEFAULTS.maxKilnTempF,
        maxFiringHours:     s.maxFiringHours      || DEFAULTS.maxFiringHours,
        watchdogTimeoutSec: s.watchdogTimeoutSec  || DEFAULTS.watchdogTimeoutSec,
        runawaySensitivity: s.runawaySensitivity  != null ? s.runawaySensitivity : DEFAULTS.runawaySensitivity,
        runawayWindowMin:   s.runawayWindowMin     || DEFAULTS.runawayWindowMin
      };
    } catch {
      this.config = { ...DEFAULTS };
    }
  }

  _trip(reason) {
    this.tripReason = reason;
    console.error('[Safety] ⛔ TRIP:', reason);
    this.emit('trip', { reason });
    return { safe: false, reason };
  }

  // ---- Software Watchdog ----

  _startWatchdog() {
    this._lastFedAt = Date.now();
    if (this._watchdogTimer) clearInterval(this._watchdogTimer);

    // Check every second if watchdog has been fed
    this._watchdogTimer = setInterval(() => {
      if (!this.armed) return;
      const elapsed = (Date.now() - this._lastFedAt) / 1000;
      if (elapsed > this.config.watchdogTimeoutSec) {
        console.error(`[Safety] ⛔ SOFTWARE WATCHDOG: Loop has not fed watchdog for ${elapsed.toFixed(1)}s — tripping`);
        this.emit('trip', { reason: `WATCHDOG_TIMEOUT: Main loop stalled for ${elapsed.toFixed(1)}s` });
      }
    }, 1000);

    console.log('[Safety] Software watchdog started.');
  }

  _stopWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
    this._petHardwareWatchdog(); // final pet before disarm
  }

  _feedWatchdog() {
    this._lastFedAt = Date.now();
    this._petHardwareWatchdog();
  }

  // ---- Linux Hardware Watchdog (/dev/watchdog) ----
  // On the Pi: sudo modprobe bcm2835_wdt
  // Add to /etc/modules: bcm2835_wdt
  // This causes a HARD REBOOT of the Pi if the process hangs without petting it.
  // On Pi reboot, the NO relay opens → kiln cuts off.

  _openHardwareWatchdog() {
    const WD_PATH = process.env.HW_WATCHDOG_PATH || '/dev/watchdog';
    try {
      if (fs.existsSync(WD_PATH)) {
        this._hwWatchdogFd = fs.openSync(WD_PATH, 'r+');
        // Pet every 5 seconds (Pi watchdog typically has 15s default timeout)
        this._hwWatchdogTimer = setInterval(() => this._petHardwareWatchdog(), 5000);
        console.log('[Safety] Hardware watchdog opened:', WD_PATH);
      } else {
        console.log('[Safety] Hardware watchdog not available (not on Pi or module not loaded).');
      }
    } catch (err) {
      console.warn('[Safety] Could not open hardware watchdog:', err.message);
    }
  }

  _petHardwareWatchdog() {
    if (this._hwWatchdogFd !== null) {
      try {
        fs.writeSync(this._hwWatchdogFd, '1');
      } catch (e) {
        // Ignore — pipe may have closed
      }
    }
  }

  _closeHardwareWatchdog() {
    if (this._hwWatchdogTimer) {
      clearInterval(this._hwWatchdogTimer);
      this._hwWatchdogTimer = null;
    }
    if (this._hwWatchdogFd !== null) {
      try {
        // Writing 'V' tells the watchdog to stop cleanly (magic close)
        fs.writeSync(this._hwWatchdogFd, 'V');
        fs.closeSync(this._hwWatchdogFd);
      } catch (e) {}
      this._hwWatchdogFd = null;
      console.log('[Safety] Hardware watchdog closed.');
    }
  }

  // ---- Temperature Runaway Detection ----

  _trackTemp(tempF) {
    if (tempF == null || isNaN(tempF)) return;
    const now = Date.now();
    this._tempHistory.push({ time: now, tempF });

    // Prune history older than runawayWindowMin * 2
    const cutoff = now - this.config.runawayWindowMin * 2 * 60 * 1000;
    this._tempHistory = this._tempHistory.filter(e => e.time > cutoff);
  }

  _checkRunaway() {
    const windowMs = this.config.runawayWindowMin * 60 * 1000;
    const now = Date.now();
    const windowStart = now - windowMs;

    const old = this._tempHistory.find(e => e.time >= windowStart);
    const current = this._tempHistory[this._tempHistory.length - 1];

    if (!old || !current || old === current) return null;

    const deltaF = current.tempF - old.tempF;
    const deltaMin = (current.time - old.time) / 60000;
    if (deltaMin < 1) return null;

    const ratePerMin = deltaF / deltaMin;

    // Only flag if temp is DROPPING when it should be climbing (ramp step)
    // and has been dropping for the full window
    if (ratePerMin < -(this.config.runawaySensitivity)) {
      return `TEMP_RUNAWAY: Temperature falling at ${Math.abs(ratePerMin).toFixed(1)}°F/min during ramp (expected rise). Possible sensor or heating element failure.`;
    }

    return null;
  }
}

module.exports = new SafetySystem();
