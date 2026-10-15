# motion — Motion sensors

The accelerometer, gyroscope and magnetometer: how the device is tilted and
moved.

```python
import motion
import time

motion.start_updates()
time.sleep(0.2)
roll, pitch, yaw = motion.get_attitude()
print(f"tilted {roll:.2f} rad sideways, {pitch:.2f} rad forward")
motion.stop_updates()
```

Call `start_updates()` first; values are zeros where there is no sensor
(the simulator). Updates stop by themselves when the next program starts.

## Functions

### motion.start_updates()

Start reading the sensors.

### motion.stop_updates()

Stop reading them (saves battery).

### motion.get_gravity()

The direction of gravity relative to the device, `(x, y, z)` in g: about
`(0, -1, 0)` when the phone stands upright, `(0, 0, -1)` lying face up.

### motion.get_user_acceleration()

How the user moves the device, `(x, y, z)` in g, without gravity.

### motion.get_attitude()

The device's orientation, `(roll, pitch, yaw)` in radians.

### motion.get_magnetic_field()

The magnetic field, `(x, y, z, accuracy)` in microtesla; `accuracy` goes from
-1 (none) to 2 (high).
