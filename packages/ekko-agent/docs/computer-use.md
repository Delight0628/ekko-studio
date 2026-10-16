# Computer Use

Ekko includes a `computer_use` tool for native desktop applications on macOS,
Windows and Linux. It controls the machine running Ekko; connecting from a phone
or a remote browser does not give it access to that client's desktop.

In Studio, open **Ekko → Settings → Tools** to enable Computer Use, set an
optional absolute Cua Driver executable path, and adjust the operation timeout.
The tool is enabled by default and starts the driver only when called. It needs
an installed [Cua Driver](https://cua.ai/docs/cua-driver) with `mcp --direct`
support; 0.26.1 is the tested baseline. No Hermes installation is required.
Ekko never downloads a driver or changes OS grants as a side effect of a model call.

Discovery checks `tools.computerUse.driverPath`, then `EKKO_CUA_DRIVER_PATH`,
then PATH and conventional application locations. Driver installations managed
privately by Hermes are not searched. Each agent run starts the selected binary
as `cua-driver mcp --direct --no-overlay`, owning its native runtime instead of
connecting to a potentially incompatible shared daemon. On macOS, Accessibility
and Screen Recording permissions belong to the host launching Ekko (Studio or
the terminal); CuaDriver.app's separate grants are not sufficient in this mode.
Linux needs an active graphical session; Windows needs an interactive desktop.

```json
{
  "tools": {
    "computerUse": {
      "enabled": true,
      "driverPath": "",
      "timeoutMs": 30000
    }
  }
}
```

## Tool workflow

1. `computer_use({action: "status"})` checks the driver connection and reads
   permission status without raising system dialogs. Connected is not proof of
   successful capture or input.
2. `computer_use({action: "list"})` lists supported desktop operations. The list
   comes from the installed driver's MCP schema and an explicit Ekko allowlist.
3. `computer_use({action: "describe", tool: "list_windows"})` returns the exact
   argument schema. Describe each operation before calling it.
4. `computer_use({action: "call", tool: "list_windows", arguments: {}})` discovers
   native process/window IDs. Describe and call `get_window_state` for one target.
5. Use the returned `element_token` with input operations. Always supply exact
   process/window IDs or an explicit desktop target. Old snapshot tokens remain
   invalid; inspect fresh state after changes instead of reusing them.
6. Verify the requested result with `verify_state` or a fresh window observation.
   A dispatched action or `effect: unverifiable` is not success. Never blindly
   replay input after cancellation or a timeout.

The surface covers application/window discovery, window/desktop observations,
accessibility trees, screenshots and zoom, click/double/right/middle click
(middle via `click.button`), typing, keys/hotkeys, scrolling, dragging, values,
native menus, app launch, foreground activation, window geometry, cursor
movement and outcome verification, when advertised by the installed driver.
Driver configuration, grants, browser-profile attachment, installation, shell
execution, process termination and recording are not exposed through this tool.
Studio browser requests continue to use `ekko_studio_browser_toolset`.

Screenshots are forwarded as image content to vision-capable models and saved
as unique files under the workspace's `.ekko-tmp/tool-assets`. The returned
`data.screenshots` paths can be shared with the user. Text-only models use the
accessibility tree; whole-desktop image observations require vision. These
artifact files remain available after the driver exits and can be removed with
the workspace's other temporary outputs.

Input uses Ekko's existing approval service. Grants are keyed by operation and
background/foreground mode, so permission for background clicks does not cover
visible desktop or foreground control. Headless execution without an approval
handler refuses inputs when approvals are enabled. Disabling Ekko approvals
does not change Cua's standard permission mode or OS permissions.

The runtime provides a separate `computerUseSessionSignal` for each run and
aborts it on completion, failure or cancellation. One run at a time may own
the desktop in an Ekko process. Delegated agents hand desktop work to their
parent. This lease does not coordinate separate Studio processes or unrelated
automation programs. `action: "close"` explicitly releases the current run's
connection; it must rediscover schemas and capture fresh state before resuming.

Direct tool callers must supply their own `computerUseSessionSignal` and abort
it when done. A standalone `status` probe manages its own connection.

## Validation

```sh
npx vitest run tests/ekko-agent/computer-use.test.ts tests/ekko-agent/runtime.test.ts
npx playwright test tests/e2e/ekko-computer-use-settings.spec.ts
```

The MCP fixture exercises real subprocess framing, pagination, snapshot expiry,
image delivery, approval denial, controller contention, cancellation and timeout
handling. It does not prove native UI behavior on every platform. Native desktop
acceptance requires a graphical session with the host's OS grants and should
use a disposable application window.
