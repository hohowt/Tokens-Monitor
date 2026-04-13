import unittest

from app.pricing import calc_cost_usd


class PricingTests(unittest.TestCase):
    def test_copilot_alias_uses_github_copilot_multiplier(self):
        pricing = {
            "gpt-5.4": (0.0025, 0.015),
        }

        cost = calc_cost_usd(
            pricing,
            "gpt-5.4",
            1000,
            1000,
            provider="copilot",
        )

        self.assertEqual(cost, 0.00175)


if __name__ == "__main__":
    unittest.main()