# haptics — Haptic feedback

Taps and buzzes from the Taptic Engine, to confirm an action or make a game
feel physical. Devices without one ignore them. (Pythonista doesn't have
this module.)

```python
import haptics

haptics.impact("heavy")
haptics.notification("success")
```

## Functions

### haptics.impact(style='medium', intensity=1.0)

A tap: `style` is `'light'`, `'medium'`, `'heavy'`, `'soft'` or `'rigid'`;
`intensity` from 0.0 to 1.0.

### haptics.notification(type='success')

The pattern for a result: `'success'`, `'warning'` or `'error'`.

### haptics.selection()

The light tick of a picker changing its value.
