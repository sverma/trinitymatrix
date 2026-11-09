# Community release

Public GitHub repository: [sverma/trinitymatrix](https://github.com/sverma/trinitymatrix).
License selected: `AGPL-3.0-only`, matching the choice that modified hosted
forks must offer corresponding source to their users under section 13.
The owner approved public publication of the prepared code and artwork on
9 November 2026. The initial release is licensed under AGPL-3.0-only.

## Prepared locally

- Verbatim AGPL-3.0 text in `LICENSE`, with source provenance and scope in `NOTICE.md`.
- Consistent SPDX license metadata for the root and workspace packages.
- Contributor guidance, community conduct, and private security-reporting instructions.
- Ignore rules for private runtime configuration, keys, database dumps, AWS
  configuration, Terraform state/plans, and the local VPS operations record.
- A clean Linux-capable package lockfile and local setup instructions.
- Owner-confirmed redistribution rights for the inherited artwork, recorded
  on 9 November 2026 in `ASSET_PROVENANCE.md`.
- A source candidate assembled from Git's non-ignored file list. Gitleaks
  8.30.1 scanned the 231-file candidate with its default rules and reported
  zero findings on 9 November 2026. The scan used redacted output and did not
  upload source to a scanning service. This scan preceded the initial Git commit.
- Package/license metadata and GitHub workflow YAML validated. The workflow
  now provisions the PostgreSQL service required by the browser tests.
- Hosted-service Terms distinguish the AGPL source rights from use of the
  official game service. Policy-page regression tests pass.
- The container includes `LICENSE` and `NOTICE.md` at `/app/`.

## Release process

- Preserve source provenance and owner-confirmed redistribution permissions,
  including any original contributor agreements or third-party notices.
- Repeat the secret scan if the source candidate changes, including any new
  Git history. Automated findings are evidence, not a guarantee that no
  sensitive material exists; inspect the actual initial file list as well.
- Review the initial file list. Publish example configuration only. Keep
  `.aws`, production environment files, backups, private keys, source archives
  containing runtime data, and customer information private.
- Resolve any third-party license/notice obligations for distributed packages
  and assets; the root AGPL notice does not replace their terms.
- Keep GitHub private vulnerability reporting enabled and review contribution/issue
  settings. Visibility changes require the owner's direction.
- Run CI in the actual GitHub repository and confirm the first release can be
  built from its source archive.
- The application footer links to the public source. Operators should additionally
  identify the source revision matching their running version. Keep source,
  migrations, build files, and installation scripts aligned with that version.

## License implications

AGPL permits running, modifying, and commercially hosting the software.
For a modified version that supports remote network interaction, section 13
requires a prominent opportunity for interacting users to obtain the
corresponding source at no charge. This does not require a fork to submit a
pull request upstream, provide its production secrets, or surrender ownership
of its branding. Preserve license notices and follow the complete terms in
`LICENSE` when conveying source or binaries.
