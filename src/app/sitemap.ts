import { MetadataRoute } from 'next';

const BASE_URL = 'https://tradevision-ai-bay.vercel.app';

// Use a fixed build-time date so lastModified doesn't change on every request
const LAST_MODIFIED = new Date('2026-02-24');

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: BASE_URL, lastModified: LAST_MODIFIED, changeFrequency: 'weekly', priority: 1 },
    { url: `${BASE_URL}/trades`, lastModified: LAST_MODIFIED, changeFrequency: 'daily', priority: 0.9 },
    { url: `${BASE_URL}/analytics`, lastModified: LAST_MODIFIED, changeFrequency: 'daily', priority: 0.9 },
    { url: `${BASE_URL}/insights`, lastModified: LAST_MODIFIED, changeFrequency: 'daily', priority: 0.8 },
    { url: `${BASE_URL}/calculator`, lastModified: LAST_MODIFIED, changeFrequency: 'monthly', priority: 0.6 },
    { url: `${BASE_URL}/import`, lastModified: LAST_MODIFIED, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${BASE_URL}/report`, lastModified: LAST_MODIFIED, changeFrequency: 'daily', priority: 0.7 },
    { url: `${BASE_URL}/settings`, lastModified: LAST_MODIFIED, changeFrequency: 'monthly', priority: 0.3 },
  ];
}
