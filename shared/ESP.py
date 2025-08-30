# main.py
from machine import Pin
import time

# Assuming you have a built-in LED on GPIO 2 (common for ESP32)
led = Pin(2, Pin.OUT)

print("Starting blink loop...")

while True:
    led.on()
    time.sleep(0.5)
    led.off()
    time.sleep(0.5)