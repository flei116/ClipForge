import type { Model } from "@/lib/providers/types";
export interface CatalogProvider {
  name: string;
  apiKey?: string;
  baseUrl?: string;
  /** 自定义平台（方案 B）：协议模板，决定怎么拼 URL / 解析响应 */
  protocol?: string;
  /** 自定义平台显示名 */
  displayName?: string;
  /** 自定义平台的视频模型是否原生带音频 */
  supportsAudio?: boolean;
}
export interface ModelCatalogStatus {
  provider: string; mediaType: "image" | "video"; status: "ready" | "empty" | "error" | "fallback";
  checkedAt: string; durationMs: number; count: number; errorCode?: "CATALOG_TIMEOUT" | "CATALOG_UNAVAILABLE";
  source?: "static" | "live" | "cache" | "stale"; catalogUpdatedAt?: string;
}
export interface ModelCatalogResult { models: Model[]; providers: ModelCatalogStatus[] }
