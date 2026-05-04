import unittest
from netgauge import (
    calculate_usability,
    calculate_persistence,
    calculate_variability,
    calculate_resilience,
    RTT_Threshold,
    TimeWindow,
)

#python -m unittest repos.unittesting_netgauge -v

class TestUsability(unittest.TestCase):
    def test_loss_preferred_over_ping(self):
        # Loss should win even when ping suggests a different answer
        self.assertEqual(calculate_usability({"loss_pct": 5.0, "ping_ms": 9999}), 95.0)

    def test_zero_loss(self):
        self.assertEqual(calculate_usability({"loss_pct": 0.0}), 100.0)

    def test_full_loss(self):
        self.assertEqual(calculate_usability({"loss_pct": 100.0}), 0.0)

    def test_loss_clamped_high(self):
        self.assertEqual(calculate_usability({"loss_pct": 150.0}), 0.0)

    def test_loss_clamped_low(self):
        self.assertEqual(calculate_usability({"loss_pct": -10.0}), 100.0)

    def test_ping_fallback_good(self):
        self.assertEqual(calculate_usability({"ping_ms": 80.0}), 100.0)

    def test_ping_fallback_at_threshold(self):
        self.assertEqual(calculate_usability({"ping_ms": RTT_Threshold}), 100.0)

    def test_ping_fallback_bad(self):
        self.assertEqual(calculate_usability({"ping_ms": 150.0}), 0.0)

    def test_returns_none_when_empty(self):
        self.assertIsNone(calculate_usability({}))

    def test_returns_none_for_unparseable(self):
        self.assertIsNone(calculate_usability({"loss_pct": "abc", "ping_ms": "xyz"}))

    def test_string_inputs_parsed(self):
        self.assertEqual(calculate_usability({"loss_pct": "5.0"}), 95.0)


class TestPersistence(unittest.TestCase):
    def test_zero_ping_full_window(self):
        self.assertEqual(calculate_persistence({"ping_ms": 0.0}), TimeWindow)

    def test_half_threshold(self):
        self.assertEqual(calculate_persistence({"ping_ms": 50.0}), 30.0)

    def test_at_threshold_zero(self):
        self.assertEqual(calculate_persistence({"ping_ms": RTT_Threshold}), 0.0)

    def test_above_threshold_clamped(self):
        self.assertEqual(calculate_persistence({"ping_ms": 150.0}), 0.0)

    def test_returns_none_when_missing(self):
        self.assertIsNone(calculate_persistence({}))

    def test_returns_none_for_unparseable(self):
        self.assertIsNone(calculate_persistence({"ping_ms": "abc"}))


class TestVariability(unittest.TestCase):
    def test_typical_case(self):
        self.assertEqual(calculate_variability({"ping_ms": 50.0, "jitter_ms": 10.0}), 12.0)

    def test_no_jitter(self):
        self.assertEqual(calculate_variability({"ping_ms": 50.0, "jitter_ms": 0.0}), 0.0)

    def test_jitter_equals_ping(self):
        self.assertEqual(calculate_variability({"ping_ms": 50.0, "jitter_ms": 50.0}), TimeWindow)

    def test_can_exceed_window(self):
        self.assertGreater(calculate_variability({"ping_ms": 10.0, "jitter_ms": 50.0}), TimeWindow)

    def test_returns_none_when_ping_zero(self):
        self.assertIsNone(calculate_variability({"ping_ms": 0.0, "jitter_ms": 5.0}))

    def test_returns_none_when_ping_missing(self):
        self.assertIsNone(calculate_variability({"jitter_ms": 5.0}))

    def test_returns_none_when_jitter_missing(self):
        self.assertIsNone(calculate_variability({"ping_ms": 50.0}))


class TestResilience(unittest.TestCase):
    def test_zero_loss(self):
        self.assertEqual(calculate_resilience({"loss_pct": 0.0}), 0.0)

    def test_half_loss(self):
        self.assertEqual(calculate_resilience({"loss_pct": 50.0}), 12.0)

    def test_full_loss(self):
        self.assertEqual(calculate_resilience({"loss_pct": 100.0}), 24.0)

    def test_loss_clamped_high(self):
        self.assertEqual(calculate_resilience({"loss_pct": 200.0}), 24.0)

    def test_loss_clamped_low(self):
        self.assertEqual(calculate_resilience({"loss_pct": -10.0}), 0.0)

    def test_returns_none_when_missing(self):
        self.assertIsNone(calculate_resilience({}))

if __name__ == "__main__":
    unittest.main()
