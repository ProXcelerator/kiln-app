/**
 * Virtual Pyrometric Cone & Heat Work Tracker
 * 
 * OBSERVER PATTERN: This class sits completely insulated from the physical kiln relays.
 * It passively integrates time and temperature to calculate Orton-equivalent Cone values.
 */

class VirtualConeTracker {
  constructor() {
    this.reset();
    
    // The temperature where clay chemically begins accumulating meaningful heat work
    this.ACTIVATION_FLOOR_F = 1000;
  }

  reset() {
    this.heatWorkScore = 0;
    this.coneLevel = 0;
    this.lastTickMs = Date.now();
    this.currentVirtualCone = "Underfired";
  }

  /**
   * Called passively by kiln.js every second.
   * @param {number} kilnTempF 
   */
  tick(kilnTempF) {
    const fs = require('fs');
    const path = require('path');
    let multiplier = 1.0;
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'settings.json'), 'utf8'));
      if (settings.heatWorkMultiplier) multiplier = Number(settings.heatWorkMultiplier);
    } catch (e) {
      // safely fallback
    }

    const now = Date.now();
    const deltaHours = (now - this.lastTickMs) / 3600000;
    this.lastTickMs = now;

    // Only integrate area if we are above the activation floor
    if (kilnTempF > this.ACTIVATION_FLOOR_F) {
      // Standard linear area slice
      const sliceArea = (kilnTempF - this.ACTIVATION_FLOOR_F) * deltaHours * multiplier;
      this.heatWorkScore += sliceArea;

      // Exponential Cone Calculation: 
      // Calibrated specifically so that reaching 2167°F yields ~Cone 5.2, 
      // and holding at 2167°F for exactly 5 minutes adds 0.8 cones to hit exactly Cone 6.0.
      // 0.8 cones / 5 minutes = 9.6 cones per hour rate at 2167°F.
      const normalizedTemp = Math.max(0, kilnTempF - this.ACTIVATION_FLOOR_F) / 1167; // 1167 is (2167 - 1000)
      const coneRatePerHour = 9.6 * Math.pow(normalizedTemp, 7.6) * multiplier;
      
      this.coneLevel += coneRatePerHour * deltaHours;
    }

    this._updateConeString();
    return this.heatWorkScore;
  }

  /**
   * Matches the raw mathematical score against visual Cone equivalents.
   */
  _updateConeString() {
    const cl = this.coneLevel;
    
    if (cl < 0.5) this.currentVirtualCone = "Cold (< Cone 022)";
    else if (cl < 1.5) this.currentVirtualCone = "Cone 022 - 015";
    else if (cl < 2.5) this.currentVirtualCone = "Cone 014 - 010";
    else if (cl < 3.5) this.currentVirtualCone = "Cone 09 - 06 (Bisque)";
    else if (cl < 4.5) this.currentVirtualCone = "Cone 05 - 04 (Low Fire)";
    else if (cl < 5.0) this.currentVirtualCone = `Cone 4 (${cl.toFixed(2)})`;
    else if (cl < 6.0) this.currentVirtualCone = `Cone 5 (${cl.toFixed(2)})`;
    else if (cl < 7.0) this.currentVirtualCone = `Cone 6 (${cl.toFixed(2)})`;
    else if (cl < 8.0) this.currentVirtualCone = `Cone 7 (${cl.toFixed(2)})`;
    else if (cl < 10.0) this.currentVirtualCone = `Cone 8-10 (${cl.toFixed(2)})`;
    else this.currentVirtualCone = "Melted Puddle (Overfire)";
  }

  getLivePayload() {
    return {
      score: Math.round(this.heatWorkScore),
      cone: this.currentVirtualCone
    };
  }
}

module.exports = new VirtualConeTracker();
