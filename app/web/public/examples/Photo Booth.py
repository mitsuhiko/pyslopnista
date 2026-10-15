# Photo Booth: take a photo or pick one, try filters, then save or share it.
#
# Uses photos (the camera and the photo library), Pillow for the filters,
# dialogs for sharing and haptics. Tap Done to close it.
import dialogs
import haptics
import photos
import ui
from PIL import ImageFilter, ImageOps


def sepia(image):
    return ImageOps.colorize(ImageOps.grayscale(image), "#2b1b0e", "#f5e3b8")


FILTERS = {
    "Original": lambda image: image,
    "Mono": lambda image: ImageOps.grayscale(image).convert("RGB"),
    "Sepia": sepia,
    "Poster": lambda image: ImageOps.posterize(image, 3),
    "Blur": lambda image: image.filter(ImageFilter.GaussianBlur(6)),
    "Sketch": lambda image: ImageOps.grayscale(image).filter(ImageFilter.CONTOUR).convert("RGB"),
    "Mirror": ImageOps.mirror,
}


def PhotoBooth():
    original = ui.signal(None)
    style = ui.signal("Original")
    result = ui.computed(lambda: None if original() is None else FILTERS[style()](original()))

    def use(image):
        if image is None:
            return
        image = ImageOps.exif_transpose(image).convert("RGB")
        image.thumbnail((1200, 1200))  # filters stay quick
        style.set("Original")
        original.set(image)
        haptics.impact("light")

    def camera():
        image = photos.capture_image()
        if image is None:
            ui.toast("No photo (the simulator has no camera)")
        use(image)

    def save():
        photos.save_image(result())
        haptics.notification("success")
        ui.toast("Saved to Photos")

    return ui.Screen(
        "Photo Booth",
        ui.Show(
            lambda: original() is not None,
            lambda: ui.VStack(
                ui.Image(result, height=360, corner_radius=14),
                ui.Picker(list(FILTERS), style, kind="menu", label="Filter"),
                ui.HStack(
                    ui.Button("Save", on_click=save, icon="square.and.arrow.down", flex=1),
                    ui.Button("Share", on_click=lambda: dialogs.share_image(result()), icon="square.and.arrow.up",
                              kind="tinted", flex=1),
                ),
                spacing=12,
            ),
            fallback=ui.Card(
                ui.HStack(ui.Spacer(), ui.Icon("camera.filters", size=48, color="secondary"), ui.Spacer()),
                ui.Text("Take a photo or pick one from your library.", text_align="center", color="secondary"),
                padding=32,
            ),
        ),
        ui.HStack(
            ui.Button("Camera", on_click=camera, icon="camera", kind="gray", flex=1),
            ui.Button("Library", on_click=lambda: use(photos.pick_image()), icon="photo.on.rectangle", kind="gray",
                      flex=1),
        ),
    )


ui.run(PhotoBooth)
