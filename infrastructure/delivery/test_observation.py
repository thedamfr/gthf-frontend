import importlib.util
import pathlib
import unittest
from unittest.mock import Mock, patch

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


class TransitionObservationTests(unittest.TestCase):
    def setUp(self):
        self.clock = 0
        self.time_patch = patch.object(observation.time, 'monotonic', lambda: self.clock)
        self.time_patch.start()
        self.addCleanup(self.time_patch.stop)
        self.monitor = observation.OriginMonitor('synthetic-test-token')
        self.monitor.thread = Mock(is_alive=Mock(return_value=True))

    def sample(self, host, status):
        response = Mock(status=status)
        response.read.return_value = b'<h1>Available</h1>'
        connection = Mock()
        connection.getresponse.return_value = response
        with patch.object(observation, 'OriginConnection', return_value=connection):
            result = self.monitor.request(host, '/page', 'page')
        self.monitor.record_cycle([result])
        return result

    def test_expected_initial_cms_outage_is_timed_and_requires_new_continuous_health(self):
        self.monitor.begin_cms_transition(390)
        self.clock = 10
        self.assertTrue(self.sample('cms.gthf.fr', 503)['expected'])
        self.monitor.require_available()
        self.clock = 14
        self.sample('cms.gthf.fr', 200)
        self.monitor.end_cms_transition()
        self.assertIsNone(self.monitor.healthy_since)
        def tick(_seconds):
            self.clock += 1
            self.sample('cms.gthf.fr', 200)
        with patch.object(observation.time, 'sleep', tick):
            self.monitor.wait_for_continuous_health(60)
        proof = self.monitor.proof()
        self.assertEqual(proof['errors'], [])
        self.assertEqual(len(proof['expectedErrors']), 1)
        self.assertEqual(proof['interruptions'][0]['durationMs'], 4000)
        self.assertIsNotNone(proof['interruptions'][0]['recoveredAt'])
        self.assertEqual(proof['continuousHealthSeconds'], 60)
        self.assertGreaterEqual(self.clock, 75)

    def test_frontend_failure_during_transition_and_cms_failure_after_it_are_blocking(self):
        self.monitor.begin_cms_transition(390)
        self.assertFalse(self.sample('gthf.fr', 503)['expected'])
        with self.assertRaisesRegex(RuntimeError, 'availability failure'):
            self.monitor.require_available()
        other = observation.OriginMonitor('synthetic-test-token')
        other.thread = Mock(is_alive=Mock(return_value=True))
        self.monitor = other
        self.monitor.begin_cms_transition(390)
        self.monitor.end_cms_transition()
        self.assertFalse(self.sample('cms.gthf.fr', 503)['expected'])
        with self.assertRaisesRegex(RuntimeError, 'availability failure'):
            self.monitor.wait_for_continuous_health(60)

    def test_transition_expiry_cannot_be_hidden_by_closing_the_window(self):
        self.monitor.begin_cms_transition(20)
        self.clock = 21
        self.assertFalse(self.sample('cms.gthf.fr', 503)['expected'])
        with self.assertRaisesRegex(RuntimeError, 'exceeded'):
            self.monitor.end_cms_transition()
        self.assertEqual(self.monitor.proof()['cmsTransition']['durationSeconds'], 21)

    def test_overall_observation_deadline_still_bounds_a_stalled_health_cycle(self):
        self.clock = 601
        with self.assertRaisesRegex(RuntimeError, 'incomplete'):
            self.monitor.wait_for_continuous_health(60)
        self.assertTrue(self.monitor.proof()['expired'])
