"""Sound effects, audio playback and recording.

    import sound
    sound.play_effect("coin")            # a built-in effect
    player = sound.Player("song.mp3")    # a file in the program's folder
    player.play()
    rec = sound.Recorder("memo.m4a")
    rec.record(3)                        # three seconds from the microphone

Built-in effects: beep, click, coin, ding, error, explosion, hit, jump, laser,
pop, powerup, tick (any of them, or a file path, works with play_effect).
"""

import asyncio
import os

from _device import call, file_ref, target_ref

__all__ = [
    "play_effect", "stop_effect", "stop_all_effects", "set_volume", "set_honors_silent_switch", "Effect",
    "Player", "Recorder", "MIDIPlayer", "EFFECTS",
]

EFFECTS = ("beep", "click", "coin", "ding", "error", "explosion", "hit", "jump", "laser", "pop", "powerup", "tick")
_volume = 0.5


def _source(name):
    if isinstance(name, str) and name.lower() in EFFECTS and not os.path.exists(name):
        return {"builtin": name.lower()}
    return file_ref(name)


class Effect:
    """A playing sound effect (from play_effect): change it while it plays, or stop it."""

    def __init__(self, id, volume, pitch, pan, looping):
        self._id = id
        self._attrs = {"volume": volume, "pitch": pitch, "pan": pan, "looping": looping}

    def stop(self):
        call("sound.effect.stop", id=self._id)

    def _set(self, key, value):
        self._attrs[key] = value
        call("sound.effect.set", id=self._id, **{key: value})

    volume = property(lambda self: self._attrs["volume"], lambda self, v: self._set("volume", float(v)))
    pitch = property(lambda self: self._attrs["pitch"], lambda self, v: self._set("pitch", float(v)))
    pan = property(lambda self: self._attrs["pan"], lambda self, v: self._set("pan", float(v)))
    looping = property(lambda self: self._attrs["looping"], lambda self, v: self._set("looping", bool(v)))

    def __repr__(self):
        return f"<sound.Effect {self._id}>"


def play_effect(name, volume=None, pitch=1.0, pan=0.0, looping=False):
    """Play a sound effect (a built-in name or a file); returns at once with an Effect."""
    volume = _volume if volume is None else float(volume)
    id = call("sound.effect.play", source=_source(name), volume=volume, pitch=float(pitch), pan=float(pan),
              looping=bool(looping))
    return None if id is None else Effect(id, volume, float(pitch), float(pan), bool(looping))


def stop_effect(effect):
    """Stop a playing effect."""
    if effect is not None:
        effect.stop()


def stop_all_effects():
    """Stop all playing effects."""
    call("sound.effect.stopAll")


def set_volume(vol):
    """The volume of effects played from now on (0.0-1.0, default 0.5)."""
    global _volume
    _volume = max(0.0, min(1.0, float(vol)))


def set_honors_silent_switch(flag):
    """Whether sounds stay quiet when the ring/silent switch is on silent (default True)."""
    call("sound.silentSwitch", honors=bool(flag))


class Player:
    """Plays an audio file (mp3, m4a, wav, aiff, ...)."""

    def __init__(self, file_path):
        self._id = call("sound.player.create", source=file_ref(file_path))
        self.finished_handler = None
        self._watch = None

    def _state(self):
        return call("sound.player.state", id=self._id)

    def play(self):
        """Start playing."""
        call("sound.player.play", id=self._id)
        self._watch_finish()

    def pause(self):
        """Stop playing, keeping the position."""
        call("sound.player.pause", id=self._id)

    def stop(self):
        """Stop playing and go back to the start."""
        call("sound.player.stop", id=self._id)

    def _watch_finish(self):
        # finished_handler runs when playback ends; checked between other work.
        if self._watch is not None and not self._watch.done():
            return

        async def watch():
            while True:
                await asyncio.sleep(0.1)
                if not self._state()["playing"]:
                    break
            if callable(self.finished_handler) and self._state().get("finished"):
                self.finished_handler()

        try:
            self._watch = asyncio.get_event_loop().create_task(watch())
        except RuntimeError:
            self._watch = None

    current_time = property(lambda self: self._state()["current_time"],
                            lambda self, v: call("sound.player.set", id=self._id, current_time=float(v)))
    duration = property(lambda self: self._state()["duration"])
    playing = property(lambda self: self._state()["playing"])
    number_of_loops = property(lambda self: self._state()["number_of_loops"],
                               lambda self, v: call("sound.player.set", id=self._id, number_of_loops=int(v)))
    pan = property(lambda self: self._state()["pan"], lambda self, v: call("sound.player.set", id=self._id, pan=float(v)))
    volume = property(lambda self: self._state()["volume"],
                      lambda self, v: call("sound.player.set", id=self._id, volume=float(v)))


class Recorder:
    """Records from the microphone into a file in the program's folder (.m4a, or .wav for raw audio)."""

    def __init__(self, file_path):
        ext = os.path.splitext(str(file_path))[1].lower()
        if ext not in (".m4a", ".wav", ".caf", ".aiff"):
            raise ValueError("use a .m4a or .wav file")
        self._path = os.fspath(file_path)
        self._id = call("sound.recorder.create", target=target_ref(file_path), format=ext[1:])

    def record(self, duration=None):
        """Start (or resume) recording; with a duration, it stops by itself after that many seconds."""
        call("sound.recorder.record", id=self._id, duration=None if duration is None else float(duration))

    def pause(self):
        """Pause; record() resumes."""
        call("sound.recorder.pause", id=self._id)

    def stop(self):
        """Stop recording and finish the file."""
        call("sound.recorder.stop", id=self._id)

    current_time = property(lambda self: call("sound.recorder.state", id=self._id)["current_time"])
    recording = property(lambda self: call("sound.recorder.state", id=self._id)["recording"])

    @property
    def meters(self):
        """{'average': (left, right), 'peak': (left, right)} in decibels."""
        m = call("sound.recorder.state", id=self._id, meters=True)["meters"]
        return {"average": tuple(m["average"]), "peak": tuple(m["peak"])}


class MIDIPlayer:
    """Plays a MIDI (.mid) file, with the system's instruments or a .sf2 sound bank."""

    def __init__(self, file_path, sound_bank_path=None):
        self._id = call("sound.midi.create", source=file_ref(file_path),
                        bank=None if sound_bank_path is None else file_ref(sound_bank_path))

    def play(self):
        call("sound.midi.play", id=self._id)

    def stop(self):
        call("sound.midi.stop", id=self._id)

    current_time = property(lambda self: call("sound.midi.state", id=self._id)["current_time"],
                            lambda self, v: call("sound.midi.set", id=self._id, current_time=float(v)))
    duration = property(lambda self: call("sound.midi.state", id=self._id)["duration"])
    rate = property(lambda self: call("sound.midi.state", id=self._id)["rate"],
                    lambda self, v: call("sound.midi.set", id=self._id, rate=float(v)))
