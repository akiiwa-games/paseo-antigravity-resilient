# Third-party sources and licensing

This plugin adapts Paseo's Antigravity provider and integrates with the Paseo plugin SDK.
The upstream project is [getpaseo/paseo](https://github.com/getpaseo/paseo).
The pinned upstream license is reproduced in [LICENSE.paseo](LICENSE.paseo) and identifies
Copyright (c) 2025-present Mohamed Boudra and Apache License, Version 2.0,
except for third-party components that retain their own licenses.

The source pin and adaptation history are recorded in [docs/UPSTREAM.md](docs/UPSTREAM.md).
The repository is licensed under the Apache License, Version 2.0 ([LICENSE](LICENSE)),
including local modifications. Keep upstream notices and the applicable license text
when redistributing upstream-derived code.

Development dependencies are pinned by `package-lock.json`; their package metadata
and accompanying license files describe their respective terms. They are not bundled
in the plugin package. Antigravity (`agy`) is installed separately and is not distributed
by this repository.
