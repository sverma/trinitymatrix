# Security policy

## Supported code

Security fixes are currently developed against the latest default-branch
source. There is no promised support period for older releases. Operators
should deploy a reviewed release and keep its dependencies current.

## Reporting a vulnerability

Use the repository's **Security → Report a vulnerability** private reporting
form at [sverma/trinitymatrix](https://github.com/sverma/trinitymatrix/security/advisories/new).
If the form is unavailable, ask the maintainer to enable it without posting technical
exploit details, credentials, or player information in a public issue.

Include the affected version, reproducible steps using a local installation,
expected and actual behavior, and the possible impact. Use synthetic accounts
and remove session cookies, tokens, OTPs, personal data, and private keys from
logs and screenshots. Do not attach production database dumps.

Maintainers will coordinate investigation, a fix, and disclosure privately.
No response-time guarantee or bug-bounty program is currently offered.

## Testing boundaries

Run security tests against an installation you control. Do not probe the
official hosted service or another operator's installation without their
permission. Avoid accessing another person's data, sending unsolicited OTP
emails, disrupting live games, or running resource-exhaustion tests on shared
infrastructure.

## Operator responsibilities

Use production email OTP and passkeys for administration. Keep mock OTP
restricted to local development. Keep secrets and player data out of source
control, configure HTTPS and exact allowed origins, isolate database/cache
services, and maintain tested backups. A public-source license does not
authorize use of credentials or access to another operator's infrastructure.
