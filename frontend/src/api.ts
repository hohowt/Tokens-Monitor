const BASE = "/api/dashboard";

function buildUrl(path: string, params: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== "") {
      query.set(key, String(value));
    }
  });
  const qs = query.toString();
  return `${BASE}/${path}${qs ? `?${qs}` : ""}`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  return resp.json();
}

export interface Overview {
  total_tokens: number;
  total_cost_cny: number;
  total_requests: number;
  active_users: number;
  avg_tokens_per_user: number;
  avg_cost_per_user: number;
  exact_tokens: number;
  estimated_tokens: number;
  exact_requests: number;
  estimated_requests: number;
  tokens_change_pct: number | null;
  cost_change_pct: number | null;
  priced_tokens: number;
  unpriced_tokens: number;
}

export interface TrendPoint {
  date: string;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cost_cny: number;
  requests: number;
}

export interface TrendData {
  points: TrendPoint[];
  avg_tokens: number;
  avg_cost: number;
}

export interface RankingItem {
  id: number;
  name: string;
  employee_id?: string;
  total_tokens: number;
  cost_cny: number;
  requests: number;
}

export interface BreakdownItem {
  key?: string | null;
  name: string;
  total_tokens: number;
  cost_cny: number;
  percentage: number;
}

export interface ClientInfo {
  client_id: string;
  user_name: string;
  user_id: string;
  department: string | null;
  hostname: string | null;
  version: string | null;
  last_seen: string | null;
  is_online: boolean;
}

export interface OnlineClients {
  online_count: number;
  clients: ClientInfo[];
}

export const api = {
  getOverview: (days = 30, sourceApp?: string) => fetchJson<Overview>(buildUrl("overview", { days, source_app: sourceApp })),
  getTrend: (days = 15, sourceApp?: string) => fetchJson<TrendData>(buildUrl("trend", { days, source_app: sourceApp })),
  getByUser: (days = 30, limit = 10, sourceApp?: string) => fetchJson<{ items: RankingItem[] }>(buildUrl("by-user", { days, limit, source_app: sourceApp })),
  getByDepartment: (days = 30, sourceApp?: string) => fetchJson<{ items: RankingItem[] }>(buildUrl("by-department", { days, source_app: sourceApp })),
  getByModel: (days = 30, sourceApp?: string) => fetchJson<{ items: BreakdownItem[] }>(buildUrl("by-model", { days, source_app: sourceApp })),
  getByProvider: (days = 30, sourceApp?: string) => fetchJson<{ items: BreakdownItem[] }>(buildUrl("by-provider", { days, source_app: sourceApp })),
  getBySource: (days = 30, sourceApp?: string) => fetchJson<{ items: BreakdownItem[] }>(buildUrl("by-source", { days, source_app: sourceApp })),
  getBySourceApp: (days = 30, sourceApp?: string) => fetchJson<{ items: BreakdownItem[] }>(buildUrl("by-source-app", { days, source_app: sourceApp })),
  getByEndpoint: (days = 30, sourceApp?: string) => fetchJson<{ items: BreakdownItem[] }>(buildUrl("by-endpoint", { days, source_app: sourceApp })),
  getOnlineClients: () => fetchJson<OnlineClients>("/api/clients/online"),
};
