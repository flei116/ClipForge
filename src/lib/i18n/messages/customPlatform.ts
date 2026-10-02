import type { NamespaceMessages } from "../config";

// customPlatform 命名空间词条：设置页「平台 Key」标签下的自定义平台卡片（方案 B）
export const customPlatform: NamespaceMessages = {
  zh: {
    title: "添加自定义平台",
    desc: "接入任意 OpenAI 兼容网关、中转站或自建服务：自选协议，填地址和 Key 即可像内置平台一样使用。",
    fieldName: "平台名称",
    namePlaceholder: "例如：我的中转站",
    fieldProtocol: "协议",
    protocolSupportsVideo: "该协议支持图片与视频生成。",
    protocolImageOnly: "该协议仅支持图片生成。",
    fieldBaseUrl: "API 地址（baseUrl）",
    baseUrlHint: "填到路径这一层，末尾不必带斜杠。协议会自动在其后拼接 /images/generations 等路径。",
    fieldAudio: "音频",
    supportsAudioHint: "该平台视频模型原生带音频（可省配音）",
    keyPlaceholder: "输入 API Key",
    add: "添加平台",
    remove: "删除该平台",
    errName: "请填写平台名称",
    errBaseUrl: "请填写 API 地址",
    errBaseUrlInvalid: "API 地址格式不正确，需以 http:// 或 https:// 开头",
    errBaseUrlScheme: "API 地址必须使用 http 或 https",
    postAddHint:
      "添加后到「高级 · 自定义模型接入点」把模型挂到这个平台上，再在素材页选择模型即可生成。",
  },
  en: {
    title: "Add a custom platform",
    desc: "Connect any OpenAI-compatible gateway, relay, or self-hosted service: pick a protocol, enter the endpoint and key, then use it like a built-in platform.",
    fieldName: "Platform name",
    namePlaceholder: "e.g. My relay",
    fieldProtocol: "Protocol",
    protocolSupportsVideo: "This protocol supports both image and video generation.",
    protocolImageOnly: "This protocol supports image generation only.",
    fieldBaseUrl: "API endpoint (baseUrl)",
    baseUrlHint:
      "Include the path prefix; no trailing slash needed. Paths like /images/generations are appended automatically.",
    fieldAudio: "Audio",
    supportsAudioHint: "Video models natively include audio (skips TTS)",
    keyPlaceholder: "Enter the API key",
    add: "Add platform",
    remove: "Remove this platform",
    errName: "Enter a platform name",
    errBaseUrl: "Enter the API endpoint",
    errBaseUrlInvalid: "Invalid endpoint — it must start with http:// or https://",
    errBaseUrlScheme: "The endpoint must use http or https",
    postAddHint:
      'After adding, hang your models on it under "Advanced · custom model endpoints", then pick the model on the assets page.',
  },
};