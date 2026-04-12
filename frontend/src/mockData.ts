import type { Overview, TrendData, RankingItem, BreakdownItem } from "./api";

// Mock data for development / demo
export const mockOverview: Overview = {
  total_tokens: 11_114_929_555,
  total_cost_cny: 285_320.5,
  total_requests: 142_850,
  active_users: 218,
  avg_tokens_per_user: 50_985_000,
  avg_cost_per_user: 1308.85,
  exact_tokens: 10_402_000_000,
  estimated_tokens: 712_929_555,
  exact_requests: 134_280,
  estimated_requests: 8_570,
  tokens_change_pct: 12.5,
  cost_change_pct: 8.3,
  priced_tokens: 9_800_000_000,
  unpriced_tokens: 1_314_929_555,
};

const dates15 = Array.from({ length: 15 }, (_, i) => {
  const d = new Date();
  d.setDate(d.getDate() - 14 + i);
  return d.toISOString().slice(0, 10);
});

export const mockTrend: TrendData = {
  points: dates15.map((date, i) => {
    const base = 300_000_000 + Math.random() * 500_000_000;
    const input = Math.floor(base * 0.6);
    const output = Math.floor(base * 0.4);
    return {
      date,
      total_tokens: input + output,
      input_tokens: input,
      output_tokens: output,
      cost_cny: Math.round((input + output) / 1000 * 0.05 * 100) / 100,
      requests: Math.floor(3000 + Math.random() * 8000),
    };
  }),
  avg_tokens: 550_000_000,
  avg_cost: 27500,
};

export const mockUserRanking: RankingItem[] = [
  { id: 1, name: "张三", employee_id: "10001", total_tokens: 890_000_000, cost_cny: 18500, requests: 12300 },
  { id: 2, name: "李四", employee_id: "10002", total_tokens: 720_000_000, cost_cny: 15200, requests: 9800 },
  { id: 3, name: "王五", employee_id: "10003", total_tokens: 650_000_000, cost_cny: 13800, requests: 8500 },
  { id: 4, name: "赵六", employee_id: "10004", total_tokens: 580_000_000, cost_cny: 11200, requests: 7200 },
  { id: 5, name: "钱七", employee_id: "10005", total_tokens: 510_000_000, cost_cny: 10500, requests: 6800 },
  { id: 6, name: "孙八", employee_id: "10006", total_tokens: 430_000_000, cost_cny: 9200, requests: 5900 },
  { id: 7, name: "周九", employee_id: "10007", total_tokens: 380_000_000, cost_cny: 7800, requests: 5100 },
  { id: 8, name: "吴十", employee_id: "10008", total_tokens: 320_000_000, cost_cny: 6500, requests: 4300 },
  { id: 9, name: "郑十一", employee_id: "10009", total_tokens: 280_000_000, cost_cny: 5800, requests: 3800 },
  { id: 10, name: "冯十二", employee_id: "10010", total_tokens: 230_000_000, cost_cny: 4900, requests: 3200 },
];

export const mockDeptRanking: RankingItem[] = [
  { id: 1, name: "研发部", total_tokens: 4_200_000_000, cost_cny: 95000, requests: 52000 },
  { id: 2, name: "产品部", total_tokens: 2_100_000_000, cost_cny: 48000, requests: 28000 },
  { id: 3, name: "数据部", total_tokens: 1_800_000_000, cost_cny: 42000, requests: 22000 },
  { id: 4, name: "测试部", total_tokens: 1_500_000_000, cost_cny: 35000, requests: 18000 },
  { id: 5, name: "运营部", total_tokens: 800_000_000, cost_cny: 18000, requests: 12000 },
];

export const mockModelBreakdown: BreakdownItem[] = [
  { name: "gpt-4o", total_tokens: 2_800_000_000, cost_cny: 72000, percentage: 25.2 },
  { name: "claude-sonnet-4", total_tokens: 2_100_000_000, cost_cny: 58000, percentage: 18.9 },
  { name: "deepseek-chat", total_tokens: 1_800_000_000, cost_cny: 4100, percentage: 16.2 },
  { name: "gpt-4o-mini", total_tokens: 1_200_000_000, cost_cny: 6800, percentage: 10.8 },
  { name: "qwen-max", total_tokens: 900_000_000, cost_cny: 4500, percentage: 8.1 },
  { name: "glm-4-plus", total_tokens: 650_000_000, cost_cny: 4550, percentage: 5.8 },
  { name: "gemini-2.5-pro", total_tokens: 580_000_000, cost_cny: 8200, percentage: 5.2 },
  { name: "doubao-pro-32k", total_tokens: 450_000_000, cost_cny: 1280, percentage: 4.1 },
  { name: "mistral-large", total_tokens: 320_000_000, cost_cny: 3800, percentage: 2.9 },
  { name: "其他", total_tokens: 314_929_555, cost_cny: 12090, percentage: 2.8 },
];

export const mockProviderBreakdown: BreakdownItem[] = [
  { name: "OpenAI", total_tokens: 4_000_000_000, cost_cny: 78800, percentage: 36.0 },
  { name: "Anthropic", total_tokens: 2_100_000_000, cost_cny: 58000, percentage: 18.9 },
  { name: "DeepSeek", total_tokens: 1_800_000_000, cost_cny: 4100, percentage: 16.2 },
  { name: "通义千问", total_tokens: 900_000_000, cost_cny: 4500, percentage: 8.1 },
  { name: "智谱GLM", total_tokens: 650_000_000, cost_cny: 4550, percentage: 5.8 },
  { name: "Google", total_tokens: 580_000_000, cost_cny: 8200, percentage: 5.2 },
  { name: "豆包", total_tokens: 450_000_000, cost_cny: 1280, percentage: 4.1 },
  { name: "Mistral", total_tokens: 320_000_000, cost_cny: 3800, percentage: 2.9 },
  { name: "其他", total_tokens: 314_929_555, cost_cny: 12090, percentage: 2.8 },
];
