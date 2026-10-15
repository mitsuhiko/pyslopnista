# A tour of the device modules: dialogs, speech, haptics, the clipboard,
# sound and notifications. They use Pythonista's names, so scripts written
# for it often run unchanged.
import clipboard
import console
import dialogs
import haptics
import notification
import sound
import speech
import time

choice = dialogs.list_dialog("What should we try?", [
    "Say something",
    "Copy a joke",
    "Play sounds",
    "Remind me in a minute",
])

if choice == "Say something":
    text = console.input_alert("What should I say?", input="Hello from Python!")
    speech.say(text)
    haptics.impact("light")
elif choice == "Copy a joke":
    clipboard.set("Why do Python programmers wear glasses? Because they can't C.")
    console.hud_alert("Copied! Paste it anywhere.")
elif choice == "Play sounds":
    for name in sound.EFFECTS:
        print("Playing", name)
        sound.play_effect(name)
        time.sleep(0.6)
elif choice == "Remind me in a minute":
    notification.schedule("A minute has passed.", delay=60, title="Device Tour", sound_name="default")
    console.hud_alert("Scheduled")
else:
    print("Maybe next time!")
