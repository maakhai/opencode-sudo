# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project uses [Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-11-23

### Added

- Compact, state-aware sudo availability note injected into the model context,
  so agents attempt password-protected sudo instead of assuming the shell has
  no TTY.
- `hint` option: `"once"` (default), `"always"`, or `false`. `"once"` stops
  after the first sudo request in a session.

## [0.2.0] - 2026-11-10

### Added

- Framed sudo dialog with a prominent command block, metadata grid, and
  clickable footer actions.
- Password errors clear automatically when typing again.

### Changed

- README rewritten in English, streamlined, and installation instructions
  clarified.
- TUI copy translated to English.
- Password field restored to the inline masked input used by earlier builds.

## [0.1.0] - 2026-11-06

### Added

- Initial release: sudo approval modal, `SUDO_ASKPASS` shim, `on`/`ask`/`off`
  policy, in-memory cache, password validation, and output redaction.

[0.3.0]: https://github.com/maakhai/opencode-sudo/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/maakhai/opencode-sudo/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/maakhai/opencode-sudo/releases/tag/v0.1.0
