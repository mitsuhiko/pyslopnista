"""Secure password storage in the iOS Keychain.

Items are this app's own (other apps' passwords can't be read), kept apart
from the app's own credentials, and survive reinstalling a program.

    import keychain
    keychain.set_password("github", "me", "s3cret")
    keychain.get_password("github", "me")  # "s3cret"
"""

from _device import call

__all__ = ["get_password", "set_password", "delete_password", "get_services", "reset_keychain"]


def get_password(service, account):
    """The password stored for service/account, or None."""
    return call("keychain.get", service=str(service), account=str(account))


def set_password(service, account, password):
    """Store a password for service/account (replacing an old one)."""
    call("keychain.set", service=str(service), account=str(account), password=str(password))


def delete_password(service, account):
    """Remove the password for service/account."""
    call("keychain.delete", service=str(service), account=str(account))


def get_services():
    """All stored (service, account) pairs."""
    return [tuple(pair) for pair in call("keychain.services")]


def reset_keychain():
    """Delete every password stored with this module."""
    call("keychain.reset")
