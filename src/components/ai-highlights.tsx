import { useEffect, useState } from "react"

interface Highlight {
  title: string
  summary: string
  whyImportant: string
  score: number
  category: string
  links: Array<{ title: string, url: string, source: string }>
}

interface Response {
  updatedAt: number
  items: Highlight[]
  cached: boolean
  stale?: boolean
}

export function AIHighlights() {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<Response>()
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!open || data) return
    const controller = new AbortController()
    setBusy(true)
    fetch("/api/ai/top10", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 503 ? "AI 推荐尚未配置或暂时不可用" : "获取新闻失败")
        return await response.json() as Response
      })
      .then(setData)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "获取新闻失败")
      })
      .finally(() => setBusy(false))
    return () => controller.abort()
  }, [open, retry])

  return (
    <section className="mx-2 mb-5 rounded-2xl border border-neutral-200/60 dark:border-neutral-700/70 overflow-hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="ai-highlights-content"
        className="flex w-full items-center justify-between gap-4 p-4 text-left bg-neutral-100/50 dark:bg-neutral-800/50 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        onClick={() => setOpen(value => !value)}
      >
        <span className="flex flex-col gap-1">
          <strong className="text-lg">✨ AI 今日必看 10 条</strong>
          <span className="text-sm opacity-65">跨平台热点精选 · 去重、重要度排序与简要解读</span>
        </span>
        <span aria-hidden="true" className="text-xl">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div id="ai-highlights-content" className="p-4">
          {busy && <p role="status" className="text-sm opacity-70">正在汇总热点并生成 AI 推荐…</p>}
          {error && (
            <div role="alert" className="text-sm">
              <p>{error}</p>
              <button type="button" className="mt-2 underline" onClick={() => { setError(""); setData(undefined); setRetry(value => value + 1) }}>重试</button>
            </div>
          )}
          {data && (
            <>
              <p className="mb-3 text-xs opacity-60">
                更新时间：{new Date(data.updatedAt).toLocaleString("zh-CN")}
                {data.stale ? " · 当前为上次成功生成结果" : ""}
                {" · 摘要仅基于榜单标题，请点击来源核实"}
              </p>
              <ol className="grid gap-3">
                {data.items.map((item, index) => (
                  <li key={item.links[0]?.url || index} className="p-3 rounded-xl border border-neutral-200/60 dark:border-neutral-700/70">
                    <div className="flex justify-between items-start gap-3">
                      <h3 className="font-semibold">{index + 1}. {item.title}</h3>
                      <span className="shrink-0 text-xs opacity-65">{item.score}/100</span>
                    </div>
                    <p className="mt-2 text-sm">{item.summary}</p>
                    <p className="mt-1 text-sm opacity-70">为什么重要：{item.whyImportant}</p>
                    <div className="flex flex-wrap gap-3 mt-2 text-xs">
                      {item.links.map(link => (
                        <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer" className="underline text-primary-600 dark:text-primary">
                          {link.source} · 查看来源
                        </a>
                      ))}
                    </div>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </section>
  )
}
