![memory-share banner](docs/assets/banner.svg)

# memory-share – Full-resolution photo and video sharing on your own Cloudflare account

[![Bun](https://img.shields.io/badge/Bun-1.4-000000?style=flat&logo=bun&logoColor=white)](https://bun.sh) [![TypeScript](https://img.shields.io/badge/TypeScript-7.0-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org) [![Next.js](https://img.shields.io/badge/Next.js-16.3-000000?style=flat&logo=nextdotjs&logoColor=white)](https://nextjs.org) [![Platform](https://img.shields.io/badge/Platform-Cloudflare%20Workers-F38020?style=flat&logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/) [![License](https://img.shields.io/badge/License-MIT-orange?style=flat)](LICENSE)

**memory-share** shares photos and videos through a link and a password, served from your own Cloudflare account. Recipients browse a gallery and can download the original files, byte for byte.

---

## Features

- **Original quality** downloads are byte-identical to what you uploaded, never recompressed
- **Asset pool and memories** upload once, then build any number of password-protected albums from tags
- **Browser-friendly viewing** via Cloudflare Images transforms for photos and local 1080p H.264 proxies for video
- **Local transcoding** with a bundled ffmpeg, so the Worker only stores and serves
- **Resumable imports** that skip finished files and continue partial transfers
- **Scoped sessions** where unlocking one memory grants nothing on another
- **No public bucket** since every byte passes through the Worker behind a password
- **One-command deploy** with `ms deploy`, which is safe to re-run

---

## Quick start

```bash
git clone https://github.com/luka-loehr/memory-share.git
cd memory-share/packages/cli && bun install && bun link   # puts `ms` on PATH

cd ../../apps/web && npm install && npx opennextjs-cloudflare build
ms deploy                                   # R2, D1, secrets, Worker

ms upload ~/Pictures/beach --tag beach
ms memory create "Summer 2024" --tag beach
#   https://memory-share.<your-subdomain>.workers.dev/m/summer-2024
#   password: harbor-cliff-meadow-anchor-ember
```

---

## Documentation

- [Self-hosting](docs/SELF-HOSTING.md) – install, deploy, configuration, import expectations, uninstall
- [Architecture](docs/ARCHITECTURE.md) – assets vs. memories, renditions, where the work happens
- [Security](docs/SECURITY.md) – what is protected, and what is not
- [Contract](docs/CONTRACT.md) – API and storage contract
- [CLI reference](packages/cli/README.md) – the `ms` command line

---

## License

MIT License - [View License](LICENSE)  
The CLI can bundle platform ffmpeg builds, which are distributed under their own licenses.

---

## Support

- [Report bugs](https://github.com/luka-loehr/memory-share/issues)  
- [luka@lukaloehr.com](mailto:luka@lukaloehr.com)  

---

Developed by [Luka Löhr](https://github.com/luka-loehr)
