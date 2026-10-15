# speech — Text to speech and speech recognition

Speak text with the system's voices, and transcribe recorded speech.

```python
import speech
import time

speech.say("Hello World", "en-US")
while speech.is_speaking():
    time.sleep(0.1)
```

## Functions

### speech.say(text, language=None, rate=0.5)

Speak `text`; returns right away. `language` is a code like `'en-US'` or
`'de-DE'` (default: the system's); `rate` goes from 0.0 (slow) to 1.0
(fast).

### speech.stop()

Stop speaking.

### speech.is_speaking()

Whether speech is still going.

### speech.get_synthesis_languages()

The languages `say()` can speak.

### speech.get_recognition_languages()

The languages `recognize()` understands.

### speech.recognize(file_path, language=None)

Transcribe the speech in an audio file of up to about a minute (record one
with [sound.Recorder](sound.html#sound.Recorder)). Returns a list of
`(text, segments)` alternatives, the most likely first; `segments` are
dicts with `'text'`, `'timestamp'`, `'duration'` and `'confidence'`. Asks
for permission the first time and may send the audio to Apple. Raises
`RuntimeError` if recognition fails.

```python
import sound
import speech
import console

rec = sound.Recorder("memo.m4a")
rec.record()
console.alert("Recording…", "", "Done", hide_cancel_button=True)
rec.stop()
print(speech.recognize("memo.m4a")[0][0])
```
