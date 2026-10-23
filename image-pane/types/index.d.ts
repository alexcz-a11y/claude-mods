export type ImageEntry = {
  /** 这次会话里的序号，从 1 起 */
  n: number
  origin: 'user' | 'read' | 'screenshot' | 'tool'
  /** 产生它的工具名；用户发的图没有 */
  tool?: string
  /** 子 agent 的 id；主循环没有 */
  agentId?: string
  /** 写好的 PNG 绝对路径；转换失败时没有，只显示文字 */
  file?: string
  /** 保存时留下的未缩小原件 */
  original?: string
  /** 真实来源：Read 读的文件，或贴图时引擎存的原文件 */
  sourcePath?: string
  mediaType: string
  width?: number
  height?: number
  /** Date.now() */
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'image-pane': {
      images: ImageEntry[]
      /** 正在看的序号；null 表示一直跟着最新一张 */
      selected: number | null
      /** 已收过的图的指纹，去重用 */
      seen: string[]
    }
  }
}
