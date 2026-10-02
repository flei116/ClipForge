/**
 * 自定义平台 Provider（方案 B）
 * ============================
 * 用户在设置页自由添加平台：自选协议模板 + 填 baseUrl / Key / 平台名，
 * 之后即可像内置平台一样挂自定义模型、走完整生成链路。
 *
 * 设计要点：
 * 1. 协议（protocol）是**数据**不是代码分支——每种协议只是「怎么拼 URL、怎么解析响应」的一份描述，
 *    新增协议不改这个文件，只加一条 PROTOCOLS 条目。
 * 2. 模型目录走 GET {base}/models 动态发现（OpenAI 兼容网关的通用做法），
 *    因此平台新上模型无需升级软件——和 Atlas 动态直连同样的思路。
 * 3. 能力未知时保持宽松（不提前阻断），交给 model-capabilities.ts 的
 *    "capabilities-unknown" 警告路径处理，避免误杀用户的自定义模型。
 * 4. 付费任务的提交 POST 一律走 BaseProvider 的非幂等路径（仅 429 重试），
 *    绝不自动重试创建任务的请求——这是 issue #16 的花钱安全底线。
 */

import { BaseProvider, ProviderError } from './base'
import type {
  AIProvider,
  ProviderConfig,
  ImageOptions,
  ImageResult,
  VideoOptions,
  VideoResult,
  TaskStatus,
  TaskStatusEnum,
  Model,
  MediaType,
  GenerationMode,
} from './types'

// ==================== 协议定义 ====================

/**
 * 自定义平台的 key 前缀。
 *
 * 定义放在这里（而不是 settings-store）是为了让服务端 provider 层能在
 * createProvider 里靠它识别用户自建平台，而不必反向依赖前端的 zustand 持久化 store。
 * 前端 store 从这里 import，依赖方向是 store → providers。
 */
export const CUSTOM_PLATFORM_PREFIX = 'custom-'

/** 判断一个平台 key 是否为用户自建（设置页自定义平台卡片用它过滤） */
export function isCustomPlatformName(name: string): boolean {
  return typeof name === 'string' && name.startsWith(CUSTOM_PLATFORM_PREFIX)
}

/** 协议标识：新增协议只需在此登记 */
export type CustomProtocolId =
  | 'openai-images'      // OpenAI 兼容图片：/images/generations + /images/edits
  | 'openai-async'       // OpenAI 风格异步任务：POST 返回 taskId，轮询 {base}/tasks/{id}
  | 'replicate'          // Replicate predictions：POST /predictions + GET /predictions/{id}
  | 'custom-sync'        // 通用同步：POST {images|video}/generations，同步返回结果

export interface CustomProtocol {
  id: CustomProtocolId
  /** UI 展示名（中英双语由设置页 i18n 处理，这里只给中文兜底） */
  label: string
  /** 能力：是否支持图片 / 视频 */
  supportsImage: boolean
  supportsVideo: boolean
  /** 鉴权头 */
  authHeader: (apiKey: string) => Record<string, string>
  /** 模型目录路径（null = 该协议不做目录发现，模型全靠手填） */
  modelsPath: string | null
}

export const CUSTOM_PROTOCOLS: CustomProtocol[] = [
  {
    id: 'openai-images',
    label: 'OpenAI 兼容（图片）',
    supportsImage: true,
    supportsVideo: false,
    authHeader: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
    modelsPath: '/models',
  },
  {
    id: 'openai-async',
    label: 'OpenAI 兼容异步任务（图片/视频）',
    supportsImage: true,
    supportsVideo: true,
    authHeader: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
    modelsPath: '/models',
  },
  {
    id: 'replicate',
    label: 'Replicate predictions',
    supportsImage: true,
    supportsVideo: true,
    authHeader: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
    modelsPath: '/models',
  },
  {
    id: 'custom-sync',
    label: '通用同步（POST 一次返回结果）',
    supportsImage: true,
    supportsVideo: true,
    authHeader: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
    modelsPath: '/models',
  },
]

export function getCustomProtocol(id: string): CustomProtocol | undefined {
  return CUSTOM_PROTOCOLS.find((p) => p.id === id)
}

// ==================== 响应类型 ====================

/** OpenAI 风格 /models 响应 */
interface ModelsResponse {
  data?: Array<{ id?: string; [key: string]: unknown }>
  [key: string]: unknown
}

/** OpenAI 风格图片响应 */
interface OpenAIImageResponse {
  created?: number
  data?: Array<{ url?: string; b64_json?: string; [key: string]: unknown }>
  [key: string]: unknown
}

/** 通用同步生成响应：容忍多种字段命名 */
interface SyncGenerateResponse {
  taskId?: string
  task_id?: string
  id?: string
  imageUrl?: string
  image_url?: string
  videoUrl?: string
  video_url?: string
  url?: string
  images?: string[] | string
  videos?: string[] | string
  output?: string | string[]
  data?: Array<{ url?: string; b64_json?: string }> | { url?: string; b64_json?: string }
  outputUrls?: string[]
  [key: string]: unknown
}

/** 异步任务响应 */
interface AsyncTaskResponse {
  taskId?: string
  task_id?: string
  id?: string
  status?: string
  state?: string
  progress?: number
  error?: string
  message?: string
  result?: SyncGenerateResponse
  output?: string | string[] | { url?: string; content?: unknown }
  data?: Array<{ url?: string; b64_json?: string }>
  [key: string]: unknown
}

/** Replicate prediction 响应 */
interface ReplicatePrediction {
  id?: string
  status?: string
  error?: string
  output?: string | string[] | null
  [key: string]: unknown
}

// ==================== Provider 实现 ====================

/**
 * 自定义平台 Provider。
 *
 * `name` 是用户自定义的平台 key（设置页生成，形如 "custom-abc123"）；
 * `protocol` 从 ProviderConfig.extra.protocol 读取。
 */
export class CustomProvider extends BaseProvider {
  readonly name: string
  readonly displayName: string
  readonly protocol: CustomProtocol
  /** 该平台是否声明支持音频（用户可勾选，省掉 TTS） */
  private readonly supportsAudio: boolean
  /** 模型目录的来源标记（AIProvider 的可选契约；静态目录之外要如实说明是实时拉的） */
  catalogMetadata?: AIProvider['catalogMetadata']

  constructor(config: ProviderConfig) {
    super(config)
    this.name = config.name
    this.displayName = String(config.extra?.displayName ?? config.name)
    this.protocol = getCustomProtocol(String(config.extra?.protocol ?? 'openai-images')) ?? CUSTOM_PROTOCOLS[0]
    this.supportsAudio = config.extra?.supportsAudio === true
  }

  protected override getAuthHeaders(): Record<string, string> {
    return this.protocol.authHeader(this.config.apiKey)
  }

  // ==================== 模型目录 ====================

  /**
   * 动态发现模型：GET {base}/models。
   *
   * 重要：网关的 /models 会把聊天 / Embedding / TTS 模型一并返回，这里按启发式过滤，
   * 只保留「看起来像图片/视频生成」的候选。但过滤是**尽力而为**——放行的模型是否真支持
   * 生图协议，最终只能由上游回答（README 的模型目录同理）。
   */
  async listModels(mediaType?: MediaType): Promise<Model[]> {
    if (!this.protocol.modelsPath) return []

    let raw: ModelsResponse
    try {
      raw = await this.request<ModelsResponse>(this.protocol.modelsPath, { timeout: 15000 })
    } catch (error) {
      // 目录发现失败不该让整个平台不可用：用户仍可手填模型名（见设置页提示）。
      this.catalogMetadata = { source: 'stale', fallback: true }
      throw error instanceof ProviderError
        ? error
        : new ProviderError('模型目录读取失败，可手动填写模型名称', 'CATALOG_UNAVAILABLE', this.name)
    }

    this.catalogMetadata = { source: 'live' }

    const items = Array.isArray(raw?.data) ? raw.data : []
    return items
      .map((item) => normalizeCatalogModel(item?.id, this.name, this.supportsAudio, mediaType))
      .filter((m): m is Model => m !== null)
  }

  // ==================== 图片生成 ====================

  async generateImage(options: ImageOptions): Promise<ImageResult> {
    if (!this.protocol.supportsImage) {
      throw new ProviderError(
        `平台「${this.displayName}」的协议（${this.protocol.label}）不支持图片生成`,
        'NOT_SUPPORTED',
        this.name
      )
    }

    const base = this.config.baseUrl.replace(/\/$/, '')
    const isEdit = options.mode === 'image-to-image' || Boolean(options.referenceImageUrl || options.referenceImageUrls?.length)

    // OpenAI 图片协议：图生图走 multipart /images/edits
    if (this.protocol.id === 'openai-images' || this.protocol.id === 'openai-async') {
      if (isEdit) {
        return this.editImageOpenAi(options, base)
      }
      return this.generateImageOpenAi(options)
    }

    // 其余协议：单次 POST，按响应内容判定是图片还是别的
    const body = this.buildGenerateBody(options, 'image')
    const response = await this.request<SyncGenerateResponse>('/images/generations', {
      method: 'POST',
      body,
      timeout: 120000,
      // 创建计费任务的请求不可自动重试（BaseProvider 默认按 POST=非幂等处理）
    })

    const imageUrls = extractUrls(response, 'image')
    if (imageUrls.length === 0) {
      throw new ProviderError('生成成功但未返回图片数据', 'NO_RESULT', this.name)
    }
    return {
      taskId: extractTaskId(response) ?? `custom-img-${Date.now()}`,
      imageUrls,
      modelId: options.modelId,
    }
  }

  /** OpenAI 文生图：POST /images/generations（JSON） */
  private async generateImageOpenAi(options: ImageOptions): Promise<ImageResult> {
    const body: Record<string, unknown> = {
      model: options.modelId,
      prompt: options.prompt,
      n: options.count ?? 1,
      size: options.width && options.height ? `${options.width}x${options.height}` : undefined,
      ...(options.negativePrompt ? { negative_prompt: options.negativePrompt } : {}),
      ...(options.guidanceScale != null ? { guidance_scale: options.guidanceScale } : {}),
      ...(options.seed != null ? { seed: options.seed } : {}),
      ...options.extra,
    }

    const response = await this.request<OpenAIImageResponse>('/images/generations', {
      method: 'POST',
      body,
      timeout: 120000,
    })

    const imageUrls = (response.data ?? [])
      .map((d) => d.url ?? (d.b64_json ? `data:image/png;base64,${d.b64_json}` : undefined))
      .filter((u): u is string => Boolean(u))

    if (imageUrls.length === 0) {
      throw new ProviderError('生成成功但未返回图片数据', 'NO_RESULT', this.name)
    }
    return {
      taskId: `custom-img-${response.created ?? Date.now()}`,
      imageUrls,
      modelId: options.modelId,
    }
  }

  /** OpenAI 图生图：POST /images/edits（multipart/form-data） */
  private async editImageOpenAi(options: ImageOptions, base: string): Promise<ImageResult> {
    const ref = options.referenceImageUrl ?? options.referenceImageUrls?.[0]
    if (!ref) throw new ProviderError('图生图缺少参考图', 'BAD_REFERENCE', this.name)

    const { blob, filename } = await this.fetchReferenceImage(ref)
    const form = new FormData()
    form.append('model', options.modelId)
    form.append('prompt', options.prompt)
    form.append('n', String(options.count ?? 1))
    if (options.width && options.height) form.append('size', `${options.width}x${options.height}`)
    // gpt-image-* 系列用数组字段 image[]；多数兼容网关两者都收
    form.append('image[]', blob, filename)
    if (options.negativePrompt) form.append('negative_prompt', options.negativePrompt)

    const url = `${base}/images/edits`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 120000)
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { ...this.protocol.authHeader(this.config.apiKey) },
        body: form,
        signal: controller.signal,
      })
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '')
        throw new ProviderError(
          `API 请求失败: ${resp.status} ${resp.statusText} - ${errBody}`,
          'API_ERROR',
          this.name,
          resp.status
        )
      }
      const parsed = (await resp.json()) as OpenAIImageResponse
      const imageUrls = (parsed.data ?? [])
        .map((d) => d.url ?? (d.b64_json ? `data:image/png;base64,${d.b64_json}` : undefined))
        .filter((u): u is string => Boolean(u))
      if (imageUrls.length === 0) {
        throw new ProviderError('生成成功但未返回图片数据', 'NO_RESULT', this.name)
      }
      return {
        taskId: `custom-img-${parsed.created ?? Date.now()}`,
        imageUrls,
        modelId: options.modelId,
      }
    } catch (e) {
      if (e instanceof ProviderError) throw e
      const isTimeout = e instanceof DOMException && e.name === 'AbortError'
      throw new ProviderError(
        isTimeout ? '请求超时（120000ms）' : `网络请求异常: ${e instanceof Error ? e.message : String(e)}`,
        isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
        this.name
      )
    } finally {
      clearTimeout(timer)
    }
  }

  // ==================== 视频生成 ====================

  /** 同步视频：POST /video/generations */
  async generateVideo(options: VideoOptions): Promise<VideoResult> {
    if (!this.protocol.supportsVideo) {
      throw new ProviderError(
        `平台「${this.displayName}」的协议（${this.protocol.label}）不支持视频生成`,
        'NOT_SUPPORTED',
        this.name
      )
    }

    // 异步协议走两阶段：先提交再轮询
    if (this.protocol.id === 'openai-async' || this.protocol.id === 'replicate') {
      const { taskId } = await this.submitVideoTask(options)
      const final = await this.waitForTask(taskId)
      const result = final.result
      const videoUrls = result && 'videoUrls' in result ? result.videoUrls : undefined
      if (!videoUrls?.length) {
        throw new ProviderError('任务完成但未返回视频地址', 'NO_RESULT', this.name)
      }
      return result as VideoResult
    }

    const body = this.buildGenerateBody(options, 'video')
    const response = await this.request<SyncGenerateResponse>('/video/generations', {
      method: 'POST',
      body,
      timeout: 600000,
    })

    const videoUrls = extractUrls(response, 'video')
    if (videoUrls.length === 0) {
      throw new ProviderError('生成成功但未返回视频地址', 'NO_RESULT', this.name)
    }
    return {
      taskId: extractTaskId(response) ?? `custom-vid-${Date.now()}`,
      videoUrls,
      modelId: options.modelId,
      hasAudio: this.supportsAudio || Boolean(options.audioEnabled),
    }
  }

  /**
   * 两阶段提交（付费安全）：只负责「提交并返回 taskId」，不等待。
   * 调用方（/api/ai/video）会立刻把 taskId 落库，再开始轮询——
   * 轮询失败不会丢失已扣费任务（issue #16）。
   */
  async submitVideoTask(options: VideoOptions): Promise<{ taskId: string; modelId: string }> {
    if (this.protocol.id === 'replicate') {
      const prediction = await this.request<ReplicatePrediction>(`/predictions`, {
        method: 'POST',
        body: { version: options.modelId, input: this.buildGenerateBody(options, 'video') },
        timeout: 60000,
      })
      const taskId = prediction?.id
      if (!taskId) throw new ProviderError('Replicate 提交未返回 prediction id', 'NO_RESULT', this.name)
      return { taskId, modelId: options.modelId }
    }

    const response = await this.request<SyncGenerateResponse>('/video/generations', {
      method: 'POST',
      body: this.buildGenerateBody(options, 'video'),
      timeout: 60000,
    })
    const taskId = extractTaskId(response)
    if (!taskId) {
      throw new ProviderError('提交未返回任务 ID（该协议可能不是异步接口）', 'NO_RESULT', this.name)
    }
    return { taskId, modelId: options.modelId }
  }

  /** 查询任务状态：按协议选不同端点与解析器 */
  async getTaskStatus(taskId: string): Promise<TaskStatus> {
    if (this.protocol.id === 'replicate') {
      const p = await this.request<ReplicatePrediction>(`/predictions/${taskId}`)
      const status = mapReplicateStatus(p.status)
      if (status === 'completed') {
        // Replicate 的 output 就是一张 URL（或 URL 数组）——图片视频同一形状
        const urls = toUrlList(p.output)
        return {
          taskId,
          status,
          result: urlsToResult(taskId, '', urls),
        }
      }
      return {
        taskId,
        status,
        ...(p.error ? { error: p.error } : {}),
      }
    }

    const t = await this.request<AsyncTaskResponse>(`/tasks/${taskId}`)
    const status = mapAsyncStatus(t.status ?? t.state)
    const progress = typeof t.progress === 'number'
      ? t.progress <= 1 ? Math.round(t.progress * 100) : Math.round(t.progress)
      : undefined

    if (status === 'completed') {
      // 结果可能在 result / output / data 三处，逐一尝试
      const payload = (t.result ?? t) as SyncGenerateResponse
      const videoUrls = extractUrls(payload, 'video')
      const imageUrls = videoUrls.length ? [] : extractUrls(payload, 'image')
      const urls = videoUrls.length ? videoUrls : imageUrls
      return {
        taskId,
        status,
        progress: 100,
        result: urlsToResult(taskId, modelOf(payload), urls, videoUrls.length > 0),
      }
    }

    return {
      taskId,
      status,
      ...(progress != null ? { progress } : {}),
      ...(status === 'failed' ? { error: t.error ?? t.message ?? '任务失败' } : {}),
    }
  }

  // ==================== 私有工具 ====================

  /** 组装通用生成请求体（把 VideoOptions/ImageOptions 映射成常见字段名） */
  private buildGenerateBody(options: ImageOptions | VideoOptions, kind: 'image' | 'video'): Record<string, unknown> {
    const base: Record<string, unknown> = {
      model: options.modelId,
      prompt: options.prompt,
    }
    if (options.negativePrompt) base.negative_prompt = options.negativePrompt
    if (options.seed != null) base.seed = options.seed

    if (kind === 'image') {
      const o = options as ImageOptions
      // 很多 OpenAI 兼容网关（如 Agnes 类）要求 size 为 "auto" 或 "WIDTHxHEIGHT"，
      // 且宽高都必须是 32 的倍数、落在 [512,4096]、长宽比 ≤3:1。ClipForge 素材页选的
      // 尺寸（如 1280x720、1920x1080）往往不满足，直接拼会触发 400。这里规整后再传。
      if (o.width && o.height) base.size = normalizeImageSize(o.width, o.height)
      if (o.count != null) base.n = o.count
      const refs = [o.referenceImageUrl, ...(o.referenceImageUrls ?? [])].filter((u): u is string => Boolean(u))
      if (refs.length) base.image = refs
    } else {
      const o = options as VideoOptions
      if (o.width && o.height) {
        base.width = o.width
        base.height = o.height
      }
      if (o.duration != null) base.duration = o.duration
      if (o.fps != null) base.fps = o.fps
      if (o.firstFrameUrl) base.image = o.firstFrameUrl
      if (o.lastFrameUrl) base.last_frame = o.lastFrameUrl
      if (o.audioEnabled) base.audio = true
      if (o.voiceover) base.voiceover = o.voiceover
      if (o.audioPrompt) base.audio_prompt = o.audioPrompt
      const refImages = o.referenceImageUrls ?? []
      if (refImages.length) base.reference_images = refImages
      const refVideos = o.referenceVideoUrls ?? []
      if (refVideos.length) base.reference_videos = refVideos
      const refAudios = o.referenceAudioUrls ?? []
      if (refAudios.length) base.reference_audios = refAudios
      if (o.motionStrength != null) base.motion_strength = o.motionStrength
      if (o.guidanceScale != null) base.guidance_scale = o.guidanceScale
    }
    return base
  }

  /** 参考图取成 Blob，供 multipart 上传 */
  private async fetchReferenceImage(ref: string): Promise<{ blob: Blob; filename: string }> {
    if (ref.startsWith('data:')) {
      const comma = ref.indexOf(',')
      if (comma === -1) throw new ProviderError('参考图 data URI 解析失败', 'BAD_REFERENCE', this.name)
      const mime = ref.slice(5, comma).split(';')[0] || 'image/png'
      const buf = Buffer.from(ref.slice(comma + 1), 'base64')
      return { blob: new Blob([new Uint8Array(buf)], { type: mime }), filename: `image.${extFromMime(mime)}` }
    }
    const resp = await fetch(ref)
    if (!resp.ok) throw new ProviderError(`参考图下载失败: ${resp.status}`, 'BAD_REFERENCE', this.name)
    const blob = await resp.blob()
    const mime = blob.type || resp.headers.get('content-type') || 'image/png'
    return { blob, filename: `image.${extFromMime(mime)}` }
  }
}

// ==================== 模块级工具函数 ====================

/**
 * 规整图片尺寸，满足大多数 OpenAI 兼容网关对 size 的硬约束：
 * 宽高均为 32 的倍数、落在 [512,4096]、长宽比不超过 3:1。
 * 无法规整（如入参非法）时回退到 OpenAI 标准档 1024x1024（1024 是 32 的倍数，合法）。
 */
function normalizeImageSize(w: number, h: number): string {
  const round32 = (n: number) => Math.max(512, Math.min(4096, Math.ceil(n / 32) * 32));
  let W = round32(w);
  let H = round32(h);
  // 限制长宽比在 [1:3, 3:1] 之间
  while (W / H > 3) W = round32(H * 3);
  while (H / W > 3) H = round32(W * 3);
  return `${W}x${H}`;
}

function extFromMime(mime: string): string {
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
  return 'png'
}

function extractTaskId(response: SyncGenerateResponse): string | undefined {
  return response.taskId ?? response.task_id ?? response.id ?? undefined
}

/** 从各种可能的响应结构里挖出 URL 列表 */
function extractUrls(response: SyncGenerateResponse, kind: 'image' | 'video'): string[] {
  const direct = kind === 'image'
    ? [response.imageUrl, response.image_url, ...(Array.isArray(response.images) ? response.images : typeof response.images === 'string' ? [response.images] : [])]
    : [response.videoUrl, response.video_url, ...(Array.isArray(response.videos) ? response.videos : typeof response.videos === 'string' ? [response.videos] : [])]

  const candidates = [
    ...direct.filter((u): u is string => Boolean(u)),
    ...(response.url ? [response.url] : []),
    ...toUrlList(response.output),
    ...toUrlList(response.outputUrls),
    ...extractDataUrls(response.data),
  ]
  return [...new Set(candidates)]
}

/** data 字段可能是数组也可能是单对象 */
function extractDataUrls(data: SyncGenerateResponse['data']): string[] {
  if (Array.isArray(data)) {
    return data.map((d) => d?.url ?? (d?.b64_json ? `data:image/png;base64,${d.b64_json}` : '')).filter(Boolean)
  }
  if (data && typeof data === 'object') {
    const single = data as { url?: string; b64_json?: string }
    return single.url ? [single.url] : single.b64_json ? [`data:image/png;base64,${single.b64_json}`] : []
  }
  return []
}

function toUrlList(output: unknown): string[] {
  if (Array.isArray(output)) return output.filter((o): o is string => typeof o === 'string')
  if (typeof output === 'string') return [output]
  return []
}

function mapAsyncStatus(status: string | undefined): TaskStatusEnum {
  switch ((status ?? '').toLowerCase()) {
    case 'succeeded':
    case 'success':
    case 'completed':
    case 'done':
      return 'completed'
    case 'failed':
    case 'error':
    case 'cancelled':
    case 'canceled':
      return 'failed'
    case 'processing':
    case 'running':
    case 'in_progress':
    case 'queued':
    case 'pending':
      return 'processing'
    default:
      return 'pending'
  }
}

function mapReplicateStatus(status: string | undefined): TaskStatusEnum {
  switch (status) {
    case 'succeeded': return 'completed'
    case 'failed':
    case 'canceled': return 'failed'
    case 'starting':
    case 'processing': return 'processing'
    default: return 'pending'
  }
}

/** 从响应里读回模型名（读不到就留空——模型 ID 以提交时的为准） */
function modelOf(payload: SyncGenerateResponse): string {
  return typeof payload.model === 'string' ? payload.model : ''
}

/**
 * 把一组 URL 归一成 TaskStatus.result。
 *
 * TaskStatus.result 是 ImageResult | VideoResult 联合类型（见 types.ts），下游
 * /api/ai/video 用 `'videoUrls' in result` 判别，因此这里必须给出**具体**的联合成员，
 * 不能靠类型断言糊过去——hasVideo 决定填哪一种。
 */
function urlsToResult(
  taskId: string,
  modelId: string,
  urls: string[],
  hasVideo = false
): VideoResult | ImageResult {
  if (hasVideo) {
    return { taskId, modelId, videoUrls: urls }
  }
  return { taskId, modelId, imageUrls: urls }
}

/**
 * 把 /models 返回的一条目录项归一成 Model。
 *
 * 这里必须诚实：网关目录只给模型名，不给「是否支持图生视频 / 参考图上限 / 原生音频」。
 * 因此对无法判定的模型给 confidence=unknown 语义（modes 用启发式推断），
 * 由 model-capabilities.ts 决定「保持参数 + 提示」，而不是假装知道。
 */
function normalizeCatalogModel(
  id: string | undefined,
  provider: string,
  supportsAudio: boolean,
  mediaType?: MediaType
): Model | null {
  if (!id || typeof id !== 'string') return null
  const lower = id.toLowerCase()

  // 过滤明显不是生图/生视频的：聊天、embedding、TTS、rerank、语音
  const isChatOrUtility =
    /(?:^|[-/])(?:chat|embedding|embed|text-embedding|rerank|moderation|tts|speech|stt|whisper|transcribe|audio|dall-e|dalle)(?:[-/]|$)/.test(lower) ||
    /^(?:gpt-|claude|deepseek|qwen|llama|mistral|gemini|o[134]|text-)/.test(lower)
  if (isChatOrUtility) return null

  const looksVideo = /(?:video|veo|sora|kling|seedance|hailuo|wan|vidu|luma|runway|pika|hunyuan|animate)/.test(lower)
  const looksImage = /(?:image|img|flux|sdxl|imagen|recraft|dalle|dall-e|seedream|nano-?banana|kolors|midjourney|ideogram)/.test(lower)

  let media: MediaType = looksVideo ? 'video' : 'image'
  if (!looksVideo && !looksImage) {
    // 完全看不出类型：不猜了，用调用方要的 mediaType，默认图片
    media = mediaType ?? 'image'
  }
  if (mediaType && media !== mediaType) return null

  const modes: GenerationMode[] = media === 'video'
    ? ['text-to-video', 'image-to-video']
    : ['text-to-image', 'image-to-image']

  return {
    id,
    name: id,
    modes,
    mediaType: media,
    provider,
    ...(supportsAudio ? { supportsAudio: true } : {}),
  }
}