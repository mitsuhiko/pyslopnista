# sound — Sound effects, music and recording

Play short sound effects for games and feedback, play audio files, and
record from the microphone.

```python
import sound

sound.play_effect("coin")                # a built-in effect
player = sound.Player("song.mp3")        # a file in the program's folder
player.play()
```

Sounds respect the ring/silent switch unless you call
`set_honors_silent_switch(False)`. Everything stops when the next program
starts.

## Effects

The built-in effects are synthesized: `beep`, `click`, `coin`, `ding`,
`error`, `explosion`, `hit`, `jump`, `laser`, `pop`, `powerup` and `tick`
(the names are in `sound.EFFECTS`). Any audio file works too.

### sound.play_effect(name, volume=None, pitch=1.0, pan=0.0, looping=False)

Play a sound effect (a built-in name or a file path) and return at once
with an `Effect`. `pitch` is the playback speed (0.5 to 2.0), `pan` the
stereo position (-1 left to 1 right).

### sound.stop_effect(effect)

Stop a playing effect.

### sound.stop_all_effects()

Stop all playing effects.

### sound.set_volume(vol)

The volume for effects played from now on, 0.0 to 1.0 (default 0.5).

### sound.set_honors_silent_switch(flag)

Whether sounds stay quiet when the device is set to silent (default True).

### class sound.Effect

A playing effect, returned by `play_effect()`. Change it while it plays:

#### sound.Effect.stop()

Stop it.

#### sound.Effect.volume

Its volume, 0.0 to 1.0.

#### sound.Effect.pitch

Its playback speed.

#### sound.Effect.pan

Its stereo position.

#### sound.Effect.looping

Whether it repeats until stopped.

## Playing audio files

### class sound.Player(file_path)

Plays an audio file (MP3, M4A, WAV, AIFF, ...): for music and longer
sounds.

#### sound.Player.play()

Start (or continue) playing.

#### sound.Player.pause()

Stop playing, keeping the position.

#### sound.Player.stop()

Stop playing and go back to the start.

#### sound.Player.current_time

The position in seconds (can be set).

#### sound.Player.duration

The length in seconds.

#### sound.Player.playing

Whether it is playing.

#### sound.Player.number_of_loops

How often it repeats after playing once; -1 repeats forever.

#### sound.Player.volume

The volume, 0.0 to 1.0.

#### sound.Player.pan

The stereo position, -1 to 1.

#### sound.Player.finished_handler

A function called (without arguments) when playback reaches the end.

## Recording

### class sound.Recorder(file_path)

Records from the microphone into a file in the program's folder: `.m4a`
(small) or `.wav` (raw samples, e.g. for the `wave` module). Asks for
permission the first time.

```python
rec = sound.Recorder("memo.m4a")
rec.record(5)        # five seconds
```

#### sound.Recorder.record(duration=None)

Start, or resume after `pause()`. With a `duration` in seconds it stops by
itself.

#### sound.Recorder.pause()

Pause; `record()` continues.

#### sound.Recorder.stop()

Stop and finish the file.

#### sound.Recorder.current_time

How long the recording is so far, in seconds.

#### sound.Recorder.recording

Whether it is recording.

#### sound.Recorder.meters

The loudness right now: `{'average': (left, right), 'peak': (left, right)}`
in decibels (0 is the loudest).

## MIDI

### class sound.MIDIPlayer(file_path, sound_bank_path=None)

Plays a MIDI file (`.mid`) with the system's instruments, or a `.sf2` sound
bank.

#### sound.MIDIPlayer.play()

Start playing.

#### sound.MIDIPlayer.stop()

Stop playing.

#### sound.MIDIPlayer.current_time

The position in seconds (can be set).

#### sound.MIDIPlayer.duration

The length in seconds.

#### sound.MIDIPlayer.rate

The playback speed (1.0 is normal).
