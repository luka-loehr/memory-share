# @memory-share/ffmpeg-darwin-x64

Static `ffmpeg` and `ffprobe` for `darwin-x64`, installed as an optional
dependency of the memory-share CLI and resolved from `node_modules` at runtime.

`bin/` is empty in the repository. Populate it before publishing:

```bash
bun run packages/cli/scripts/vendor-ffmpeg.ts --platform darwin-x64
```

The binaries deliberately live inside this package directory rather than in a
cache under `$HOME`, so that uninstalling the CLI removes them too.

ffmpeg is GPL-licensed; these are unmodified upstream static builds. See
`bin/LICENSE` after vendoring.
