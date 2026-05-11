#include <ArduinoGraphics.h>
#include <TextAnimation.h>
#include <gallery.h>
#include "Arduino_LED_Matrix.h"

// ==========================================
// KILNFORGE ARDUINO WATCHDOG CONFIGURATION
// ==========================================
const int RELAY_PIN = 8;                 // Change to whatever digital pin your relay uses
const unsigned long TIMEOUT_MS = 15000;  // 15 seconds dead-man's switch

ArduinoLEDMatrix matrix;

// State Variables
unsigned long lastHeartbeatMs = 0;
bool relayIsOn = false;
int currentTemp = 0;
int currentStep = 0;
bool isConnected = false;

void setup() {
  Serial.begin(115200);   // Important: Node.js serialport must match this baud rate!
  Serial.setTimeout(50);  // Don't wait long for serial data
  
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW);
  
  matrix.begin();
  
  // Show startup logo / message
  matrix.beginDraw();
  matrix.stroke(0xFFFFFFFF);
  matrix.textScrollSpeed(60); 
  matrix.textFont(Font_5x7);
  matrix.beginText(0, 1, 0xFFFFFF);
  matrix.println("  KILN WATCHDOG ");
  matrix.endText(SCROLL_LEFT);
  matrix.endDraw();
  
  lastHeartbeatMs = millis();
}

void loop() {
  // 1. Process all incoming Serial data
  while (Serial.available() > 0) {
    String line = Serial.readStringUntil('\n');
    line.trim();
    
    // Expected format: "R:1 T:1650 S:3"
    if (line.length() > 0 && line.startsWith("R:")) {
      int parsedR = 0, parsedT = 0, parsedS = 0;
      int matched = sscanf(line.c_str(), "R:%d T:%d S:%d", &parsedR, &parsedT, &parsedS);
      
      if (matched >= 1) {
        lastHeartbeatMs = millis();
        isConnected = true;
        relayIsOn = (parsedR == 1);
        
        if (matched == 3) {
          currentTemp = parsedT;
          currentStep = parsedS;
        }
      }
    }
  }
  
  // 2. Check the Dead-Man's Switch Timer
  unsigned long now = millis();
  if (now - lastHeartbeatMs > TIMEOUT_MS) {
    // 💀 WE LOST THE PI! 💀
    relayIsOn = false;
    isConnected = false;
  }
  
  // 3. Actuate Physical Relay
  digitalWrite(RELAY_PIN, relayIsOn ? HIGH : LOW);
  
  // 4. Update the LED Matrix Display (Blocks for a few seconds if scrolling)
  matrix.beginDraw();
  matrix.stroke(0xFFFFFFFF);
  matrix.textScrollSpeed(55); // Fast enough to be responsive, slow enough to read
  matrix.textFont(Font_5x7);
  matrix.beginText(0, 1, 0xFFFFFF);
  
  if (!isConnected) {
    matrix.println("  ERR: LOST PI  ");
  } else if (relayIsOn) {
    matrix.print("   ON   ");
    matrix.print(currentTemp);
    matrix.print("F  ");
  } else {
    matrix.print("  OFF   ");
    matrix.print(currentTemp);
    matrix.print("F  ");
  }
  
  matrix.endText(SCROLL_LEFT);
  matrix.endDraw();
}
