"""The photo library: pick, take, read, add and edit photos.

    import photos
    asset = photos.pick_asset(title="Pick a photo")
    if asset:
        img = asset.get_image()          # a PIL image
        print(img.size)
    img = photos.capture_image()         # the camera (None in the simulator)

Reading the library asks for permission the first time; pick_image() and
save_image() work without it.
"""

import base64
import io

from _device import call, file_ref, image_payload, parse_datetime, pil_image

__all__ = [
    "Asset", "AssetCollection", "capture_image", "get_assets", "get_asset_with_local_id", "get_albums",
    "get_smart_albums", "get_moments", "get_favorites_album", "get_recently_added_album", "get_selfies_album",
    "get_screenshots_album", "batch_delete", "batch_revert", "create_album", "create_image_asset", "pick_asset",
    "pick_image", "save_image", "get_count", "get_image",
]


class Asset:
    """A photo or video in the library (metadata; get_image() fetches the pixels)."""

    def __init__(self, info):
        self._info = info

    def __repr__(self):
        return f"<photos.Asset {self.local_id} {self.media_type} {self.pixel_width}x{self.pixel_height}>"

    def __eq__(self, other):
        return isinstance(other, Asset) and other.local_id == self.local_id

    def __hash__(self):
        return hash(self.local_id)

    local_id = property(lambda self: self._info["local_id"])
    pixel_width = property(lambda self: self._info["pixel_width"])
    pixel_height = property(lambda self: self._info["pixel_height"])
    media_type = property(lambda self: self._info["media_type"])
    media_subtypes = property(lambda self: list(self._info["media_subtypes"]))
    duration = property(lambda self: self._info["duration"])
    can_edit_content = property(lambda self: self._info["can_edit_content"])
    can_edit_properties = property(lambda self: self._info["can_edit_properties"])
    can_delete = property(lambda self: self._info["can_delete"])
    modification_date = property(lambda self: parse_datetime(self._info["modification_date"]))

    def _set(self, **changes):
        self._info = call("photos.setProperties", id=self.local_id, **changes)

    creation_date = property(lambda self: parse_datetime(self._info["creation_date"]),
                             lambda self, v: self._set(creation_date=v))
    hidden = property(lambda self: self._info["hidden"], lambda self, v: self._set(hidden=bool(v)))
    favorite = property(lambda self: self._info["favorite"], lambda self, v: self._set(favorite=bool(v)))
    location = property(lambda self: self._info["location"], lambda self, v: self._set(location=v))

    def _data(self, original=False, size=None, crop=False, decodable=True):
        # decodable: formats Pillow can't open (HEIC) come as JPEG.
        return call("photos.image", id=self.local_id, original=bool(original), decodable=decodable,
                    size=None if size is None else [float(size[0]), float(size[1])], crop=bool(crop))

    def get_image(self, original=False):
        """The image as a PIL image (the edited version unless original=True)."""
        return pil_image(self._data(original)["data"])

    def get_image_data(self, original=False):
        """The image file's bytes as io.BytesIO; its .uti attribute tells the format (e.g. 'public.jpeg')."""
        reply = self._data(original, decodable=False)
        data = io.BytesIO(base64.b64decode(reply["data"]))
        data.uti = reply["uti"]
        return data

    def get_ui_image(self, size=None, crop=False):
        """A (smaller, with size=(w, h)) version of the image as a PIL image, e.g. for thumbnails."""
        return pil_image(self._data(False, size, crop)["data"])

    def edit_content(self, jpeg_path):
        """Replace the photo with an edited JPEG file (the Photos app can revert it)."""
        self._info = call("photos.editContent", id=self.local_id, file=file_ref(jpeg_path))

    def delete(self):
        """Delete the photo (the system asks to confirm)."""
        batch_delete([self])

    def revert(self):
        """Undo all edits."""
        batch_revert([self])


class AssetCollection:
    """An album, a smart album (Favorites, Screenshots, ...) or a moment."""

    def __init__(self, info):
        self._info = info

    def __repr__(self):
        return f"<photos.AssetCollection {self.title!r} ({self.type})>"

    local_id = property(lambda self: self._info["local_id"])
    type = property(lambda self: self._info["type"])
    subtype = property(lambda self: self._info["subtype"])
    start_date = property(lambda self: parse_datetime(self._info.get("start_date")))
    end_date = property(lambda self: parse_datetime(self._info.get("end_date")))
    can_delete = property(lambda self: self._info["can_delete"])
    can_add_assets = property(lambda self: self._info["can_add_assets"])
    can_remove_assets = property(lambda self: self._info["can_remove_assets"])
    can_rename = property(lambda self: self._info["can_rename"])

    @property
    def title(self):
        return self._info["title"]

    @title.setter
    def title(self, value):
        self._info = call("photos.collection.rename", id=self.local_id, title=str(value))

    @property
    def assets(self):
        """The assets in it, oldest first."""
        return [Asset(a) for a in call("photos.assets", collection=self.local_id)]

    def add_assets(self, assets):
        call("photos.collection.add", id=self.local_id, assets=[a.local_id for a in assets])

    def remove_assets(self, assets):
        call("photos.collection.remove", id=self.local_id, assets=[a.local_id for a in assets])

    def delete(self):
        """Delete the album (its photos stay in the library)."""
        call("photos.collection.delete", id=self.local_id)


def capture_image(camera="rear"):
    """Take a photo with the camera; a PIL image, or None if cancelled or there is no camera."""
    data = call("photos.capture", camera=camera)
    return None if data is None else pil_image(data)


def get_assets(media_type="image", include_hidden=False):
    """All assets of a media type ('image' or 'video'), oldest first."""
    return [Asset(a) for a in call("photos.assets", media_type=media_type, include_hidden=bool(include_hidden))]


def get_asset_with_local_id(local_id):
    """The asset with this local_id (raises IOError if there is none)."""
    return Asset(call("photos.asset", id=str(local_id)))


def _collections(kind):
    return [AssetCollection(c) for c in call("photos.collections", kind=kind)]


def get_albums():
    """The user's albums."""
    return _collections("albums")


def get_smart_albums():
    """The smart albums (Favorites, Recents, Screenshots, Selfies, ...)."""
    return _collections("smart")


def get_moments():
    """Moments are no longer part of the photo library; always []."""
    return []


def _special(name):
    found = _collections(name)
    return found[0] if found else None


def get_favorites_album():
    return _special("favorites")


def get_recently_added_album():
    return _special("recently_added")


def get_selfies_album():
    return _special("selfies")


def get_screenshots_album():
    return _special("screenshots")


def batch_delete(assets):
    """Delete several assets with one confirmation."""
    call("photos.delete", ids=[a.local_id for a in assets])


def batch_revert(assets):
    """Revert several assets' edits."""
    call("photos.revert", ids=[a.local_id for a in assets])


def create_album(title):
    """A new album."""
    return AssetCollection(call("photos.createAlbum", title=str(title)))


def create_image_asset(image_path):
    """Add an image file (JPEG, PNG, HEIC, GIF) to the library; returns its Asset."""
    return Asset(call("photos.createAsset", file=file_ref(image_path)))


def pick_asset(assets=None, title="", multi=False):
    """Pick from a grid of thumbnails (the given assets or collection, else the whole library).

    Returns an Asset (a list with multi=True), or None if cancelled.
    """
    if isinstance(assets, AssetCollection):
        ids = [a.local_id for a in assets.assets]
    elif assets is not None:
        ids = [a.local_id for a in assets]
    else:
        ids = None
    picked = call("photos.pick", ids=ids, title=str(title), multi=bool(multi))
    if picked is None:
        return None
    chosen = [Asset(a) for a in picked]
    return chosen if multi else (chosen[0] if chosen else None)


def pick_image(show_albums=False, include_metadata=False, original=True, raw_data=False, multi=False):
    """The system photo picker (no library permission needed); PIL image(s) or None.

    raw_data=True returns the image files' bytes instead.
    """
    picked = call("photos.pickImage", multi=bool(multi))
    if not picked:
        return None
    images = [base64.b64decode(p) if raw_data else pil_image(p) for p in picked]
    return images if multi else images[0]


def save_image(image):
    """Save an image (PIL image, bytes or a file path) to the library; True when saved."""
    call("photos.save", data=image_payload(image))
    return True


def get_count():
    """The number of images in the library."""
    return len(get_assets())


def get_image(image_index=-1, original=True, raw_data=False):
    """An image from the library by index (-1 is the newest)."""
    asset = get_assets()[image_index]
    return asset.get_image_data(original).getvalue() if raw_data else asset.get_image(original)
