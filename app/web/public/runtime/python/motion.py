"""Motion sensors: accelerometer, gyroscope and magnetometer.

    import motion, time
    motion.start_updates()
    time.sleep(0.2)
    print(motion.get_attitude())  # (roll, pitch, yaw) in radians
    motion.stop_updates()

Values are (0, 0, 0) where there is no sensor (the simulator).
"""

from _device import call

__all__ = ["start_updates", "stop_updates", "get_gravity", "get_user_acceleration", "get_attitude", "get_magnetic_field"]


def start_updates():
    """Start reading the sensors (needed before the get_… functions)."""
    call("motion.start")


def stop_updates():
    """Stop reading the sensors (saves battery)."""
    call("motion.stop")


def _read():
    return call("motion.read") or {}


def get_gravity():
    """The gravity vector (x, y, z) in g."""
    return tuple(_read().get("gravity", (0.0, 0.0, 0.0)))


def get_user_acceleration():
    """The acceleration the user gives the device (x, y, z) in g, without gravity."""
    return tuple(_read().get("user_acceleration", (0.0, 0.0, 0.0)))


def get_attitude():
    """The device's orientation (roll, pitch, yaw) in radians."""
    return tuple(_read().get("attitude", (0.0, 0.0, 0.0)))


def get_magnetic_field():
    """The magnetic field (x, y, z, accuracy) in microtesla; accuracy is -1 (none) to 2 (high)."""
    return tuple(_read().get("magnetic_field", (0.0, 0.0, 0.0, -1)))
