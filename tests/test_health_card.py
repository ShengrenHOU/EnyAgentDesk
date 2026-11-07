import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('health_card', Path(__file__).parents[1] / 'scripts/health-card.py')
card = importlib.util.module_from_spec(spec)
spec.loader.exec_module(card)


class HealthCardTests(unittest.TestCase):
    def data(self):
        return dict(state='warning', title='[来源级][部分异常] GitHub', observed_at='2026-11-04 18:00 北京时间',
                    impact='部分仓库暂缺 CI 状态。', action='系统继续重试。\n暂不需要你操作。', evidence='HTTP 502')

    def test_unicode_and_real_newlines_survive_json_roundtrip(self):
        result = json.loads(json.dumps(card.build(self.data()), ensure_ascii=False))
        self.assertIn('\n暂不需要', result['body']['elements'][1]['content'])
        self.assertFalse(result['body']['elements'][2]['expanded'])
        self.assertEqual(result['header']['template'], 'orange')

    def test_rejects_shell_artifacts_and_double_escaped_text(self):
        for broken in ['$提示', r'第一行\n第二行', r'\u4e2d', '\ufffd']:
            data = self.data(); data['impact'] = broken
            with self.assertRaises(ValueError): card.build(data)

    def test_recovery_keeps_original_message_reference(self):
        data = self.data(); data.update(state='recovered', previous_message_id='om_original')
        result = card.build(data)
        self.assertEqual(result['header']['template'], 'green')
        self.assertIn('om_original', result['body']['elements'][2]['elements'][0]['content'])


if __name__ == '__main__': unittest.main()
