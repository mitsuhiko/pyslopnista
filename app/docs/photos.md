# photos — The camera and the photo library

Take photos, let the user pick some, and read, add and edit photos in the
library. Images are PIL images (Pillow is loaded with a program that
imports `photos`).

```python
import photos

img = photos.pick_image()               # the system picker
if img:
    small = img.resize((img.width // 4, img.height // 4))
    photos.save_image(small)
```

`pick_image()`, `capture_image()` and `save_image()` need no access to the
library; the rest asks for permission the first time. On the 3.15 preview
there is no Pillow: pass `raw_data=True` or use `get_image_data()`.

## Picking, taking and saving

### photos.pick_image(show_albums=False, include_metadata=False, original=True, raw_data=False, multi=False)

The system photo picker. Returns a PIL image (a list with `multi=True`), or
None if cancelled. `raw_data=True` returns the image files' bytes.

### photos.capture_image(camera='rear')

Take a photo with the camera (`'front'` for the selfie camera); a PIL
image, or None if cancelled or there is no camera.

### photos.save_image(image)

Save an image (a PIL image, bytes or a file path) to the library.

### photos.pick_asset(assets=None, title='', multi=False)

A grid of thumbnails to pick from: the given assets or album, else the
whole library, newest first. Returns an `Asset` (a list with
`multi=True`), or None.

## The library

### photos.get_assets(media_type='image', include_hidden=False)

All assets of a type (`'image'` or `'video'`), oldest first.

### photos.get_asset_with_local_id(local_id)

The asset with this id; raises `IOError` if there is none.

### photos.get_albums()

The user's albums, as `AssetCollection` objects.

### photos.get_smart_albums()

The smart albums (Favorites, Recents, Screenshots, Selfies, ...).

### photos.get_favorites_album()

The Favorites smart album.

### photos.get_recently_added_album()

The Recently Added smart album.

### photos.get_selfies_album()

The Selfies smart album.

### photos.get_screenshots_album()

The Screenshots smart album.

### photos.get_moments()

Always an empty list: the photo library no longer has moments.

### photos.create_album(title)

A new album.

### photos.create_image_asset(image_path)

Add an image file (JPEG, PNG, HEIC, GIF) to the library; returns its
`Asset`.

### photos.batch_delete(assets)

Delete several assets, with one confirmation from the system.

### photos.batch_revert(assets)

Undo the edits of several assets.

### photos.get_count()

The number of images in the library.

### photos.get_image(image_index=-1, original=True, raw_data=False)

An image by index (-1 is the newest).

## Assets

### class photos.Asset

A photo or video in the library. It holds the metadata; `get_image()`
fetches the pixels.

#### photos.Asset.get_image(original=False)

The image as a PIL image: the edited version, or the original with
`original=True`. HEIC photos arrive as JPEG.

#### photos.Asset.get_image_data(original=False)

The image file's bytes as an `io.BytesIO`; its `uti` attribute says the
format (e.g. `'public.heic'`).

#### photos.Asset.get_ui_image(size=None, crop=False)

A smaller version for thumbnails: `size=(width, height)`; `crop=True` fills
that size exactly.

#### photos.Asset.edit_content(jpeg_path)

Replace the photo with an edited JPEG file. The Photos app can revert it.

#### photos.Asset.delete()

Delete the photo (the system asks to confirm).

#### photos.Asset.revert()

Undo all edits.

#### photos.Asset.local_id

The asset's id on this device.

#### photos.Asset.pixel_width

The width in pixels.

#### photos.Asset.pixel_height

The height in pixels.

#### photos.Asset.media_type

`'image'` or `'video'`.

#### photos.Asset.media_subtypes

E.g. `['photo_screenshot']`, `['photo_hdr']`, `['photo_live']`.

#### photos.Asset.creation_date

When it was taken (a `datetime`; can be set).

#### photos.Asset.modification_date

When it was last changed.

#### photos.Asset.favorite

Whether it is a favorite (can be set).

#### photos.Asset.hidden

Whether it is hidden (can be set).

#### photos.Asset.location

Where it was taken: a dict with `latitude`, `longitude` and `altitude`, or
None (can be set).

#### photos.Asset.duration

A video's length in seconds (0 for photos).

#### photos.Asset.can_edit_content

Whether `edit_content()` and `revert()` work.

#### photos.Asset.can_edit_properties

Whether `favorite`, `hidden`, `creation_date` and `location` can be set.

#### photos.Asset.can_delete

Whether it can be deleted.

## Albums

### class photos.AssetCollection

An album or smart album.

#### photos.AssetCollection.assets

Its assets, oldest first.

#### photos.AssetCollection.title

Its name (can be set if `can_rename`).

#### photos.AssetCollection.add_assets(assets)

Add assets to the album.

#### photos.AssetCollection.remove_assets(assets)

Take assets out of the album (they stay in the library).

#### photos.AssetCollection.delete()

Delete the album; its photos stay in the library.

#### photos.AssetCollection.local_id

The album's id on this device.

#### photos.AssetCollection.type

`'album'` or `'smart_album'`.

#### photos.AssetCollection.subtype

E.g. `'favorites'`, `'recently_added'`, `'screenshots'`, `'regular'`.

#### photos.AssetCollection.start_date

The date of its oldest asset.

#### photos.AssetCollection.end_date

The date of its newest asset.

#### photos.AssetCollection.can_delete

Whether it can be deleted.

#### photos.AssetCollection.can_add_assets

Whether `add_assets()` works.

#### photos.AssetCollection.can_remove_assets

Whether `remove_assets()` works.

#### photos.AssetCollection.can_rename

Whether its title can be changed.
