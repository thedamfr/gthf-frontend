import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('observation', pathlib.Path(__file__).with_name('observation.py'))
observation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observation)


class ObservationTests(unittest.TestCase):
    def test_success_requires_both_fresh_healthy_probes_and_no_relevant_alert(self):
        probes = [{'metric': {'application': name}, 'value': [0, '1']} for name in ('gthf-frontend', 'gthf-cms')]
        ages = [{**item, 'value': [0, '20']} for item in probes]
        observation.require_monitoring(probes, ages, [])
        with self.assertRaises(RuntimeError):
            observation.require_monitoring(probes, [], [])
        with self.assertRaises(RuntimeError):
            observation.require_monitoring(probes, [{**item, 'value': [0, '61']} for item in probes], [])
        with self.assertRaises(RuntimeError):
            observation.require_monitoring(probes, ages, [{'metric': {'severity': 'critical', 'namespace': 'gthf-staging'}}])
