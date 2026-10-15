"""Haptic feedback (the Taptic Engine).

    import haptics
    haptics.impact("heavy")
    haptics.notification("success")
"""

from _device import call

__all__ = ["impact", "notification", "selection"]


def impact(style="medium", intensity=1.0):
    """A tap: style is 'light', 'medium', 'heavy', 'soft' or 'rigid'."""
    call("haptics", kind="impact", style=style, intensity=float(intensity))


def notification(type="success"):
    """The pattern for a result: 'success', 'warning' or 'error'."""
    call("haptics", kind="notification", style=type)


def selection():
    """The light tick of a picker changing its value."""
    call("haptics", kind="selection")
