package main

import (
	"encoding/json"
	"log"
	"strings"
)

func normalizeCopilotModelName(model string) string {
	normalized := strings.TrimSpace(strings.ToLower(model))
	if normalized == "" {
		return ""
	}
	if idx := strings.Index(normalized, "·"); idx >= 0 {
		normalized = normalized[:idx]
	}
	return normalized
}

func toFloat(v interface{}) float64 {
	switch value := v.(type) {
	case float64:
		return value
	case float32:
		return float64(value)
	case int:
		return float64(value)
	case int64:
		return float64(value)
	case int32:
		return float64(value)
	default:
		return 0
	}
}

func extractGitHubCopilotDiscounts(data []byte) map[string]float64 {
	var root interface{}
	if err := json.Unmarshal(data, &root); err != nil {
		return nil
	}

	discounts := map[string]float64{}
	var walk func(interface{})
	walk = func(node interface{}) {
		switch value := node.(type) {
		case map[string]interface{}:
			if rawDiscounts, ok := value["discounted_costs"].(map[string]interface{}); ok {
				for model, rawMultiplier := range rawDiscounts {
					multiplier := toFloat(rawMultiplier)
					if multiplier > 0 {
						discounts[normalizeCopilotModelName(model)] = multiplier
					}
				}
			}

			if billing, ok := value["billing"].(map[string]interface{}); ok {
				multiplier := toFloat(billing["multiplier"])
				if multiplier > 0 && multiplier < 1 {
					for _, key := range []string{"version", "id", "model", "model_name"} {
						if model, ok := value[key].(string); ok {
							normalized := normalizeCopilotModelName(model)
							if normalized != "" {
								discounts[normalized] = multiplier
								break
							}
						}
					}
				}
			}

			for _, child := range value {
				walk(child)
			}
		case []interface{}:
			for _, child := range value {
				walk(child)
			}
		}
	}

	walk(root)
	if len(discounts) == 0 {
		return nil
	}
	return discounts
}

func (s *ProxyServer) updateGitHubCopilotDiscounts(data []byte) {
	discounts := extractGitHubCopilotDiscounts(data)
	if len(discounts) == 0 {
		return
	}

	s.copilotMu.Lock()
	updated := 0
	for model, multiplier := range discounts {
		if model == "" || multiplier <= 0 {
			continue
		}
		if existing, ok := s.copilotDiscounts[model]; ok && existing == multiplier {
			continue
		}
		s.copilotDiscounts[model] = multiplier
		updated++
	}
	s.copilotMu.Unlock()

	if updated > 0 {
		log.Printf("[copilot-pricing] updated %d discount entries", updated)
	}
}

func (s *ProxyServer) githubCopilotDiscountMultiplier(model string) float64 {
	normalized := normalizeCopilotModelName(model)
	if normalized == "" {
		return 0
	}

	s.copilotMu.RLock()
	defer s.copilotMu.RUnlock()

	if multiplier, ok := s.copilotDiscounts[normalized]; ok && multiplier > 0 {
		return multiplier
	}

	bestLen := -1
	bestMultiplier := 0.0
	for name, multiplier := range s.copilotDiscounts {
		if multiplier <= 0 {
			continue
		}
		if strings.HasPrefix(normalized, name) && len(name) > bestLen {
			bestLen = len(name)
			bestMultiplier = multiplier
		} else if strings.HasPrefix(name, normalized) && len(name) > bestLen {
			bestLen = len(name)
			bestMultiplier = multiplier
		}
	}
	return bestMultiplier
}
