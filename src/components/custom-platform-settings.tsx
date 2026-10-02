"use client";

/**
 * 自定义平台设置卡片（方案 B）
 * ================================
 * 让用户自由添加 AI 平台：自选协议模板 + 填 baseUrl / Key，之后即可像内置平台一样
 * 挂自定义模型、走完整生成链路。
 *
 * 与内置 7 家分开渲染的原因：内置平台的协议是编译期常量（各 provider 类的实现），
 * 而自定义平台的协议/baseUrl/显示名是**运行时用户数据**，存在 settings.providers 里，
 * key 以 "custom-" 开头（见 lib/providers/custom.ts 的 CUSTOM_PLATFORM_PREFIX）。
 */

import { useState } from "react";
import { LuPlus, LuTrash2 } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CUSTOM_PROTOCOLS } from "@/lib/providers/custom";
import { isCustomPlatform, useSettingsStore, type ProviderSetting } from "@/lib/stores/settings-store";
import { useT } from "@/lib/i18n";

/** Key 连通性测试结果（与设置页内置平台卡片共用同一状态形状） */
export type ProviderTestState =
  | { state: "idle" | "testing" }
  | { state: "ok" | "invalid" | "unknown"; msg: string };

export function CustomPlatformSettings({
  providerTest,
  testProvider,
}: {
  providerTest: Record<string, ProviderTestState | undefined>;
  testProvider: (key: string) => void;
}) {
  const tc = useT("customPlatform");
  const { providers, setProvider, addCustomPlatform, removeCustomPlatform } = useSettingsStore();

  // 用户自建的平台（key 前缀 custom-），按添加顺序展示
  const customPlatforms = Object.entries(providers).filter(([name]) => isCustomPlatform(name));

  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [protocol, setProtocol] = useState<string>(CUSTOM_PROTOCOLS[0].id);
  const [apiKey, setApiKey] = useState("");
  const [supportsAudio, setSupportsAudio] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAdd = () => {
    setError(null);
    if (!name.trim()) return setError(tc("errName"));
    // baseUrl 必填：自定义平台没有"平台默认端点"可回退
    if (!baseUrl.trim()) return setError(tc("errBaseUrl"));
    let parsed: URL;
    try {
      parsed = new URL(baseUrl.trim());
    } catch {
      return setError(tc("errBaseUrlInvalid"));
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return setError(tc("errBaseUrlScheme"));
    }

    addCustomPlatform({
      displayName: name.trim(),
      baseUrl: parsed.toString().replace(/\/$/, ""),
      protocol,
      apiKey: apiKey.trim(),
      supportsAudio,
    });
    setName("");
    setBaseUrl("");
    setApiKey("");
    setSupportsAudio(false);
  };

  return (
    <>
      {/* 新增表单 */}
      <Card className="glass-card">
        <CardContent className="p-5 space-y-4">
          <div>
            <h3 className="font-semibold text-sm">{tc("title")}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">{tc("desc")}</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{tc("fieldName")}</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={tc("namePlaceholder")}
                className="font-mono text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{tc("fieldProtocol")}</Label>
              <Select value={protocol} onValueChange={(v) => setProtocol(v ?? protocol)}>
                <SelectTrigger className="w-full">
                  <SelectValue>{(value: string) =>
                    CUSTOM_PROTOCOLS.find((p) => p.id === value)?.label ?? value
                  }</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {CUSTOM_PROTOCOLS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground/70">
                {CUSTOM_PROTOCOLS.find((p) => p.id === protocol)?.supportsVideo
                  ? tc("protocolSupportsVideo")
                  : tc("protocolImageOnly")}
              </p>
            </div>

            <div className="space-y-1.5 sm:col-span-2">
              <Label className="text-xs text-muted-foreground">{tc("fieldBaseUrl")}</Label>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1"
                className="font-mono text-xs"
              />
              <p className="text-[11px] text-muted-foreground/70">{tc("baseUrlHint")}</p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">API Key</Label>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={tc("keyPlaceholder")}
                className="font-mono text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{tc("fieldAudio")}</Label>
              <label className="flex h-9 items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={supportsAudio}
                  onChange={(e) => setSupportsAudio(e.target.checked)}
                  className="accent-primary"
                />
                {tc("supportsAudioHint")}
              </label>
            </div>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <Button onClick={handleAdd} disabled={!name.trim() || !baseUrl.trim()} className="w-full">
            <LuPlus className="w-4 h-4 mr-1.5" />
            {tc("add")}
          </Button>

          <p className="text-[11px] text-muted-foreground/70 leading-relaxed">{tc("postAddHint")}</p>
        </CardContent>
      </Card>

      {/* 已添加的自定义平台 */}
      {customPlatforms.map(([key, provider]) => (
        <CustomPlatformCard
          key={key}
          platformKey={key}
          provider={provider}
          testState={providerTest[key]}
          testProvider={testProvider}
          setProvider={setProvider}
          onRemove={() => removeCustomPlatform(key)}
        />
      ))}
    </>
  );
}

function CustomPlatformCard({
  platformKey,
  provider,
  testState,
  testProvider,
  setProvider,
  onRemove,
}: {
  platformKey: string;
  provider: ProviderSetting;
  testState?: ProviderTestState;
  testProvider: (key: string) => void;
  setProvider: (name: string, setting: ProviderSetting) => void;
  onRemove: () => void;
}) {
  const t = useT("settings");
  const tc = useT("customPlatform");
  const protocol = CUSTOM_PROTOCOLS.find((p) => p.id === provider.protocol) ?? CUSTOM_PROTOCOLS[0];

  return (
    <Card className="glass-card">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-slate-600 to-slate-800 text-white shadow-lg">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="22" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <h3 className="font-semibold text-sm">{provider.displayName || platformKey}</h3>
                {provider.enabled && (
                  <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-400">
                    {t("providerEnabled")}
                  </span>
                )}
                <span className="inline-flex items-center rounded-full bg-primary/15 px-2 py-0.5 text-[11px] text-primary">
                  {protocol.label}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground/70 font-mono break-all">
                {provider.baseUrl}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
              title={tc("remove")}
              onClick={onRemove}
            >
              <LuTrash2 className="w-4 h-4" />
            </Button>
          </div>
        </div>

        <div className="mt-4 space-y-3">
          {/* baseUrl 可改（用户可能一开始填错端点） */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{tc("fieldBaseUrl")}</Label>
            <Input
              value={provider.baseUrl ?? ""}
              onChange={(e) => setProvider(platformKey, { ...provider, baseUrl: e.target.value })}
              placeholder="https://api.example.com/v1"
              className="font-mono text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">API Key</Label>
            <Input
              type="password"
              value={provider.apiKey}
              onChange={(e) => setProvider(platformKey, { ...provider, apiKey: e.target.value })}
              placeholder={tc("keyPlaceholder")}
              className="font-mono text-xs"
            />
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="text-xs h-7"
              disabled={!provider.apiKey || testState?.state === "testing"}
              onClick={() => testProvider(platformKey)}
            >
              {testState?.state === "testing" ? t("llmTestTesting") : t("llmTestButton")}
            </Button>
            {(() => {
              const r = testState;
              if (!r || r.state === "idle" || r.state === "testing") return null;
              const color =
                r.state === "ok" ? "text-emerald-500" : r.state === "invalid" ? "text-destructive" : "text-amber-500";
              const icon = r.state === "ok" ? "✓" : r.state === "invalid" ? "✗" : "⚠";
              return (
                <span className={`text-xs ${color}`}>
                  {icon} {r.msg}
                </span>
              );
            })()}
          </div>

          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={provider.supportsAudio ?? false}
                onChange={(e) => setProvider(platformKey, { ...provider, supportsAudio: e.target.checked })}
                className="accent-primary"
              />
              {tc("supportsAudioHint")}
            </label>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}