# Reference: Open-Source Licensing and Compliance

AutoDoc is licensed under the permissive **MIT License**.

---

## License Compliance Policy

AutoDoc enforces a zero-copyleft policy to permit unrestricted personal, academic, and commercial use.

### Permitted Licenses
The following open-source licenses are explicitly approved in `.cargo-deny.toml` and root `package.json`:
- `MIT`
- `Apache-2.0` (with LLVM Exception)
- `BSD-2-Clause` / `BSD-3-Clause`
- `ISC`
- `0BSD`
- `CC0-1.0`
- `Unlicense`
- `Python-2.0`
- `BlueOak-1.0.0`
- `CC-BY-3.0`
- `Zlib`

### Prohibited Licenses
The following license families are strictly banned across all crates and packages:
- `GPL-1.0` / `GPL-2.0` / `GPL-3.0`
- `AGPL-1.0` / `AGPL-3.0`
- `LGPL-2.0` / `LGPL-2.1` / `LGPL-3.0`
- `SSPL`
- Any license containing non-commercial or source-disclosure requirements.

---

## Automated CI Verification

Licensing gates run on every pull request and local build:

```bash
# Check Rust crate dependency licenses
cargo-deny --config .cargo-deny.toml check licenses bans

# Check Node.js npm dependency licenses
npm run check:licenses
```
