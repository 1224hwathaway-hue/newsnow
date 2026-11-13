import { aiEnv, generateHighlights, readHighlights, storeHighlights } from "#/utils/ai-top10"

const REFRESH_INTERVAL = 30 * 60 * 1000
let inflight: Promise<unknown> | undefined

export default defineEventHandler(async (event) => {
  const expected = aiEnv(event, "AI_NEWS_REFRESH_TOKEN")
  const provided = getHeader(event, "authorization")
  if (!expected || provided !== `Bearer ${expected}`) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" })
  }

  // Prevent routine refreshes within the 30-minute budget window.
  // Only the scheduled job should know the refresh token.
  const old = await readHighlights()
  if (old.ready && old.updatedAt && Date.now() - old.updatedAt < REFRESH_INTERVAL) {
    return { ...old, skipped: true }
  }

  if (inflight) throw createError({ statusCode: 409, statusMessage: "Refresh in progress" })
  inflight = (async () => {
    const items = await generateHighlights(event)
    return storeHighlights(items)
  })()
  try {
    return await inflight
  } catch (error) {
    console.error("AI refresh failed", error)
    throw createError({ statusCode: 503, statusMessage: "AI news refresh failed" })
  } finally {
    inflight = undefined
  }
})
