// kiln.js — Kiln state machine + schedule execution

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const virtualCone = require('./virtual_cone');

// Load the thermal profile saved by impulse_tune.js (if it exists)
let thermalProfile = null;
const THERMAL_PROFILE_PATH = path.join(__dirname, 'data', 'thermal_profile.json');
try {
  if (fs.existsSync(THERMAL_PROFILE_PATH)) {
    thermalProfile = JSON.parse(fs.readFileSync(THERMAL_PROFILE_PATH, 'utf8'));
    console.log('[Kiln] Thermal profile loaded. Feed-forward controller ACTIVE.');
  } else {
    console.log('[Kiln] No thermal profile found. Using basic Bang-Bang control.');
  }
} catch (e) {
  console.warn('[Kiln] Could not load thermal profile:', e.message);
}

class Kiln extends EventEmitter {
  constructor() {
    super();
    this.state = 'IDLE'; // IDLE | FIRING | HOLD | COMPLETE | ERROR
    this.schedule = null;
    this.stepIndex = 0;
    this.startTime = null;
    this.endTime = null;
    this.stepStartTime = null;
    this.stepStartTemp = null;

    // Stats accumulator
    this.kilnTempReadings = [];
    this.totalWattSeconds = 0;
    this.lastWattsUpdateAt = null;

    // Relay state (physical GPIO on Pi)
    this.relayOn = false;
    this._relay = null; // cached Gpio instance

    // Feed-Forward tracking: how many total relay-ON seconds have been "injected" recently
    this._recentRelayOnMs = 0;  // milliseconds of ON time accumulated this duty window
    this._lastRelayChangeAt = null; // timestamp of last relay state change
    this._relayWindowStart = Date.now(); // duty cycle window start

    // Adaptive learning: overshoot corrections learned during real firings
    // { "200": -8.2 } means "at 200°F target, we overshot by 8.2°F last time"
    this._overshootHistory = thermalProfile ? (thermalProfile.overshootCorrections || {}) : {};

    this._ticker = null;
  }

  // ---- Public API ----

  start(schedule, startStepIndex = 0) {
    if (this.state !== 'IDLE' && this.state !== 'COMPLETE' && this.state !== 'ERROR') {
      throw new Error(`Cannot start: kiln is ${this.state}`);
    }

    this.schedule = schedule;
    this.stepIndex = startStepIndex;
    this.startTime = new Date().toISOString();
    this.endTime = null;
    this.kilnTempReadings = [];
    this.totalWattSeconds = 0;
    this.lastWattsUpdateAt = Date.now();
    this.dutyCycle = 0;
    this._lastTickAt = Date.now();

    this._advanceStep();
    this.emit('stateChange', this.getStatus());
    return this.getStatus();
  }

  stop() {
    this._clearTicker();
    this.relayOn = false;
    this._setRelay(false);

    // If we were actively firing, save the record before clearing state
    if (this.state === 'FIRING' || this.state === 'HOLD') {
      this.endTime = new Date().toISOString();
      const lastTemp = this.kilnTempReadings.length ? this.kilnTempReadings[this.kilnTempReadings.length - 1] : 0;
      this.emit('complete', this._buildRecord(lastTemp));
    }

    this.state = 'IDLE';
    this.schedule = null;
    this.stepIndex = 0;
    this.startTime = null;
    this.endTime = null;
    this.emit('stateChange', this.getStatus());
    return this.getStatus();
  }

  complete(finalTemp) {
    this._clearTicker();
    this._setRelay(false);
    this.state = 'COMPLETE';
    this.endTime = new Date().toISOString();
    this.emit('complete', this._buildRecord(finalTemp));
    this.emit('stateChange', this.getStatus());
  }

  // Called every 2s by the main server loop with the latest temp reading
  tick(kilnTempF, watts) {
    if (this.state !== 'FIRING' && this.state !== 'HOLD') return;

    // Observe heat work passively
    virtualCone.tick(kilnTempF);

    // Track readings
    this.kilnTempReadings.push(kilnTempF);

    // Accumulate energy
    if (watts != null && this.lastWattsUpdateAt) {
      const dt = (Date.now() - this.lastWattsUpdateAt) / 1000; // seconds
      this.totalWattSeconds += watts * dt;
    }
    this.lastWattsUpdateAt = Date.now();

    const now = Date.now();
    const tickDeltaMs = this._lastTickAt ? (now - this._lastTickAt) : 2000;
    this._lastTickAt = now;

    // Calculate cooling derivative (Rate of Change)
    let dropRatePerSec = 0;
    if (this._lastTempF != null && tickDeltaMs > 0) {
      dropRatePerSec = (this._lastTempF - kilnTempF) / (tickDeltaMs / 1000);
    }
    this._lastTempF = kilnTempF;

    // EMA Duty Cycle tracking (60-second curve)
    const alpha = tickDeltaMs / (tickDeltaMs + 60000);
    const instantDuty = this.relayOn ? 100.0 : 0.0;
    if (this.dutyCycle === undefined) this.dutyCycle = instantDuty;
    this.dutyCycle = this.dutyCycle * (1 - alpha) + instantDuty * alpha;

    // Capture starting temperature of the step if it's the very first tick
    if (this.stepStartTemp === null) {
      this.stepStartTemp = kilnTempF;
    }

    // Check step completion
    const step = this.currentStep();
    if (!step) {
      this.complete(kilnTempF);
      return;
    }

    // 1. Calculate the 'Ideal Setpoint' for this exact moment in time
    let idealSetpoint = kilnTempF;

    if (step.type === 'ramp') {
      const hoursElapsed = (Date.now() - this.stepStartTime) / 3600000;
      const direction = step.targetTempF >= this.stepStartTemp ? 1 : -1;
      const tempRise = direction * (step.ratePerHour || 100) * hoursElapsed;
      idealSetpoint = this.stepStartTemp + tempRise;

      // -----------------------------------------------------
      // CATCH UP LOGIC: Pause clock if kiln falls >= 5F behind
      // -----------------------------------------------------
      const LAG_TOLERANCE_F = 5;
      if (direction === 1 && (idealSetpoint - kilnTempF) >= LAG_TOLERANCE_F) {
        this.stepStartTime += tickDeltaMs;
        const adjustedHours = (Date.now() - this.stepStartTime) / 3600000;
        idealSetpoint = this.stepStartTemp + (direction * (step.ratePerHour || 100) * adjustedHours);
        this._isLagging = true;
      } else {
        this._isLagging = false;
      }
      // -----------------------------------------------------

      // Cap the ideal setpoint at the actual target so it doesn't overshoot
      if (direction === 1 && idealSetpoint > step.targetTempF) idealSetpoint = step.targetTempF;
      if (direction === -1 && idealSetpoint < step.targetTempF) idealSetpoint = step.targetTempF;

    } else if (step.type === 'hold') {
      idealSetpoint = step.tempF;
    }

    // Expose for the API status
    this.currentSetpoint = idealSetpoint;

    // 2. Feed-Forward Predicted Temperature
    // Combines two sources of knowledge:
    //   A) Impulse response data: how much heat recent relay-on time will still add
    //   B) Adaptive overshoot history: how much THIS kiln historically coasts at this temperature
    let predictedCoastF = 0;
    let ceilingProtection = 1.0;

    // MANDATORY: We MUST protect the final target ceiling of the step so we don't blow past it into a hold!
    if (step.type === 'ramp' && step.targetTempF != null) {
      const distanceToCeiling = Math.abs(step.targetTempF - kilnTempF);
      ceilingProtection = distanceToCeiling > 25 ? 0 : (1.0 - (distanceToCeiling / 25));
    }

    // A) Impulse lookup prediction
    if (thermalProfile && thermalProfile.lookup && Object.keys(thermalProfile.lookup).length > 0 && this._recentRelayOnMs > 0) {
      const recentOnSec = this._recentRelayOnMs / 1000;
      const keys = Object.keys(thermalProfile.lookup).map(Number).sort((a, b) => a - b);
      let lower = keys[0], upper = keys[keys.length - 1];
      for (const k of keys) {
        if (k <= recentOnSec) lower = k;
        if (k >= recentOnSec && upper === keys[keys.length - 1]) upper = k;
      }
      const lData = thermalProfile.lookup[String(lower)];
      const uData = thermalProfile.lookup[String(upper)];
      if (lower === upper) {
        predictedCoastF = lData.deltaTempF;
      } else {
        const t = (recentOnSec - lower) / (upper - lower);
        predictedCoastF = lData.deltaTempF + t * (uData.deltaTempF - lData.deltaTempF);
      }

      // Attenuate the impulse response at high temperatures due to extreme thermal dissipation
      // 2400F acts as the baseline for zero coasting (heavy dampening).
      const thermalAttenuation = Math.max(0.05, 1.0 - (kilnTempF / 2400));
      predictedCoastF *= thermalAttenuation;

      // MUTE predictive coasting on the moving ramp line at high temperatures!
      // Below 1300°F, we gently pulse along the ramp line to learn and prevent any overshoot.
      // Above 1400°F, we prioritize raw power to fight heat loss and maintain the strict ramp speed.
      if (step.type === 'ramp') {
        let rampFade = 1.0;
        if (kilnTempF > 1300) {
           rampFade = Math.max(0, 1.0 - ((kilnTempF - 1300) / 100)); // Fades to 0 at 1400F
        }
        
        // Use whichever is higher: tracking the ramp line (if low temp) OR protecting the final ceiling
        predictedCoastF *= Math.max(rampFade, ceilingProtection);
      }
    }

    // Read adaptive learning live from settings file to allow mid-flight toggling
    let applyAdaptive = true;
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/settings.json'), 'utf8'));
      // Default to true. Explicitly checking for false allows background learning mode.
      applyAdaptive = settings.applyAdaptiveLearning !== false;
    } catch(e) {}

    // B) Adaptive overshoot correction — learned from real past firings at this temperature
    if (applyAdaptive && Object.keys(this._overshootHistory).length > 0 && step.targetTempF != null) {
      const bucketKey = String(Math.round(step.targetTempF / 50) * 50);
      const learnedOvershoot = this._overshootHistory[bucketKey];
      if (learnedOvershoot != null && learnedOvershoot > 0) {
        // Add a fraction of the learned overshoot, explicitly scaled by how close we are to the ceiling!
        predictedCoastF += (learnedOvershoot * 0.6) * ceilingProtection;
      }
    }

    // Override: If the physical kiln is lagging behind the schedule and the clock is paused,
    // completely disable all coasting predictions so we sprint at 100% power to catch up.
    if (this._isLagging) {
      predictedCoastF = 0;
    }

    // C) Undershoot Catching (Element Thermal Lag Offset)
    // If we are currently coasting downwards (relay is OFF) and the temperature is falling,
    // the heavy elements will take time (~12 seconds) to physically heat up and reverse the drop.
    if (!this.relayOn && dropRatePerSec > 0) {
      const ELEMENT_THERMAL_LAG_SEC = 12;
      // Subtract the expected fall from our prediction, artificially lowering effectiveTempF
      // so the relay playfully clicks ON early to catch the drop before it goes under the setpoint!
      predictedCoastF -= (dropRatePerSec * ELEMENT_THERMAL_LAG_SEC);
    }

    // Effective temperature = real temp + pulse prediction + learned overshoot correction - cooling offset
    const effectiveTempF = kilnTempF + predictedCoastF;

    // 3. Relay Control: Compare effectiveTempF (real + predicted coast) against setpoint
    const HYSTERESIS = 1.0;

    if (effectiveTempF <= idealSetpoint - HYSTERESIS) {
      if (!this.relayOn) {
        this._setRelay(true);
        this._lastRelayChangeAt = Date.now();
      } else {
        // Track how long relay has been ON in this window
        this._recentRelayOnMs += 2000; // approximately 2s per tick
      }
    } else if (effectiveTempF >= idealSetpoint) {
      if (this.relayOn) {
        this._setRelay(false);
        this._lastRelayChangeAt = Date.now();
        // Decay the accumulated on-time as the system cools
        // We halve it every time we turn OFF so old heat stops counting over time
        this._recentRelayOnMs = Math.max(0, this._recentRelayOnMs * 0.5);
      } else {
        // Relay already off, continue decaying the stored heat estimate
        this._recentRelayOnMs = Math.max(0, this._recentRelayOnMs - 100);
      }
    }

    // 4. Step Advancement - time-based to ensure schedule is respected
    if (step.type === 'ramp') {
      console.log(`[PID] Real: ${Math.round(kilnTempF)}°F | +Coast: ${Math.round(predictedCoastF * 10) / 10}°F | Effective: ${Math.round(effectiveTempF)}°F | Setpoint: ${Math.round(idealSetpoint)}°F | Relay: ${this.relayOn ? 'ON' : 'OFF'}`);

      const direction = step.targetTempF >= this.stepStartTemp ? 1 : -1;
      let mathematicallyComplete = false;
      if (direction === 1 && idealSetpoint >= step.targetTempF) mathematicallyComplete = true;
      if (direction === -1 && idealSetpoint <= step.targetTempF) mathematicallyComplete = true;

      if (mathematicallyComplete) {
        if (direction === 1 && kilnTempF >= step.targetTempF - 2) this._nextStep(kilnTempF);
        else if (direction === -1 && kilnTempF <= step.targetTempF + 2) this._nextStep(kilnTempF);
      }

    } else if (step.type === 'hold') {
      const elapsed = (Date.now() - this.stepStartTime) / 1000 / 60;
      if (elapsed >= step.durationMinutes) this._nextStep(kilnTempF);
    }
  }

  getStatus() {
    const step = this.currentStep();
    const elapsed = this.startTime
      ? Math.floor((Date.now() - new Date(this.startTime).getTime()) / 1000)
      : 0;

    return {
      state: this.state,
      scheduleName: this.schedule ? this.schedule.name : null,
      scheduleId: this.schedule ? this.schedule.id : null,
      stepIndex: this.stepIndex,
      currentStep: step || null,
      totalSteps: this.schedule ? this.schedule.steps.length : 0,
      startTime: this.startTime,
      endTime: this.endTime,
      elapsedSeconds: elapsed,
      relayOn: this.relayOn,
      dutyCycle: this.dutyCycle || 0,
      idealSetpoint: this.currentSetpoint != null ? Math.round(this.currentSetpoint * 10) / 10 : null,
      virtualCone: virtualCone.getLivePayload(),
      projectedEndTime: this._projectEndTime()
    };
  }

  currentStep() {
    if (!this.schedule || !this.schedule.steps) return null;
    return this.schedule.steps[this.stepIndex] || null;
  }

  getSchedule() {
    return this.schedule;
  }

  getStepIndex() {
    return this.stepIndex;
  }

  getTotalKWhUsed() {
    return this.totalWattSeconds / 3600 / 1000;
  }

  // ---- Private ----

  _advanceStep() {
    const step = this.schedule.steps[this.stepIndex];
    if (!step) {
      this.complete(null);
      return;
    }

    this.stepStartTime = Date.now();
    this.stepStartTemp = null; // Forces the next tick() to precisely capture the kiln's current temp
    this.state = step.type === 'hold' ? 'HOLD' : 'FIRING';
    
    // Notice: We DO NOT blindly set the relay to TRUE here anymore!
    // We let the thermostatic tick() control loop naturally turn it on 
    // if the temperature is too low.

    this.emit('stepChange', { stepIndex: this.stepIndex, step });
  }

  _nextStep(currentTemp) {
    const completedStepIndex = this.stepIndex;
    const completedStep = this.schedule ? this.schedule.steps[completedStepIndex] : null;
    const targetTemp = completedStep ? (completedStep.targetTempF || completedStep.tempF) : null;

    this.stepIndex++;
    if (this.stepIndex >= this.schedule.steps.length) {
      this.complete(currentTemp);
    } else {
      this._advanceStep();
    }

    // After a ramp step, silently monitor for peak overshoot in the background
    if (completedStep && completedStep.type === 'ramp' && targetTemp != null) {
      this._measureCoastOvershoot(targetTemp, currentTemp);
    }
  }

  // Silently monitors temperature after a ramp step completes to measure real peak.
  // Updates the thermal profile on disk with the learned overshoot for this target temperature.
  // Does nothing if adaptiveLearningEnabled is false in settings.json
  _measureCoastOvershoot(targetTempF, tempAtCompletion) {
    // Check the live settings file to respect the learning lock
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'settings.json'), 'utf8'));
      if (settings.adaptiveLearningEnabled === false) {
        console.log('[Adaptive] Learning is LOCKED. Skipping overshoot measurement.');
        return;
      }
    } catch (_) { /* if settings can't be read, default to learning ON */ }
    const MONITOR_DURATION_MS = 8 * 60 * 1000; // watch for 8 minutes max
    const POLL_MS = 5000;
    const startTime = Date.now();
    let peakF = tempAtCompletion;

    console.log(`[Adaptive] Monitoring coast after ramp to ${targetTempF}°F target...`);

    const monitor = setInterval(() => {
      // Pull from last telemetry reading rather than re-reading hardware
      const lastReading = this.kilnTempReadings[this.kilnTempReadings.length - 1];
      if (lastReading != null && lastReading > peakF) {
        peakF = lastReading;
      }

      const elapsed = Date.now() - startTime;
      const timeSinceCoastPeak = peakF > tempAtCompletion
        ? (Date.now() - startTime)
        : 0;

      // Stop when 8 minutes have elapsed or temp clearly started falling
      if (elapsed >= MONITOR_DURATION_MS || (peakF > tempAtCompletion + 1 && lastReading < peakF - 2)) {
        clearInterval(monitor);

        const overshoot = Math.round((peakF - targetTempF) * 10) / 10;
        const bucketKey = String(Math.round(targetTempF / 50) * 50); // round to nearest 50°F bucket

        console.log(`[Adaptive] Ramp to ${targetTempF}°F: peak was ${peakF.toFixed(1)}°F → overshoot +${overshoot}°F`);

        // Update overshoot correction table with weighted average (70% old, 30% new)
        const existing = this._overshootHistory[bucketKey];
        this._overshootHistory[bucketKey] = existing != null
          ? Math.round((existing * 0.7 + overshoot * 0.3) * 10) / 10
          : overshoot;

        console.log(`[Adaptive] Updated overshoot bucket ${bucketKey}°F → correction: ${this._overshootHistory[bucketKey]}°F`);
        this._saveThermalProfile();
      }
    }, POLL_MS);
  }

  // Persist the updated thermal profile (including learned corrections) back to disk
  _saveThermalProfile() {
    try {
      if (!thermalProfile) thermalProfile = { lookup: {}, overshootCorrections: {} };
      thermalProfile.overshootCorrections = this._overshootHistory;
      thermalProfile.lastUpdated = new Date().toISOString();
      fs.writeFileSync(THERMAL_PROFILE_PATH, JSON.stringify(thermalProfile, null, 2));
      console.log('[Adaptive] Thermal profile updated on disk.');
    } catch (err) {
      console.warn('[Adaptive] Could not save thermal profile:', err.message);
    }
  }

  _clearTicker() {
    if (this._ticker) {
      clearInterval(this._ticker);
      this._ticker = null;
    }
  }

  _setRelay(on) {
    this.relayOn = on;
    // === GPIO HOOK (Raspberry Pi only) ===
    try {
      const { Gpio } = require('onoff');
      if (!this._relay) {
        this._relay = new Gpio(17, 'out');
      }
      this._relay.writeSync(on ? 1 : 0);
    } catch (err) {
      console.warn('[Relay Warning] Could not trigger hardware GPIO. Is onoff installed?', err.message);
    }
    console.log(`[Relay] ${on ? 'ON' : 'OFF'}`);
  }

  _projectEndTime() {
    if (!this.schedule || !this.startTime || (this.state !== 'FIRING' && this.state !== 'HOLD')) {
      return null;
    }

    // Sum remaining step durations
    let remainingMinutes = 0;
    const steps = this.schedule.steps;
    for (let i = this.stepIndex; i < steps.length; i++) {
      const step = steps[i];
      if (step.type === 'ramp') {
        const currentStepTemp = i === this.stepIndex ? null : steps[i - 1]?.targetTempF || steps[i - 1]?.tempF || 72;
        // Estimate from start-of-step temp
        const fromTemp = currentStepTemp || 72;
        const toTemp = step.targetTempF;
        const deltaTemp = Math.abs(toTemp - fromTemp);
        const hours = deltaTemp / (step.ratePerHour || 100);
        remainingMinutes += hours * 60;
      } else if (step.type === 'hold') {
        if (i === this.stepIndex && this.stepStartTime) {
          const elapsedHoldMin = (Date.now() - this.stepStartTime) / 1000 / 60;
          remainingMinutes += Math.max(0, step.durationMinutes - elapsedHoldMin);
        } else {
          remainingMinutes += step.durationMinutes;
        }
      }
    }

    const projectedMs = Date.now() + remainingMinutes * 60 * 1000;
    return new Date(projectedMs).toISOString();
  }

  _buildRecord(finalTemp) {
    const readings = this.kilnTempReadings;
    const peakTemp = readings.length ? Math.max(...readings) : finalTemp;
    const avgTemp = readings.length
      ? Math.round(readings.reduce((a, b) => a + b, 0) / readings.length)
      : finalTemp;
    const kWh = this.getTotalKWhUsed();

    return {
      scheduleId: this.schedule.id,
      scheduleName: this.schedule.name,
      startTime: this.startTime,
      endTime: this.endTime || new Date().toISOString(),
      peakTempF: Math.round(peakTemp),
      avgTempF: Math.round(avgTemp),
      totalKWh: Math.round(kWh * 100) / 100,
      kilnWatts: this.schedule.kilnWatts
    };
  }

  updateWatchdog(kilnTempF, enabled, portPath = '/dev/ttyACM0') {
    if (!enabled) {
      if (this._serialPort && this._serialPort.isOpen) {
        this._serialPort.close();
        this._serialSetup = false;
      }
      return;
    }

    if (!this._serialSetup) {
      this._serialSetup = true;
      try {
        const { SerialPort } = require('serialport');
        this._serialPort = new SerialPort({ path: portPath, baudRate: 115200 });
        this._serialPort.on('error', (err) => console.warn('[Watchdog] Serial error:', err.message));
        console.log(`[Watchdog] Serial link initialized on ${portPath}`);
      } catch (e) {
        console.warn('[Watchdog] Failed to setup serialport or not installed:', e.message);
      }
    }

    if (this._serialPort && this._serialPort.isOpen) {
      const msg = `R:${this.relayOn ? 1 : 0} T:${Math.round(kilnTempF || 0)} S:${this.stepIndex}\n`;
      this._serialPort.write(msg, err => {
        if (err) console.warn('[Watchdog] Write error:', err.message);
      });
    }
  }
}

module.exports = new Kiln(); // singleton
