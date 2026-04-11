import ReactECharts from "echarts-for-react";

interface DashboardChartProps {
  option: object;
}

export default function DashboardChart({ option }: DashboardChartProps) {
  return <ReactECharts option={option} style={{ height: "100%", minHeight: 0 }} opts={{ renderer: "canvas" }} />;
}