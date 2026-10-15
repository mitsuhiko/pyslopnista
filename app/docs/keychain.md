# keychain — Secure password storage

Store passwords, API keys and tokens in the iOS Keychain instead of in a
file. Items belong to this app (other apps' passwords can't be read) and are
kept apart from the app's own sign-ins.

```python
import keychain

token = keychain.get_password("github", "me")
if token is None:
    token = input("GitHub token: ")
    keychain.set_password("github", "me", token)
```

## Functions

### keychain.get_password(service, account)

The password stored for `service` and `account`, or None.

### keychain.set_password(service, account, password)

Store a password for `service` and `account`, replacing an older one.

### keychain.delete_password(service, account)

Remove the password for `service` and `account`.

### keychain.get_services()

All stored `(service, account)` pairs.

### keychain.reset_keychain()

Delete every password stored with this module.
