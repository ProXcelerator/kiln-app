const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class AdaptiveLearningEngine {

  /**
   * Generates an optimized schedule based on the disparity between physical results and target cone.
   * @param {Object} originalSchedule 
   * @param {String} physicalResult ("Perfect", "Overfired", "Underfired", etc.)
   */
  generateOptimizedScheduleCopy(originalSchedule, physicalResult) {
    // We strictly clone the schedule to ensure the original is mathematically untouched.
    const optimized = JSON.parse(JSON.stringify(originalSchedule));
    
    // Assign a new ID and explicitly label it as an AI-Tuned generated schedule.
    optimized.id = 'schedule-optimized-' + crypto.randomUUID().slice(0, 8);
    optimized.name = `${originalSchedule.name} [Adaptive Tuned]`;
    optimized.description = `Auto-generated mathematically optimized clone of '${originalSchedule.name}' because the previous run was ${physicalResult}.`;

    if (physicalResult === "Overfired" || physicalResult === "Slightly Overfired") {
      // The kiln fed too much heat work. We need to reduce the target temperature OR target hold time on the final step.
      const finalStep = optimized.steps[optimized.steps.length - 1];
      
      if (finalStep && finalStep.type === 'hold') {
        // Shave 30% of the hold time off, with a minimum reduction of 5 minutes.
        const reduction = Math.max(5, Math.ceil(finalStep.durationMinutes * 0.3));
        finalStep.durationMinutes = Math.max(0, finalStep.durationMinutes - reduction);
      } else if (finalStep && finalStep.type === 'ramp') {
        // Lower target peak temperature by 10 degrees.
        finalStep.targetTempF -= 10;
      }
    } 
    else if (physicalResult === "Underfired" || physicalResult === "Slightly Underfired") {
      // The kiln needs more heat work.
      const finalStep = optimized.steps[optimized.steps.length - 1];
      
      if (finalStep && finalStep.type === 'hold') {
        // Add 10 minutes of hold time.
        finalStep.durationMinutes += 10;
      } else if (finalStep && finalStep.type === 'ramp') {
        // Increase target peak temperature by 15 degrees.
        finalStep.targetTempF += 15;
      }
    }

    return optimized;
  }
}

module.exports = new AdaptiveLearningEngine();
