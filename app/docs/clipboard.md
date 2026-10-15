# clipboard — Copy and paste

The system clipboard (pasteboard), shared with every other app.

```python
import clipboard

text = clipboard.get()
clipboard.set(text.upper())
```

Reading what another app copied may show the system's "Allow Paste"
question.

## Functions

### clipboard.get()

The clipboard's text, or `""` if it has none.

### clipboard.set(string)

Put text on the clipboard.

### clipboard.get_image(idx=0)

An image from the clipboard as a PIL image, or None. If several images were
copied, `idx` picks one.

### clipboard.set_image(image, format='png', jpeg_quality=0.75)

Put an image on the clipboard: a PIL image, image bytes or the path of an
image file. `format` is `'png'` or `'jpeg'` (with `jpeg_quality` from 0.0 to
1.0).
