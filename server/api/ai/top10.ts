import { getters } from "#/getters"
import { getCacheTable } from "#/database/cache"
import type { SourceID, NewsItem } from "@shared/types"

// Keep the first version bounded: do not fan out to every configured news source.
const SOURCE_IDS = ["weibo", "zhihu", "toutiao", "douyin", "wallstreetcn-hot", "36kr-renqi", "zaobao", "aihot"] as const satisfies readonly SourceID[]
const TTL_MS = 30 * 60 * 1000
const MAX_INPUT = 100
const TIMEOUT_MS = 18_000

interface Candidate {
  id: string
  title: string
  url: string
  source: string
  rank: number
}

interface Highlight {
  title: string
  summary: string
  whyImportant: string
  score: number
  category: string
  links: Array<{ title: string, url: string, source: string }>
}

let snapshot: { at: number, items: Highlight[] } | undefined
let pending: Promise<Highlight[]> | undefined

function env(name: string): string | undefined {
  // Nitro Node deployments; Cloudflare may expose variables via process.env.
  return process.env[name]
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "").slice(0, 100)
}

async function getCandidates(): Promise<Candidate[]> {
  const table = await getCacheTable().catch(() => undefined)
  const lists = await Promise.allSettled(SOURCE_IDS.map(async (source) => {
    const cached = await table?.get(source)
    const items: NewsItem[] = cached?.items?.length ? cached.items : await getters[source]()
    return items.slice(0, 20).map((item, index) => ({
      id: `${source}:${item.id}`,
      title: item.title.trim().slice(0, 180),
      url: item.mobileUrl || item.url,
      source,
      rank: index + 1,
    })).filter(item => item.title && /^https?:\/\//.test(item.url))
  }))
  const seen = new Set<string>()
  const result: Candidate[] = []
  for (const list of lists) {
    if (list.status !== "fulfilled") continue
    for (const item of list.value) {
      const key = normalize(item.title)
      if (!key || seen.has(key)) continue
      seen.add(key)
      result.push(item)
    }
  }
  return result.slice(0, MAX_INPUT)
}

function validate(raw: unknown, candidates: Candidate[]): Highlight[] {
  const obj = raw as { items?: unknown }
  if (!Array.isArray(obj?.items)) throw new Error("AI response has no items")
  const byId = new Map(candidates.map(item => [item.id, item]))
  const used = new Set<string>()
  const output: Highlight[] = []
  for (const value of obj.items) {
    if (!value || typeof value !== "object") continue
    const entry = value as Record<string, unknown>
    if (!Array.isArray(entry.ids)) continue
    const links = entry.ids
      .filter((id): id is string => typeof id === "string")
      .map(id => byId.get(id))
      .filter((item): item is Candidate => Boolean(item))
      .slice(0, 4)
      .map(({ title, url, source }) => ({ title, url, source }))
    if (!links.length || used.has(links[0].url)) continue
    const title = String(entry.title ?? "").trim().slice(0, 140)
    const summary = String(entry.summary ?? "").trim().slice(0, 300)
    const whyImportant = String(entry.whyImportant ?? "").trim().slice(0, 200)
    if (!title || !summary || !whyImportant) continue
    used.add(links[0].url)
    output.push({
      title,
      summary,
      whyImportant,
      score: Math.min(100, Math.max(0, Number(entry.score) || 0)),
      category: String(entry.category ?? "综合").slice(0, 30),
      links,
    })
    if (output.length === 10) break
  }
  if (!output.length) throw new Error("AI returned no valid news")
  return output
}

async function generate(): Promise<Highlight[]> {
  const key = env("AI_NEWS_API_KEY")
  if (!key) throw createError({ statusCode: 503, statusMessage: "AI_NEWS_API_KEY is not configured" })
  const candidates = await getCandidates()
  if (candidates.length < 10) throw createError({ statusCode: 503, statusMessage: "Not enough available news sources" })
  const baseUrl = (env("AI_NEWS_BASE_URL") || "https://api.openai.com/v1").replace(/\/$/, "")
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: env("AI_NEWS_MODEL") || "gpt-4o-mini",
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "You are a Chinese-language news editor. From provided NEWS HEADLINES ONLY, choose 10 DISTINCT important events, preferring broad real-world consequence over celebrity gossip. Assess cross-platform rank 30%, societal impact 25%, event significance 20%, freshness 15%, informational value 10%. Return ONLY a JSON object with items: [{ids: string[], title: string, summary: string, whyImportant: string, score: number, category: string}]. ids must contain 1-4 EXACT input IDs. Never invent event details, dates, numbers, quotations, developments, or source IDs. Headlines alone do not prove the full story: write cautious one-sentence summaries that explicitly reflect limited headline evidence; if uncertain say '据相关榜单标题显示'. Keep the 10 entries event-distinct; scores 0-100. Provide whyImportant as a possible impact, not as verified fact.",
          },
          { role: "user", content: JSON.stringify(candidates.map(({ id, title, source, rank }) => ({ id, title, source, rank }))) },
        ],
      }),
    })
    if (!response.ok) throw new Error(`AI provider returned HTTP ${response.status}`)
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
    const message = data.choices?.[0]?.message?.content
    if (!message) throw new Error("AI provider returned empty response")
    return validate(JSON.parse(message), candidates)
  } finally {
    clearTimeout(timeout)
  }
}

export default defineEventHandler(async () => {
  const now = Date.now()
  if (snapshot && now - snapshot.at < TTL_MS) return { updatedAt: snapshot.at, items: snapshot.items, cached: true }
  pending ??= generate().then((items) => {
    snapshot = { at: Date.now(), items }
    return items
  }).finally(() => { pending = undefined })
  try {
    const items = await pending
    return { updatedAt: snapshot!.at, items, cached: false }
  } catch (error) {
    if (snapshot) return { updatedAt: snapshot.at, items: snapshot.items, cached: true, stale: true }
    if (error && typeof error === "object" && "statusCode" in error) throw error
    console.error("AI highlights failed", error)
    throw createError({ statusCode: 503, statusMessage: "AI highlights temporarily unavailable" })
  }
})
