# Remove payload hash verification

**Status**: implemented; build and 1,176 regression tests passed locally · **Date**: 2026-09-11

## Decision

Remove SHA-256 verification of downloaded files and chunks, including cache
admission hashing, as requested by the user. This supersedes the payload integrity
policy in spec 024. Rendering does not require this additional byte scan.

## Scope

Keep bounded LRU caching, response length/range validation, cancellation, and
transport limits. Scope shared cache entries by remote root, manifest identity,
path, and byte range. Keep catalog schema and recipe identity hashes compatible
with existing sealed recipes and hosted catalogs; their checksum fields need no
migration. Downloaded payload checksums are no longer compared.

## Validation

Check that changed same-length payloads are accepted without hashing, shared
cache roots are isolated, same-root reads are reused, and malformed transport
responses remain rejected. Run source, inventory, Worker, and regression tests.
