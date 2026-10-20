# Remote Studio → Desktop browser

The browser shown by the Desktop client belongs to that computer. A remote
NAS/server cannot read its loopback broker descriptor or validate the desktop
PID. Previously the browser MCP returned an empty tool list in this setup.

## Enable

Both server and Desktop client must include this change. Connect to the remote
Studio through Desktop device management and log in. Open the browser panel,
choose **Allow remote control**, then approve the native Desktop warning that
names the remote server. The grant lasts for the connection only. Start a new
Agent turn/reconnect its browser MCP if it previously cached an empty catalog.

The browser MCP always advertises its compact catalog, even offline. Local
broker access retains its original behavior; without a local broker it calls
the authenticated Studio relay. Missing Desktop authorization reports an error,
not a silent switch to an unrelated browser.

## Security boundary

The Desktop main process issues a separate revocable broker client capability.
Broker secrets are never returned to the renderer or remote server. Only the
main Desktop renderer can ask for consent or invoke the capability. The
connection is outbound Socket.IO; no CDP/listening port is exposed on the LAN.

Relay routing requires an authenticated user and an authorized Profile. Requests
are rechecked for revoked/expired credentials. Model-run credentials must map
to an identified user through the existing HTTP authentication middleware.
Anonymous/server-token calls cannot inherit another user's desktop. More than
one matching Desktop connection fails closed instead of choosing one.

This grants **account/Profile-level** browser access, not isolation between
individual chat runs in that same Profile. The consent warning discloses this.
Agents can read logged-in pages, take screenshots and operate controls. Only
approve a trusted Studio server/account, use HTTPS on untrusted networks, and
stop sharing before another person uses that account/Profile.

Disconnect, logout, Profile switch, renderer navigation/crash or Desktop exit
revokes sharing. Reconnection does not silently restore it. The Desktop
broker's per-tab leases/takeover remain authoritative. Stop sharing also
revokes queued operations for that client. Already completed browser effects
cannot be undone by revocation.

The reverse Socket.IO transport retains the server's existing 2 MB message
limit; oversized screenshots may fail rather than changing that global bound.
No arbitrary JavaScript evaluation, filesystem path or raw broker endpoint is
accepted by the relay API.

## Validation and rollout

Automated coverage includes actual Socket.IO request/ack and user/Profile
authentication rejection, expired authorization, MCP subprocess fallback,
disconnection/late-response discard, explicit consent, and existing broker
leases/takeover. Builds cover the server/client and Desktop TypeScript.

A real Desktop + remote NAS test remains required: approve sharing, list the
visible tabs, open a harmless page, capture it, then stop sharing and verify
further calls fail. This checkout does not update or restart any installed
Desktop/NAS instance automatically.
