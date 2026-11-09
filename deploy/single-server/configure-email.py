#!/usr/bin/env python3
"""Configure a supplied sending key with the owner's approved sender/admin settings."""
import getpass
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

runtime = Path('/opt/trinitymatrix/shared/runtime.env')
existing = json.loads(subprocess.check_output([
    'docker', 'inspect', 'rummymatrix-app-1', '--format', '{{json .Config.Env}}'
], text=True))
settings = dict(value.split('=', 1) for value in existing if '=' in value)
sender = settings.get('EMAIL_FROM', '').strip()
admins = settings.get('ADMIN_EMAILS', '').strip()
if not sender or not admins:
    raise SystemExit('The approved reference sender or administrator configuration is missing.')
if '<' in sender:
    sender = 'TrinityMatrix <' + sender.split('<', 1)[1]
key = getpass.getpass('TrinityMatrix Resend sending key (hidden): ').strip()
if not re.fullmatch(r're_[A-Za-z0-9_-]+', key):
    raise SystemExit('Invalid Resend key format.')
updates = {
    'AUTH_PROVIDER': 'resend',
    'RESEND_API_KEY': key,
    'EMAIL_FROM': sender,
    'ADMIN_EMAILS': admins,
}
lines = runtime.read_text().splitlines()
for name, value in updates.items():
    if '\n' in value or '\r' in value:
        raise SystemExit('Newlines are not permitted in runtime settings.')
    encoded = json.dumps(value).replace('$', '$$')
    replacement = name + '=' + encoded
    for index, line in enumerate(lines):
        if line.startswith(name + '='):
            lines[index] = replacement
            break
    else:
        lines.append(replacement)
descriptor, temporary_name = tempfile.mkstemp(prefix='.runtime-', dir=runtime.parent)
try:
    with os.fdopen(descriptor, 'w') as stream:
        stream.write('\n'.join(lines) + '\n')
    os.chmod(temporary_name, 0o600)
    os.replace(temporary_name, runtime)
finally:
    if os.path.exists(temporary_name):
        os.unlink(temporary_name)
print('Resend sign-in configured with the approved sender and administrator allowlist. No secrets were printed.')
