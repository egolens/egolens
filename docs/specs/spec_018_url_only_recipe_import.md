# URL-only recipe import with optional version verification

**Status**: in-progress · **Date**: 2026-09-10

The user approved removing the separate hash requirement from ordinary recipe import. This addendum supersedes only the mandatory remote-import hash requirement in spec 017. Existing landing wording, source selection, and the remaining phase boundaries still apply.

## Approved behavior

- A recipient can import a remote recipe by entering its URL alone. The app computes its semantic identity internally and checks any supplied artifact hashes, schema, and registered operators.
- Move the optional expected recipe hash into a collapsed Advanced options section. A supplied value must be valid and must match; an invalid value must never silently fall back to an unpinned import.
- A URL-only import fetches the current URL contents rather than selecting a previous recipe from the identity cache. The fetched artifact may then be cached under its computed identity.
- Existing portable-share descriptors continue to require their expected recipe hash. The sharing runtime keeps using the mandatory-pin transport API, including its version-specific cache behavior.
- Preserve selected files and recoverable import errors. Editing the URL or optional hash invalidates the previously imported recipe until it is checked again.

## Interpretation

A computed or embedded hash identifies recipe contents and detects inconsistency. It does not independently authenticate the author or prove visual correctness. An externally supplied expected hash pins executable recipe semantics; it is not a byte-for-byte file identity. URL-only imports deliberately accept the current version at that URL.

## Validation and scope

Verify URL-only import through the dialog and the existing local-data binding, optional-pin mismatch and recovery, embedded-hash rejection, refreshed URL contents despite cached versions, and unchanged mandatory pins in portable sharing. Run build, lint, and relevant transport, sharing, and import tests. New link formats, hosted samples, and deployment remain outside this change.
