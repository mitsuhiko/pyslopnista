"""Location (GPS) and geocoding.

    import location
    location.start_updates()
    print(location.get_location())
    location.stop_updates()
    print(location.reverse_geocode({"latitude": 48.8582, "longitude": 2.2945}))

The first use asks for permission.
"""

from _device import call, pil_image

__all__ = [
    "start_updates", "stop_updates", "get_location", "is_authorized", "geocode", "reverse_geocode",
    "render_map_snapshot",
]


def start_updates():
    """Start getting location updates (asks for permission the first time)."""
    call("location.start")


def stop_updates():
    """Stop getting location updates."""
    call("location.stop")


def get_location():
    """The latest location as a dict (latitude, longitude, altitude, timestamp, accuracy, ...), or None.

    Waits up to a few seconds for a first fix after start_updates().
    """
    return call("location.get")


def is_authorized():
    """Whether the app may use the location."""
    return bool(call("location.authorized"))


def geocode(address):
    """Coordinates for an address: a dict ({'Street': ..., 'City': ..., 'Country': ...}) or a string.

    Returns a list of dicts with 'latitude' and 'longitude' (empty if nothing was found).
    """
    if isinstance(address, dict):
        address = ", ".join(str(v) for v in address.values() if v)
    return call("location.geocode", address=str(address)) or []


def reverse_geocode(location):
    """Addresses for a location (a dict with 'latitude' and 'longitude'): a list of dicts."""
    return call("location.reverseGeocode", latitude=float(location["latitude"]), longitude=float(location["longitude"])) or []


def render_map_snapshot(lat, lng, width=1000, height=1000, map_type="standard", show_poi=True,
                        img_width=240, img_height=240, img_scale=0, raw_data=False):
    """A map image (PIL) around lat/lng; width/height are the region in meters.

    map_type is 'standard', 'satellite' or 'hybrid'. raw_data=True returns PNG bytes.
    """
    data = call(
        "location.snapshot", latitude=float(lat), longitude=float(lng), width=float(width), height=float(height),
        map_type=map_type, show_poi=bool(show_poi), img_width=int(img_width), img_height=int(img_height),
        img_scale=float(img_scale),
    )
    if raw_data:
        import base64

        return base64.b64decode(data)
    return pil_image(data)
