"""Render and send owner health cards using UTF-8 JSON, never shell-built message text."""
import argparse
import json
from pathlib import Path
import re
import subprocess


def clean(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError('Card fields must contain text')
    if '\ufffd' in value or re.search(r'\\+(?:n|r|u[0-9a-fA-F]{4})', value) or value.lstrip().startswith('$'):
        raise ValueError('Malformed escaped text; supply decoded Unicode and actual newlines')
    return value.strip()


def build(data):
    state = data['state']
    if state not in ('warning', 'error', 'recovered', 'info'):
        raise ValueError('Unknown health state')
    colors = {'warning': 'orange', 'error': 'red', 'recovered': 'green', 'info': 'blue'}
    fields = {name: clean(data[name]) for name in ('title', 'observed_at', 'impact', 'action', 'evidence')}
    details = fields['evidence']
    if data.get('previous_message_id'):
        previous = data['previous_message_id']
        if not re.fullmatch(r'om_[A-Za-z0-9]+', previous):
            raise ValueError('Invalid previous message identity')
        details += '\n原提示：' + previous
    return {'schema': '2.0', 'config': {'width_mode': 'default', 'enable_forward': False,
            'summary': {'content': fields['title']}},
        'header': {'template': colors[state], 'title': {'tag': 'plain_text', 'content': fields['title']},
                   'subtitle': {'tag': 'plain_text', 'content': '个人中台 · ' + fields['observed_at']}},
        'body': {'direction': 'vertical', 'padding': '12px', 'vertical_spacing': '12px', 'elements': [
            {'tag': 'markdown', 'content': '**影响**\n' + fields['impact']},
            {'tag': 'markdown', 'content': '**下一步**\n' + fields['action']},
            {'tag': 'collapsible_panel', 'expanded': False,
             'header': {'title': {'tag': 'plain_text', 'content': '查看证据与处理记录'}},
             'elements': [{'tag': 'markdown', 'content': details}]},
        ]}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--cli')
    parser.add_argument('--chat-id')
    parser.add_argument('--idempotency-key')
    args = parser.parse_args()
    card = build(json.loads(args.input.read_text(encoding='utf-8-sig')))
    payload = json.dumps(card, ensure_ascii=False)
    args.output.write_text(payload, encoding='utf-8')
    if not args.cli:
        return
    if not args.chat_id or not args.idempotency_key:
        parser.error('Sending requires --chat-id and --idempotency-key')
    result = subprocess.run([args.cli, 'im', '+messages-send', '--as', 'bot', '--chat-id', args.chat_id,
        '--msg-type', 'interactive', '--content', payload, '--idempotency-key', args.idempotency_key],
        capture_output=True, encoding='utf-8', check=True)
    receipt = json.loads(result.stdout)
    if not receipt.get('ok'):
        raise RuntimeError('Card delivery did not succeed')
    args.output.with_suffix('.receipt.json').write_text(json.dumps(receipt, ensure_ascii=False), encoding='utf-8')
    print(json.dumps({'ok': True, 'data': receipt.get('data')}))


if __name__ == '__main__':
    main()
