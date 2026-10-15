# location — Location and addresses

Where the device is (GPS, Wi-Fi), turning addresses into coordinates and
back, and map images. The first use asks for permission.

```python
import location

location.start_updates()
here = location.get_location()
location.stop_updates()
if here:
    print(here["latitude"], here["longitude"])
    print(location.reverse_geocode(here)[0].get("City"))
```

## Functions

### location.start_updates()

Start getting location updates; asks for permission the first time.

### location.stop_updates()

Stop getting updates (they also stop when the next program starts).

### location.get_location()

The latest location as a dict, or None: `latitude`, `longitude`,
`altitude` (meters), `timestamp` (seconds since 1970), `horizontal_accuracy`
and `vertical_accuracy` (meters), `speed` (m/s) and `course` (degrees). It
waits a few seconds for a first fix after `start_updates()`.

### location.is_authorized()

Whether the app may use the location.

### location.geocode(address)

Coordinates for an address, a string or a dict like
`{'Street': 'Infinite Loop 1', 'City': 'Cupertino', 'Country': 'USA'}`.
Returns a list of dicts with `latitude` and `longitude` (empty if nothing
was found). Needs the network.

### location.reverse_geocode(location)

Addresses for a dict with `latitude` and `longitude`: a list of dicts with
`Name`, `Street`, `City`, `State`, `ZIP`, `Country`, `CountryCode` and more.
Needs the network.

### location.render_map_snapshot(lat, lng, width=1000, height=1000, map_type='standard', show_poi=True, img_width=240, img_height=240, img_scale=0, raw_data=False)

A map image around `lat`/`lng`, as a PIL image (`raw_data=True` gives PNG
bytes). `width` and `height` are the region in meters; `map_type` is
`'standard'`, `'satellite'` or `'hybrid'`. Put it in a `ui.Image` to show it.
