import { readHighlights } from "#/utils/ai-top10"

// Public endpoint: read-only. Never invokes the paid AI provider.
export default defineEventHandler(async (event) => {
  setHeader(event, "Cache-Control", "public, max-age=60, s-maxage=300")
  try {
    return await readHighlights()
  } catch (error) {
    console.error("Reading AI highlights failed", error)
    throw createError({ statusCode: 503, statusMessage: "AI news cache unavailable" })
  }
})
