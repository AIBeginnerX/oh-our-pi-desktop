import type { MessageCatalog } from "./types";

/** The Usage page: unpriced display, coverage note, inline limit gauges, sortable breakdown. */
export const USAGE_MESSAGES: MessageCatalog = {
  Plan: {
    ko: "플랜",
    ja: "プラン",
    "zh-CN": "套餐",
    es: "Plan",
  },
  "No rate": {
    ko: "요금 없음",
    ja: "料金なし",
    "zh-CN": "无费率",
    es: "Sin tarifa",
  },
  Name: {
    ko: "이름",
    ja: "名前",
    "zh-CN": "名称",
    es: "Nombre",
  },
  Share: {
    ko: "비중",
    ja: "割合",
    "zh-CN": "占比",
    es: "Proporción",
  },
  "Share of tokens": {
    ko: "토큰 비중",
    ja: "トークンの割合",
    "zh-CN": "令牌占比",
    es: "Proporción de tokens",
  },
  "{percent}% used": {
    ko: "{percent}% 사용",
    ja: "{percent}% 使用済み",
    "zh-CN": "已用 {percent}%",
    es: "{percent}% usado",
  },
  "resets in {time}": {
    ko: "{time} 후 초기화",
    ja: "{time} 後にリセット",
    "zh-CN": "{time} 后重置",
    es: "se restablece en {time}",
  },
  "resets now": {
    ko: "곧 초기화",
    ja: "まもなくリセット",
    "zh-CN": "即将重置",
    es: "se restablece ahora",
  },
  "Costs known for {known} of {total} providers": {
    ko: "비용 확인된 제공자 {known}/{total}개",
    ja: "料金が判明しているプロバイダー {known}/{total} 件",
    "zh-CN": "已知费用的提供方 {known}/{total} 个",
    es: "Costos conocidos en {known} de {total} proveedores",
  },
  "{percent} of tokens": {
    ko: "토큰의 {percent}",
    ja: "トークンの {percent}",
    "zh-CN": "占令牌的 {percent}",
    es: "{percent} de los tokens",
  },
  "Costs are unknown for this period; showing tokens.": {
    ko: "이 기간의 비용을 알 수 없어 토큰으로 표시합니다.",
    ja: "この期間の料金は不明なため、トークンを表示しています。",
    "zh-CN": "此时段的费用未知，改为显示令牌。",
    es: "Los costos de este periodo se desconocen; se muestran los tokens.",
  },
  "Sort by {column}": {
    ko: "{column} 기준으로 정렬",
    ja: "{column} で並べ替え",
    "zh-CN": "按{column}排序",
    es: "Ordenar por {column}",
  },
};
