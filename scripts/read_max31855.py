#!/usr/bin/env python3
"""
read_max31855.py — MAX31855 thermocouple reader for Raspberry Pi
Requires: pip install adafruit-circuitpython-max31855

Wiring (SPI) for your specific MAX31855 board:
  MAX31855 3V   → 3.3V (Pi Pin 1)  [Leave Vin empty!]
  MAX31855 GND  → GND  (Pi Pin 6)
  MAX31855 CLK  → SCLK (Pi Pin 23, BCM11)
  MAX31855 CS   → GPIO 5 (Pi Pin 29, BCM5)
  MAX31855 DO   → MISO (Pi Pin 21, BCM9)

Note: If your board has Vin, you CAN use 5V there, but it is safer to just use the 3V pin to the Pi's 3.3V pin. Do not use both!
Enable SPI on Pi: sudo raspi-config → Interface Options → SPI → Enable
"""

import sys

try:
    import board
    import busio
    import digitalio
    import adafruit_max31855

    # SPI setup
    spi = busio.SPI(board.SCK, MOSI=board.MOSI, MISO=board.MISO)

    # Chip Select — using GPIO 5 (board.D5 = BCM5 = Pin 29)
    # Change board.D5 to board.CE0 if using the default CS pin
    cs = digitalio.DigitalInOut(board.D5)
    cs.direction = digitalio.Direction.OUTPUT

    thermocouple = adafruit_max31855.MAX31855(spi, cs)

    temp_c = thermocouple.temperature
    if temp_c is None:
        raise ValueError("Null reading from MAX31855")

    # Convert to Fahrenheit
    temp_f = temp_c * 9.0 / 5.0 + 32.0
    print(f"{temp_f:.1f}")
    sys.exit(0)

except ImportError:
    # Library not installed — output error for fallback
    print("ERROR: adafruit-circuitpython-max31855 not installed", file=sys.stderr)
    sys.exit(1)

except Exception as e:
    print(f"ERROR: {e}", file=sys.stderr)
    sys.exit(1)
