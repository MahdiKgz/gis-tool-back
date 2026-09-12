import unittest
from cad_warnings import CadWarnings, POLYGON_FALLBACK


class WarningPolicyTests(unittest.TestCase):
    def emit(self, policy, text, category=RuntimeWarning):
        policy.capture(text, category, "reader", 1)

    def test_polygon_fallback_is_recoverable_and_repeated_messages_are_bounded(self):
        policy = CadWarnings()
        for _ in range(1000):
            self.emit(policy, POLYGON_FALLBACK)
        self.assertFalse(policy.unsupported)
        self.assertFalse(policy.partial)
        self.assertEqual(len(policy.items), 1)
        self.assertEqual(policy.report("EPSG:32639")["warnings"][0]["occurrences"], 1000)

    def test_missing_block_is_explicitly_partial(self):
        policy = CadWarnings()
        self.emit(policy, "Block *X does not exist")
        self.assertTrue(policy.partial)
        self.assertFalse(policy.unsupported)
        self.assertIn("*X", policy.report("EPSG:32639")["warnings"][0]["message"])

    def test_unknown_truncation_and_non_runtime_warnings_are_not_ignored(self):
        for message, category in [("Unexpected end of file", RuntimeWarning),
                                  ("Block X does not exist; corrupted data", RuntimeWarning),
                                  (POLYGON_FALLBACK, UserWarning)]:
            policy = CadWarnings()
            self.emit(policy, message, category)
            self.assertTrue(policy.unsupported)

    def test_distinct_warning_overflow_fails_instead_of_silent_truncation(self):
        policy = CadWarnings()
        for i in range(101):
            self.emit(policy, f"Block block-{i} does not exist")
        self.assertEqual(len(policy.items), 100)
        self.assertTrue(policy.unsupported)


if __name__ == "__main__":
    unittest.main()
