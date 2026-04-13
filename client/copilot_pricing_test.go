package main

import "testing"

func TestExtractGitHubCopilotDiscountsFromDiscountedCosts(t *testing.T) {
	const payload = `{"selected_model":"gpt-5.3-codex","discounted_costs":{"gpt-4.1":0.1,"gpt-5.3-codex":0.1,"gpt-5.4":0.1}}`
	discounts := extractGitHubCopilotDiscounts([]byte(payload))
	if discounts["gpt-5.4"] != 0.1 {
		t.Fatalf("gpt-5.4 multiplier = %v", discounts["gpt-5.4"])
	}
	if discounts["gpt-4.1"] != 0.1 {
		t.Fatalf("gpt-4.1 multiplier = %v", discounts["gpt-4.1"])
	}
}

func TestExtractGitHubCopilotDiscountsFromBillingMultiplier(t *testing.T) {
	const payload = `{"data":[{"billing":{"is_premium":true,"multiplier":0.33},"vendor":"OpenAI","version":"gpt-5.4-mini"}]}`
	discounts := extractGitHubCopilotDiscounts([]byte(payload))
	if discounts["gpt-5.4-mini"] != 0.33 {
		t.Fatalf("gpt-5.4-mini multiplier = %v", discounts["gpt-5.4-mini"])
	}
}

func TestGitHubCopilotDiscountMultiplierMatchesVersionedModel(t *testing.T) {
	proxy := &ProxyServer{copilotDiscounts: map[string]float64{"gpt-5.4": 0.1}}
	if got := proxy.githubCopilotDiscountMultiplier("gpt-5.4-2026-03-05"); got != 0.1 {
		t.Fatalf("versioned multiplier = %v", got)
	}
}
