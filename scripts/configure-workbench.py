"""Configure the native owner Source through the existing local management API."""
import argparse
import json
import urllib.request


def configure(port, owner):
    owner = owner.strip()
    if not 1 <= port <= 65535 or not owner.strip() or len(owner) > 200:
        raise ValueError('Supply a local port and a stable owner label (1-200 characters)')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(path, body=None):
        request = urllib.request.Request(f'http://127.0.0.1:{port}/orchestrator/api/{path}',
            data=None if body is None else json.dumps(body).encode('utf-8'),
            headers={'x-orchestrator-request': '1', 'content-type': 'application/json'},
            method='GET' if body is None else 'PUT')
        with opener.open(request, timeout=15) as response:
            return json.load(response)

    settings = call('settings')
    source = next((row for row in settings['sources'] if row['id'] == 'workbench'), None)
    if source is None:
        raise ValueError('Enable the dsh-superagent-workbench plugin and restart this profile first')
    config = source['value']['config']
    if config.get('ownerId') and config['ownerId'] != owner:
        raise ValueError('This workbench already belongs to another owner label; configuration was not changed')
    call('settings/source:workbench', {'revision': source['revision'],
        'value': {'enabled': True, 'config': {**config, 'ownerId': owner}}})
    # Re-read the revision instead of overwriting concurrent Policy edits.
    policy = call('settings')['blocks']['policy']
    value = policy['value']
    part = value['sources'].get('workbench', {'allowed': [], 'admission': {}})
    allowed = part['allowed']
    if not any(person['id'] == owner for person in allowed):
        allowed = [*allowed, {'id': owner}]
    call('settings/policy', {'revision': policy['revision'], 'value': {**value,
        'sources': {**value['sources'], 'workbench': {**part, 'allowed': allowed}}}})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=3082)
    parser.add_argument('--owner', required=True, help='Stable local owner label, not an access token')
    args = parser.parse_args()
    configure(args.port, args.owner)
    print('Native workbench configured. Open #main-conversation in the authenticated DSH browser.')
