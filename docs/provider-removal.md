# Removing configured providers

The model settings card's **Delete** action removes a configured provider. Built-in
presets remain available in **Add Provider**; deleting a configured instance does
not remove the preset from Studio's catalog.

For built-ins, the card sends `DELETE /api/hermes/config/providers/:poolKey?deleteEntry=true`.
This clears the selected profile's configured environment credentials and matching
stored-auth entries, removes matching `providers`/`custom_providers` configuration,
and records the provider ID in that profile's `studio_removed_providers` list.
The catalog respects this list even when an OAuth grant could otherwise be inherited
from the default profile. No other profile's files are edited. Removing credentials
from the default profile can affect profiles that inherited those credentials.

The editor's **Clear credentials** action remains separate. Legacy DELETE callers
that omit `deleteEntry=true` retain their existing clear-credentials behavior.
Copilot continues to use its existing opt-in disable operation and external-login
warnings; Studio does not delete VS Code or GitHub CLI login files.

Adding an API-key provider again clears its removal marker. After a successful
OAuth login from Add Provider, the client calls the authenticated admin endpoint
`POST /api/hermes/config/providers/:poolKey/restore` in the selected profile.
This clears only the removal marker; it neither supplies credentials nor bypasses
normal catalog authorization checks.
