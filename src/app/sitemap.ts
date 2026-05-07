import { MetadataRoute } from "next";

const BASE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://tradevision-ai-bay.vercel.app";

// Use a fixed build-time date so lastModified doesn't change on every request
const LAST_MODIFIED = new Date("2026-02-24");

export default function sitemap(): MetadataRoute.Sitemap {
  // R67-r15 audit fix (HIGH): only public, non-auth-gated routes belong in
  // the sitemap. Previously /trades /analytics /insights /report /settings
  // /import were exposed to search engines despite being personal-data
  // pages — both an SEO/UX bug (login walls in search results) and a
  // privacy concern (URL leak in indexed snippets).
  return [
    {
      url: BASE_URL,
      lastModified: LAST_MODIFIED,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${BASE_URL}/calculator`,
      lastModified: LAST_MODIFIED,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${BASE_URL}/login`,
      lastModified: LAST_MODIFIED,
      changeFrequency: "monthly",
      priority: 0.5,
    },
  ];
}
