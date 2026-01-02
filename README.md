# zero-the-robo-arm

Zero a third helping hand that I made to help you in your daily tasks it is inspired by iron man dummy robot


Zero robo arm is made from basic architecture which follows:

#For the frame I am going for wood. The wood need to be good solid 5 to 10 mm wood for base car and thin 2 to 3 mm 
wood for arm itself as we want our arm to be solid and stiff but light at the same time the material I already 
tried are sunboard too soft, cardboard to soft and the thicker wood too much heavy see the so light solid wood
is great choice from my side as i have weight money and resources issue so i dont go for 3d printing.

#For communication we can use wifi base approach esp32 or esp8266 or for bluetooth based approach we could use 
esp32 and hc05 with arduino nano or for radio frequency based with could nrf sensor with microcontroller of your choice.

#For motor driver instead of relying on readymade motor driver I go for custom motor drivers made from mosfets 
2 x z44n n-channel mosfet and 2 x ir9540n for p-channel making concept of h bridge to make motor driver for 
single motor with additional components like 2 x bc547 and 2 x AND Gates.

#Batteries,Buckconverter,motors for car as well as servos 



Right now its in work in progress 

[![wakatime](https://wakatime.com/badge/github/Ester-D-Kate/Alice_The_Robo_Arm.svg)](https://wakatime.com/badge/github/Ester-D-Kate/Alice_The_Robo_Arm)



problem 
pin 9 is being used as motorRightPin1 for PWM speed control of the right motor:

There could be several reasons why pin 9 isn't generating output:

Hardware issue with the specific pin - The pin might be damaged on your Nano board
PWM frequency conflict - The MPU6050 library or Servo library might be changing timer configurations
Pin mode not being set correctly - Although I see you're setting pinMode in setup()
Wiring problem - Loose connection or incorrect wiring to the H-bridge
Code logic issue - The controlCar() function might not be activating that pin

the problem description, here are potential reasons why pin 9 (used as motorRightPin1) isn't working:

Possible causes and solutions:
Timer conflicts with Servo library:

The Arduino Nano uses Timer1 for PWM on pins 9 and 10
The Servo library typically takes over Timer1, which can affect PWM functionality on pins 9 and 10
Your code is using 7 servos and also trying to use pin 9 for PWM, which may be causing a conflict
Checking the wiring:

Verify connections between pin 9 and your H-bridge/motor driver
Test continuity with a multimeter if available
Testing with a simpler sketch:

Try a basic sketch that just outputs PWM on pin 9 without the servo library to isolate the issue
Code logic:

Your controlCar() function has multiple conditional branches
Check if the branch that's supposed to write to motorRightPin1 is being executed
Alternative pin solutions:

If it's indeed a timer conflict, try using different PWM pins for motor control:
Arduino Nano PWM pins: 3, 5, 6, 9, 10, 11
Pins 3, 5, 6, and 11 use different timers than the Servo library
Recommended fixes:
Modify your pin assignments to avoid conflicts:

// Change this line:
const int motorRightPin1 = 9;   // Right motor direction pin 1

// To use a different PWM pin that won't conflict with Servo:
const int motorRightPin1 = 11;  // Right motor direction pin 1 (alternative PWM pin)
