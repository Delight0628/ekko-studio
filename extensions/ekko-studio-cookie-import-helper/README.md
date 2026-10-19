# Ekko Studio Cookie Import Helper

A Manifest V3 extension for importing selected cookies from **Chrome on the same
computer** into a specific Ekko Studio Desktop browser profile. Adapted from the
user-supplied `cloakbrowser-cookie-import-helper-v1.0.8.zip`; the attachment did not include a separate upstream license notice. Confirm redistribution
rights before publishing the extension outside this review.

## Install and use

1. Download the extension directory (or extract the distributed helper ZIP).
2. Open Chrome's Extensions page, enable Developer mode, choose **Load unpacked**,
   and select the directory containing `manifest.json`.
3. In Studio Desktop, open **Browser → Import Chrome cookies**, choose the target
   profile and generate an import code. The receiver only runs for five minutes.
4. Copy the displayed Manager address and one-time code into the extension.
5. Scan, select only the domains you need, and submit.
6. Return to Studio, review the target profile, domains and count, then confirm.
   Submission alone does not import anything. Refresh the target website afterward.

Chrome Web Store installation is not provided. The receiving Desktop feature must
be present in your Studio build; older versions and ordinary Web UI do not support it.

## Security and limitations

- Cookie permissions and access to all websites are required to enumerate domains.
  Scanning reads cookie metadata and values through Chrome's cookie API; only
  selected domains are transmitted. No passwords, passkeys or OS keychains are read.
- The extension sends only to `http://127.0.0.1:<port>`. The temporary Desktop HTTP
  listener is loopback-only, validates extension origins/Host/JSON/size, uses a
  random 256-bit one-time code, and only stages cookies in memory. Trusted main-window
  IPC confirmation is required before writing. Do not share codes or cookie values.
- Codes are not saved in extension storage. A successful submission consumes the
  code. Cancelling, leaving settings, expiry or app shutdown drops pending data.
- Matching name/domain/path cookies are overwritten; there is no automatic rollback.
  Individual write failures are counted without returning cookie values or raw errors.
- Partitioned cookies are skipped rather than silently converted to unpartitioned
  cookies. Import is limited to 1000 cookies / 1 MiB per submission.
- Cookies do not transfer localStorage, IndexedDB, device keys or passkeys. Google
  and other sites may require re-authentication. Network/proxy settings must still work.
- Cookie persistence uses Studio's existing profile cookie store. It is sensitive
  local data, not an encrypted backup or a substitute for protecting the host account.
