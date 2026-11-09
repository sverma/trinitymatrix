# License and source notices

Copyright (C) 2026 TrinityMatrix contributors.

Project-owned source code, tests, documentation, and deployment templates are
licensed under the GNU Affero General Public License version 3 only
(`AGPL-3.0-only`), as reproduced in [LICENSE](LICENSE). Existing copyright
notices and third-party licenses remain in effect. This notice does not claim
ownership of third-party material or change its license.

## Source provenance

TrinityMatrix was adapted from the owner's RummyMatrix web application. The
shared TypeScript architecture, authentication, networking, administration,
and persistence were used as the implementation reference. The Trinity meld
rules and declaration scoring are implemented in `packages/game-domain`.

The RummyMatrix provenance record identifies these earlier references:

- `rummymatrix/testweb` at `b23524ea7b196a63108e6162ef353751495a59c7`:
  landing artwork and progressive-login concepts.
- `rummymatrix/client` at `3a2f35e`: card/table artwork and gameplay concepts.
- `rummymatrix/rummycommon` at `cde4a941fecf8abf32bfae06b8b9ffc132fa277f`:
  deck, meld, and event-domain concepts.
- `rummymatrix/rummyengine` at `ce06dc0`: lifecycle and timeout concepts.

## Artwork and names

On 9 November 2026, the project owner confirmed redistribution rights for the
inherited playing-card images, landing artwork, and table background. These
bundled project assets are included in the project's AGPL-3.0-only release.
See [asset provenance](docs/ASSET_PROVENANCE.md) for their recorded origins.

The Trinity SVG mark and card-back design were created for this project; their
editable sources are included in `apps/web/public/assets/`. Software licensing
does not grant permission to impersonate the official hosted service or claim
endorsement through its name or branding. No additional restriction is imposed
on the rights granted for the AGPL-covered code.

## Dependencies

Third-party packages retain their own licenses. `package-lock.json` records
the exact dependencies; distributions must preserve applicable dependency
copyright and license notices. Containers also include components such as
Node.js and Alpine Linux under their respective licenses. The root AGPL
license does not relicense these components.

## Corresponding source

For releases and hosted modifications, retain the source matching the running
version, package lockfile, build instructions, migrations, and installation
scripts needed to build and run it. Example configuration can be published;
credentials, private keys, and player data must remain outside the repository.
