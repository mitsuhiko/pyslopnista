"""Copy and paste: the system clipboard (pasteboard).

    import clipboard
    clipboard.set(clipboard.get().upper())
"""

from _device import call, image_payload, pil_image

__all__ = ["get", "set", "get_image", "set_image"]


def get():
    """The clipboard's text ("" if it has none)."""
    return call("clipboard.get") or ""


def set(string):
    """Put text on the clipboard."""
    call("clipboard.set", text=str(string))


def get_image(idx=0):
    """An image from the clipboard as a PIL image, or None (idx picks one of several)."""
    return pil_image(call("clipboard.getImage", index=int(idx)))


def set_image(image, format="png", jpeg_quality=0.75):
    """Put an image (a PIL image, image bytes or a file path) on the clipboard."""
    if format not in ("png", "jpeg"):
        raise ValueError("format must be 'png' or 'jpeg'")
    call("clipboard.setImage", data=image_payload(image, format, jpeg_quality), format=format)
