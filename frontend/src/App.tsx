import React, { Suspense, lazy, useState, useEffect, useCallback } from "react";
import { Alert, Button, Radio, Select, Space } from "antd";
import {
  DashboardOutlined,
  ThunderboltOutlined,
  DollarOutlined,
  TeamOutlined,
  ApiOutlined,
  RobotOutlined,
  DesktopOutlined,
} from "@ant-design/icons";
import { api, type Overview, type TrendData, type RankingItem, type BreakdownItem } from "./api";
import { formatNumber, formatCNY, formatTokens } from "./utils";
import AnimatedNumber from "./AnimatedNumber";
import AutoScroll from "./AutoScroll";

const DashboardChart = lazy(() => import("./DashboardChart"));

const COLORS = {
  green: "#3fb950",
  yellow: "#f0c000",
  purple: "#bc8cff",
  cyan: "#39d2c0",
  pink: "#f778ba",
  orange: "#f0883e",
  blue: "#58a6ff",
};

const BAR_COLORS = ["#3fb950", "#58a6ff", "#bc8cff", "#f0c000", "#f778ba", "#39d2c0"];

function App() {
  const [trendDays, setTrendDays] = useState(15);
  const [trendType, setTrendType] = useState<"bar" | "line">("bar");
  const [selectedSourceApp, setSelectedSourceApp] = useState<string>("all");
  const [sourceAppMetric, setSourceAppMetric] = useState<"tokens" | "cost">("tokens");
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string>("--");

  const emptyOverview: Overview = { total_tokens: 0, total_cost_cny: 0, total_requests: 0, active_users: 0, avg_tokens_per_user: 0, avg_cost_per_user: 0, exact_tokens: 0, estimated_tokens: 0, exact_requests: 0, estimated_requests: 0, tokens_change_pct: null, cost_change_pct: null };
  const emptyTrend: TrendData = { points: [], avg_tokens: 0, avg_cost: 0 };

  const [overview, setOverview] = useState<Overview>(emptyOverview);
  const [trend, setTrend] = useState<TrendData>(emptyTrend);
  const [userRanking, setUserRanking] = useState<RankingItem[]>([]);
  const [deptRanking, setDeptRanking] = useState<RankingItem[]>([]);
  const [modelBreakdown, setModelBreakdown] = useState<BreakdownItem[]>([]);
  const [providerBreakdown, setProviderBreakdown] = useState<BreakdownItem[]>([]);
  const [sourceBreakdown, setSourceBreakdown] = useState<BreakdownItem[]>([]);
  const [sourceAppBreakdown, setSourceAppBreakdown] = useState<BreakdownItem[]>([]);
  const [endpointBreakdown, setEndpointBreakdown] = useState<BreakdownItem[]>([]);
  const [onlineClients, setOnlineClients] = useState(0);

  const activeSourceApp = selectedSourceApp === "all" ? undefined : selectedSourceApp;

  const fetchAll = useCallback(async (showLoading = false) => {
    if (showLoading) {
      setIsLoading(true);
    } else {
      setIsRefreshing(true);
    }
    setLoadError(null);
    try {
      const [ov, tr, usr, dept, mdl, prov, src, srcApp, endpoint, clients] = await Promise.all([
        api.getOverview(trendDays, activeSourceApp),
        api.getTrend(trendDays, activeSourceApp),
        api.getByUser(trendDays, 10, activeSourceApp),
        api.getByDepartment(trendDays, activeSourceApp),
        api.getByModel(trendDays, activeSourceApp),
        api.getByProvider(trendDays, activeSourceApp),
        api.getBySource(trendDays, activeSourceApp),
        api.getBySourceApp(trendDays),
        api.getByEndpoint(trendDays, activeSourceApp),
        api.getOnlineClients(),
      ]);
      setOverview(ov);
      setTrend(tr);
      setUserRanking(usr.items || []);
      setDeptRanking(dept.items || []);
      setModelBreakdown(mdl.items || []);
      setProviderBreakdown(prov.items || []);
      setSourceBreakdown(src.items || []);
      setSourceAppBreakdown(srcApp.items || []);
      setEndpointBreakdown(endpoint.items || []);
      setOnlineClients(clients.online_count);
      setLastUpdatedAt(new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(new Date()));
    } catch (e) {
      console.error("Failed to fetch dashboard data:", e);
      setLoadError(e instanceof Error ? e.message : "数据加载失败，请稍后重试");
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [activeSourceApp, trendDays]);

  useEffect(() => {
    void fetchAll(true);
    const timer = setInterval(() => {
      void fetchAll(false);
    }, 30000);
    return () => clearInterval(timer);
  }, [fetchAll]);

  const exactTokenPct = overview.total_tokens > 0 ? (overview.exact_tokens / overview.total_tokens) * 100 : 0;
  const estimatedRequestPct = overview.total_requests > 0 ? (overview.estimated_requests / overview.total_requests) * 100 : 0;
  const topSource = sourceBreakdown.length > 0 ? sourceBreakdown[0] : null;
  const topSourceApp = sourceAppBreakdown.length > 0 ? sourceAppBreakdown[0] : null;
  const topEndpoint = endpointBreakdown.length > 0 ? endpointBreakdown[0] : null;
  const sourceAppOptions = [{ label: "全部应用", value: "all" }].concat(
    sourceAppBreakdown.map((item) => ({
      label: item.name,
      value: item.key ?? item.name,
    })),
  );
  const currentSourceAppLabel = selectedSourceApp === "all"
    ? "全部应用"
    : sourceAppOptions.find((item) => item.value === selectedSourceApp)?.label ?? selectedSourceApp;
  const hasTrendData = trend.points.length > 0;
  const hasModelData = modelBreakdown.length > 0;
  const hasProviderData = providerBreakdown.length > 0;

  const renderEmptyState = (message: string) => (
    <div className="card-empty">{message}</div>
  );

  // ── Stat Cards (with animated numbers) ──
  const statCards = [
    { label: "总 Token 消耗", icon: <ThunderboltOutlined />, rawValue: overview.total_tokens, format: formatTokens, color: "yellow", sub: "所有 AI 模型消耗的 Token 总数" },
    { label: "总成本", icon: <DollarOutlined />, rawValue: overview.total_cost_cny, format: formatCNY, color: "green", sub: overview.cost_change_pct != null ? `环比 ${overview.cost_change_pct > 0 ? "+" : ""}${overview.cost_change_pct}%` : "环比 暂无" },
    { label: "总请求数", icon: <ApiOutlined />, rawValue: overview.total_requests, format: formatNumber, color: "purple", sub: "API 调用总次数" },
    { label: "精确 Token 占比", icon: <ThunderboltOutlined />, rawValue: exactTokenPct, format: (n: number) => `${n.toFixed(1)}%`, color: "orange", sub: `精确 ${formatTokens(overview.exact_tokens)} / 估算 ${formatTokens(overview.estimated_tokens)}` },
    { label: "活跃用户", icon: <TeamOutlined />, rawValue: overview.active_users, format: (n: number) => Math.round(n).toString(), color: "cyan", sub: "本月有 AI 调用的用户数" },
    { label: "在线客户端", icon: <DesktopOutlined />, rawValue: onlineClients, format: (n: number) => Math.round(n).toString(), color: "blue", sub: "当前在线的监控客户端" },
    { label: "估算请求数", icon: <ApiOutlined />, rawValue: overview.estimated_requests, format: formatNumber, color: "purple", sub: `占全部请求 ${estimatedRequestPct.toFixed(1)}%` },
    { label: "人均 Token", icon: <RobotOutlined />, rawValue: overview.avg_tokens_per_user, format: formatTokens, color: "pink", sub: `人均成本 ${formatCNY(overview.avg_cost_per_user)}` },
  ];

  // ── Trend Chart ──
  const trendOption = {
    backgroundColor: "transparent",
    tooltip: { trigger: "axis" as const },
    legend: { data: ["Input Tokens", "Output Tokens"], textStyle: { color: "#8b949e" }, top: 0 },
    grid: { left: 60, right: 20, bottom: 30, top: 40 },
    xAxis: {
      type: "category" as const,
      data: trend.points.map((p) => p.date.slice(5)),
      axisLabel: { color: "#8b949e" },
      axisLine: { lineStyle: { color: "#30363d" } },
    },
    yAxis: {
      type: "value" as const,
      axisLabel: { color: "#8b949e", formatter: (v: number) => formatTokens(v) },
      splitLine: { lineStyle: { color: "#21262d" } },
    },
    series: [
      {
        name: "Input Tokens",
        type: trendType,
        data: trend.points.map((p) => p.input_tokens),
        itemStyle: { color: COLORS.green },
        ...(trendType === "bar" ? { barMaxWidth: 30 } : { smooth: true }),
      },
      {
        name: "Output Tokens",
        type: trendType,
        data: trend.points.map((p) => p.output_tokens),
        itemStyle: { color: COLORS.purple },
        ...(trendType === "bar" ? { barMaxWidth: 30 } : { smooth: true }),
      },
    ],
  };

  // ── Cost Trend ──
  const costTrendOption = {
    backgroundColor: "transparent",
    tooltip: { trigger: "axis" as const, formatter: (params: any) => {
      const p = params[0];
      return `${p.axisValue}<br/>${p.marker} 成本: ${formatCNY(p.value)}`;
    }},
    grid: { left: 70, right: 20, bottom: 30, top: 20 },
    xAxis: {
      type: "category" as const,
      data: trend.points.map((p) => p.date.slice(5)),
      axisLabel: { color: "#8b949e" },
      axisLine: { lineStyle: { color: "#30363d" } },
    },
    yAxis: {
      type: "value" as const,
      min: 0,
      axisLabel: { color: "#8b949e", formatter: (v: number) => formatCNY(v) },
      splitLine: { lineStyle: { color: "#21262d" } },
    },
    series: [{
      type: "line" as const,
      data: trend.points.map((p) => p.cost_cny),
      smooth: true,
      areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: "rgba(88,166,255,0.3)" }, { offset: 1, color: "rgba(88,166,255,0)" }] } },
      lineStyle: { color: COLORS.blue, width: 2 },
      itemStyle: { color: COLORS.blue },
    }],
  };

  // ── Model Pie ──
  const modelPieOption = {
    backgroundColor: "transparent",
    tooltip: { trigger: "item" as const, formatter: "{b}: {d}%" },
    legend: { orient: "horizontal" as const, bottom: 0, left: "center", textStyle: { color: "#8b949e", fontSize: 11 }, formatter: (name: string) => name.length > 10 ? name.slice(0, 10) + "…" : name, itemWidth: 10, itemHeight: 10, itemGap: 8 },
    series: [{
      type: "pie",
      radius: ["35%", "65%"],
      center: ["50%", "42%"],
      data: modelBreakdown.map((m, i) => ({
        name: m.name, value: m.total_tokens,
        itemStyle: { color: BAR_COLORS[i % BAR_COLORS.length] },
      })),
      label: { show: false },
      emphasis: { itemStyle: { shadowBlur: 10, shadowColor: "rgba(0,0,0,0.5)" } },
    }],
  };

  // ── Provider Pie ──
  const providerPieOption = {
    backgroundColor: "transparent",
    tooltip: { trigger: "item" as const, formatter: "{b}: {d}%" },
    legend: { orient: "horizontal" as const, bottom: 0, left: "center", textStyle: { color: "#8b949e", fontSize: 11 }, itemWidth: 10, itemHeight: 10, itemGap: 8 },
    series: [{
      type: "pie",
      radius: ["35%", "65%"],
      center: ["50%", "42%"],
      data: providerBreakdown.map((m, i) => ({
        name: m.name, value: m.total_tokens,
        itemStyle: { color: BAR_COLORS[i % BAR_COLORS.length] },
      })),
      label: { show: false },
      emphasis: { itemStyle: { shadowBlur: 10, shadowColor: "rgba(0,0,0,0.5)" } },
    }],
  };

  // ── Ranking list helper ──
  const maxUserTokens = userRanking.length > 0 ? userRanking[0].total_tokens : 1;
  const maxDeptTokens = deptRanking.length > 0 ? deptRanking[0].total_tokens : 1;

  return (
    <div className="dashboard">
      {/* Header */}
      <div className="dashboard-header">
        <h1><DashboardOutlined /> 腾轩旅游集团 · AI Token 监控大屏</h1>
        <Space size={8} className="dashboard-top-actions">
          <Select
            value={selectedSourceApp}
            onChange={setSelectedSourceApp}
            options={sourceAppOptions}
            size="small"
            popupMatchSelectWidth={false}
            className="dashboard-select"
          />
          <Radio.Group className="dashboard-radio-group" value={trendDays} onChange={(e) => setTrendDays(e.target.value)} buttonStyle="solid" size="small">
            <Radio.Button value={7}>近7天</Radio.Button>
            <Radio.Button value={15}>近15天</Radio.Button>
            <Radio.Button value={30}>近30天</Radio.Button>
          </Radio.Group>
          <Radio.Group className="dashboard-radio-group" value={trendType} onChange={(e) => setTrendType(e.target.value)} buttonStyle="solid" size="small">
            <Radio.Button value="bar">柱状图</Radio.Button>
            <Radio.Button value="line">折线图</Radio.Button>
          </Radio.Group>
          <Button className="dashboard-refresh-btn dashboard-refresh-btn-inline" type="primary" ghost onClick={() => void fetchAll(false)} loading={isRefreshing && !isLoading}>
            刷新
          </Button>
        </Space>
      </div>

      <div className="dashboard-filter-note">
        当前视图：{currentSourceAppLabel}
        <span className={`dashboard-status dashboard-status-inline${isRefreshing ? " is-refreshing" : ""}`}>
          {isLoading ? "首次加载中" : isRefreshing ? "刷新中" : `已更新 ${lastUpdatedAt}`}
        </span>
      </div>

      {loadError ? (
        <Alert
          className="dashboard-alert"
          type="error"
          showIcon
          message="数据同步失败"
          description={loadError}
          action={<Button size="small" onClick={() => void fetchAll(false)}>重试</Button>}
        />
      ) : null}

      {/* Stat Cards */}
      <div className="stat-cards">
        {statCards.map((card) => (
          <div className="stat-card" key={card.label}>
            <div className="label">{card.icon} {card.label}</div>
            <div className={`value color-${card.color}`}>
              <AnimatedNumber value={card.rawValue} format={card.format} />
            </div>
            <div className="sub">{card.sub}</div>
          </div>
        ))}
      </div>

      {/* All Charts - single row of 4 */}
      <div className="charts-row-4">
        <div className="chart-card">
          <h3>Token 消耗趋势</h3>
          {hasTrendData ? (
            <Suspense fallback={<div className="chart-fallback">图表模块加载中...</div>}>
              <DashboardChart option={trendOption} />
            </Suspense>
          ) : renderEmptyState("当前时间范围内暂无 Token 趋势数据")}
        </div>
        <div className="chart-card">
          <h3>成本趋势 (¥)</h3>
          {hasTrendData ? (
            <Suspense fallback={<div className="chart-fallback">图表模块加载中...</div>}>
              <DashboardChart option={costTrendOption} />
            </Suspense>
          ) : renderEmptyState("当前时间范围内暂无成本趋势数据")}
        </div>
        <div className="chart-card">
          <h3>模型消耗占比</h3>
          {hasModelData ? (
            <Suspense fallback={<div className="chart-fallback">图表模块加载中...</div>}>
              <DashboardChart option={modelPieOption} />
            </Suspense>
          ) : renderEmptyState("暂无模型维度数据")}
        </div>
        <div className="chart-card">
          <h3>供应商消耗占比</h3>
          {hasProviderData ? (
            <Suspense fallback={<div className="chart-fallback">图表模块加载中...</div>}>
              <DashboardChart option={providerPieOption} />
            </Suspense>
          ) : renderEmptyState("暂无供应商维度数据")}
        </div>
      </div>

      {/* Rankings + Insights — scrollable lists */}
      <div className="rankings-section">
        <div className="ranking-card">
          <h3>👤 用户 Token 消耗 Top {userRanking.length}</h3>
          <AutoScroll speed={18}>
            {userRanking.length > 0 ? (
              <div className="rank-list">
                {userRanking.map((u, i) => (
                  <div className="rank-row" key={u.name}>
                    <span className="rank-idx" style={{ color: i < 3 ? COLORS.yellow : "#8b949e" }}>{i + 1}</span>
                    <span className="rank-name">{u.name}</span>
                    <div className="rank-bar-bg">
                      <div className="rank-bar" style={{ width: `${(u.total_tokens / maxUserTokens) * 100}%`, background: BAR_COLORS[i % BAR_COLORS.length] }} />
                    </div>
                    <span className="rank-val">{formatTokens(u.total_tokens)}</span>
                  </div>
                ))}
              </div>
            ) : renderEmptyState("暂无用户排行数据")}
          </AutoScroll>
        </div>
        <div className="ranking-card">
          <h3>🏢 部门 Token 消耗排行</h3>
          <AutoScroll speed={18}>
            {deptRanking.length > 0 ? (
              <div className="rank-list">
                {deptRanking.map((d, i) => (
                  <div className="rank-row" key={d.name}>
                    <span className="rank-idx" style={{ color: i < 3 ? COLORS.yellow : "#8b949e" }}>{i + 1}</span>
                    <span className="rank-name">{d.name}</span>
                    <div className="rank-bar-bg">
                      <div className="rank-bar" style={{ width: `${(d.total_tokens / maxDeptTokens) * 100}%`, background: BAR_COLORS[i % BAR_COLORS.length] }} />
                    </div>
                    <span className="rank-val">{formatTokens(d.total_tokens)}</span>
                  </div>
                ))}
              </div>
            ) : renderEmptyState("暂无部门排行数据")}
          </AutoScroll>
        </div>
        <div className="ranking-card">
          <h3>📊 数据洞察</h3>
          <AutoScroll speed={15}>
            <div className="insight-list">
              <div className="insight-item">
                <span style={{ color: COLORS.pink }}>●</span>
                <span>人均 Token 消耗：<b style={{ color: COLORS.yellow }}>{formatTokens(overview.avg_tokens_per_user)}</b></span>
              </div>
              <div className="insight-item">
                <span style={{ color: COLORS.cyan }}>●</span>
                <span>人均成本：<b style={{ color: COLORS.green }}>{formatCNY(overview.avg_cost_per_user)}</b></span>
              </div>
              <div className="insight-item">
                <span style={{ color: COLORS.purple }}>●</span>
                <span>日均请求：<b style={{ color: COLORS.purple }}>{formatNumber(Math.round(overview.total_requests / Math.max(trendDays, 1)))}</b></span>
              </div>
              <div className="insight-item">
                <span style={{ color: COLORS.orange }}>●</span>
                <span>最热模型：<b style={{ color: COLORS.orange }}>{modelBreakdown.length > 0 ? modelBreakdown[0].name : "--"}</b> ({modelBreakdown.length > 0 ? modelBreakdown[0].percentage : 0}%)</span>
              </div>
              <div className="insight-item">
                <span style={{ color: COLORS.blue }}>●</span>
                <span>最大成本：<b style={{ color: COLORS.blue }}>{modelBreakdown.length > 0 ? [...modelBreakdown].sort((a: BreakdownItem, b: BreakdownItem) => b.cost_cny - a.cost_cny)[0].name : "--"}</b> ({modelBreakdown.length > 0 ? formatCNY([...modelBreakdown].sort((a: BreakdownItem, b: BreakdownItem) => b.cost_cny - a.cost_cny)[0].cost_cny) : "¥0"})</span>
              </div>
              <div className="insight-item">
                <span style={{ color: COLORS.green }}>●</span>
                <span>活跃用户数：<b style={{ color: COLORS.green }}>{overview.active_users}</b> 人</span>
              </div>
              <div className="insight-item">
                <span style={{ color: COLORS.yellow }}>●</span>
                <span>在线客户端：<b style={{ color: COLORS.yellow }}>{onlineClients}</b> 个</span>
              </div>
              <div className="insight-item">
                <span style={{ color: COLORS.orange }}>●</span>
                <span>精确 Token：<b style={{ color: COLORS.orange }}>{exactTokenPct.toFixed(1)}%</b> ({formatTokens(overview.exact_tokens)})</span>
              </div>
              <div className="insight-item">
                <span style={{ color: COLORS.purple }}>●</span>
                <span>估算请求：<b style={{ color: COLORS.purple }}>{formatNumber(overview.estimated_requests)}</b> 次 ({estimatedRequestPct.toFixed(1)}%)</span>
              </div>
              <div className="insight-item">
                <span style={{ color: COLORS.blue }}>●</span>
                <span>主要采集方式：<b style={{ color: COLORS.blue }}>{topSource ? topSource.name : "--"}</b>{topSource ? ` (${topSource.percentage}%)` : ""}</span>
              </div>
              <div className="insight-item">
                <span style={{ color: COLORS.cyan }}>●</span>
                <span>当前应用筛选：<b style={{ color: COLORS.cyan }}>{currentSourceAppLabel}</b>{selectedSourceApp === "all" && topSourceApp ? `；主来源 ${topSourceApp.name} (${topSourceApp.percentage}%)` : ""}</span>
              </div>
              <div className="insight-item">
                <span style={{ color: COLORS.blue }}>●</span>
                <span>主要接口：<b style={{ color: COLORS.blue }}>{topEndpoint ? topEndpoint.name : "--"}</b>{topEndpoint ? ` (${topEndpoint.percentage}%)` : ""}</span>
              </div>
            </div>
          </AutoScroll>
        </div>
        <div className="ranking-card">
          <h3>🧭 采集来源占比</h3>
          <AutoScroll speed={18}>
            {sourceBreakdown.length > 0 ? (
              <div className="rank-list">
                {sourceBreakdown.map((item, i) => (
                  <div className="rank-row" key={item.name}>
                    <span className="rank-idx" style={{ color: i < 3 ? COLORS.yellow : "#8b949e" }}>{i + 1}</span>
                    <span className="rank-name rank-name-wide">{item.name}</span>
                    <div className="rank-bar-bg">
                      <div className="rank-bar" style={{ width: `${item.percentage}%`, background: BAR_COLORS[i % BAR_COLORS.length] }} />
                    </div>
                    <span className="rank-val rank-val-wide">{item.percentage}%</span>
                  </div>
                ))}
              </div>
            ) : renderEmptyState("暂无采集来源数据")}
          </AutoScroll>
        </div>
        <div className="ranking-card">
          <div className="ranking-card-head">
            <h3>🖥️ 应用来源排行</h3>
            <Radio.Group className="dashboard-radio-group source-metric-group" size="small" value={sourceAppMetric} onChange={(e) => setSourceAppMetric(e.target.value)} buttonStyle="solid">
              <Radio.Button value="tokens">Token</Radio.Button>
              <Radio.Button value="cost">成本</Radio.Button>
            </Radio.Group>
          </div>
          <AutoScroll speed={18}>
            {sourceAppBreakdown.length > 0 ? (
              <div className="rank-list">
                {(() => {
                  const maxVal = sourceAppBreakdown.reduce((m, it) => Math.max(m, sourceAppMetric === "cost" ? it.cost_cny : it.total_tokens), 0);
                  return sourceAppBreakdown.map((item, i) => {
                    const val = sourceAppMetric === "cost" ? item.cost_cny : item.total_tokens;
                    const pct = maxVal > 0 ? (val / maxVal) * 100 : 0;
                    return (
                      <div className="rank-row" key={item.name}>
                        <span className="rank-idx" style={{ color: i < 3 ? COLORS.yellow : "#8b949e" }}>{i + 1}</span>
                        <span className="rank-name rank-name-wide">{item.name}</span>
                        <div className="rank-bar-bg">
                          <div className="rank-bar" style={{ width: `${pct}%`, background: BAR_COLORS[i % BAR_COLORS.length] }} />
                        </div>
                        <span className="rank-val rank-val-wide">{sourceAppMetric === "cost" ? formatCNY(val) : formatTokens(val)}</span>
                      </div>
                    );
                  });
                })()}
              </div>
            ) : renderEmptyState("暂无应用来源排行数据")}
          </AutoScroll>
        </div>
        <div className="ranking-card">
          <h3>🔌 接口维度排行</h3>
          <AutoScroll speed={18}>
            {endpointBreakdown.length > 0 ? (
              <div className="rank-list">
                {endpointBreakdown.map((item, i) => (
                  <div className="rank-row" key={item.name}>
                    <span className="rank-idx" style={{ color: i < 3 ? COLORS.yellow : "#8b949e" }}>{i + 1}</span>
                    <span className="rank-name rank-name-endpoint">{item.name}</span>
                    <div className="rank-bar-bg">
                      <div className="rank-bar" style={{ width: `${item.percentage}%`, background: BAR_COLORS[i % BAR_COLORS.length] }} />
                    </div>
                    <span className="rank-val rank-val-wide">{item.percentage}%</span>
                  </div>
                ))}
              </div>
            ) : renderEmptyState("暂无接口维度排行数据")}
          </AutoScroll>
        </div>
      </div>
    </div>
  );
}

export default App;
