"""Text to speech, and speech recognition from audio files.

    import speech, time
    speech.say("Hello World", "en-US")
    while speech.is_speaking():
        time.sleep(0.1)
"""

from _device import call, file_ref

__all__ = ["say", "stop", "is_speaking", "get_synthesis_languages", "get_recognition_languages", "recognize"]


def say(text, language=None, rate=0.5):
    """Speak text (returns right away); language like 'en-US', rate 0.0 (slow) to 1.0 (fast)."""
    call("speech.say", text=str(text), language=language, rate=max(0.0, min(1.0, float(rate))))


def stop():
    """Stop speaking."""
    call("speech.stop")


def is_speaking():
    """Whether speech is still going."""
    return bool(call("speech.speaking"))


def get_synthesis_languages():
    """The languages say() can speak."""
    return call("speech.languages") or []


def get_recognition_languages():
    """The languages recognize() understands."""
    return call("speech.recognitionLanguages") or []


def recognize(file_path, language=None):
    """Transcribe speech in an audio file (up to about a minute).

    Returns a list of (text, segments) by confidence; segments are dicts with
    'text', 'timestamp', 'duration' and 'confidence'. Asks for permission the
    first time; raises RuntimeError if recognition fails.
    """
    results = call("speech.recognize", file=file_ref(file_path), language=language)
    return [(r["text"], r["segments"]) for r in results]
