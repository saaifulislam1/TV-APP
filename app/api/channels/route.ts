import { NextResponse } from "next/server";

type Country = {
  code: string;
  name: string;
  flag?: string;
};

type Channel = {
  id: string;
  name: string;
  country: string;
  categories: string[];
  is_nsfw: boolean;
  website?: string | null;
};

type Stream = {
  channel: string | null;
  title: string;
  url: string;
  quality?: string | null;
  label?: string | null;
  referrer?: string | null;
  user_agent?: string | null;
};

type Logo = {
  channel: string;
  url: string;
  in_use: boolean;
};

type Category = {
  id: string;
  name: string;
};

type BlocklistItem = {
  channel: string;
};

type ChannelEntry = {
  id: string;
  name: string;
  countryCode: string;
  countryName: string;
  flag: string;
  categories: string[];
  logo?: string;
  website?: string | null;
  streams: Stream[];
  isSports: boolean;
  rankScore: number;
  verified: boolean;
};

const API_ROOT = "https://iptv-org.github.io/api";
const FEATURED_PER_COUNTRY = 30;
const STREAM_CHECK_TIMEOUT_MS = 1800;
const STREAM_CHECK_BATCH_SIZE = 8;
const STREAMS_TO_CHECK_PER_CHANNEL = 3;
const VERIFIED_COUNTRY = "IN";
const CACHE_MS = 30 * 60 * 1000;

export const dynamic = "force-dynamic";

let cachedPayload: unknown = null;
let cachedAt = 0;

const fetchJson = async <T,>(path: string): Promise<T> => {
  const response = await fetch(`${API_ROOT}/${path}`, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Failed to load ${path}`);
  }

  return response.json() as Promise<T>;
};

const hasGeoWarning = (stream: Stream) =>
  `${stream.label ?? ""} ${stream.title ?? ""}`.toLowerCase().includes("geo");

const streamRank = (stream: Stream) => {
  let rank = 0;

  if (hasGeoWarning(stream)) rank += 20;
  if (stream.referrer) rank += 10;
  if (stream.user_agent) rank += 10;

  return rank;
};

const sortStreams = (streams: Stream[]) =>
  [...streams].sort((a, b) => streamRank(a) - streamRank(b));

const isSportsChannel = (channel: Pick<Channel, "categories" | "name">) =>
  channel.categories?.includes("sports") || /\bsports?\b/i.test(channel.name);

const channelRankScore = (channel: Channel, streams: Stream[], logo?: string) => {
  let score = 0;
  const lowerName = channel.name.toLowerCase();

  if (logo) score += 10;
  if (channel.website) score += 8;
  if (streams.length > 1) score += Math.min(streams.length, 4) * 2;
  if (streams.some((stream) => !hasGeoWarning(stream))) score += 5;
  if (streams.some((stream) => !stream.referrer && !stream.user_agent)) score += 5;
  if (/\b(news|tv|hd|live|national|sports?)\b/.test(lowerName)) score += 3;
  if (/\b(test|backup|copy|mirror)\b/.test(lowerName)) score -= 20;

  return score;
};

const curateCountryEntries = (entries: ChannelEntry[]) => {
  const byCountry = new Map<string, ChannelEntry[]>();

  for (const entry of entries) {
    const countryEntries = byCountry.get(entry.countryCode) ?? [];
    countryEntries.push(entry);
    byCountry.set(entry.countryCode, countryEntries);
  }

  const curated: ChannelEntry[] = [];

  for (const countryEntries of byCountry.values()) {
    const sportsEntries = countryEntries.filter((entry) => entry.isSports);
    const featuredEntries = countryEntries
      .filter((entry) => !entry.isSports)
      .sort((a, b) => b.rankScore - a.rankScore || a.name.localeCompare(b.name))
      .slice(0, FEATURED_PER_COUNTRY);

    curated.push(...sportsEntries, ...featuredEntries);
  }

  return curated.sort((a, b) => {
    const countrySort = a.countryName.localeCompare(b.countryName);
    if (countrySort) return countrySort;
    if (a.isSports !== b.isSports) return a.isSports ? -1 : 1;
    return b.rankScore - a.rankScore || a.name.localeCompare(b.name);
  });
};

const fetchWithTimeout = async (url: string, init: RequestInit = {}) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), STREAM_CHECK_TIMEOUT_MS);
  const headers = new Headers(init.headers);
  headers.set("User-Agent", "Mozilla/5.0 Public IPTV Explorer");

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: "follow",
      headers,
    });
  } finally {
    clearTimeout(timeoutId);
  }
};

const isManifestLike = (text: string, url: string) =>
  url.includes(".m3u8") ? text.includes("#EXTM3U") : text.length > 0;

const checkStream = async (stream: Stream) => {
  if (hasGeoWarning(stream)) return false;

  try {
    const response = await fetchWithTimeout(stream.url, {
      headers: {
        ...(stream.referrer ? { Referer: stream.referrer } : {}),
        Range: "bytes=0-4095",
      },
    });

    if (!response.ok) return false;

    const reader = response.body?.getReader();
    if (!reader) return false;

    const { value } = await reader.read();
    await reader.cancel();

    if (!value) return false;

    const text = new TextDecoder().decode(value);
    return isManifestLike(text, stream.url);
  } catch {
    return false;
  }
};

const verifiedStreams = async (streams: Stream[]) => {
  const sortedStreams = sortStreams(streams).slice(0, STREAMS_TO_CHECK_PER_CHANNEL);
  const checks = await Promise.all(
    sortedStreams.map(async (stream) => ({
      stream,
      ok: await checkStream(stream),
    })),
  );

  return checks.filter((check) => check.ok).map((check) => check.stream);
};

const verifyIndianSportsEntries = async (entries: ChannelEntry[]) => {
  const verifiedEntries = [...entries];
  const targetIndexes = verifiedEntries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.countryCode === VERIFIED_COUNTRY && entry.isSports);

  for (let index = 0; index < targetIndexes.length; index += STREAM_CHECK_BATCH_SIZE) {
    const batch = targetIndexes.slice(index, index + STREAM_CHECK_BATCH_SIZE);
    const checkedBatch = await Promise.all(
      batch.map(async ({ entry, index: entryIndex }) => ({
        entryIndex,
        streams: await verifiedStreams(entry.streams),
      })),
    );

    for (const checked of checkedBatch) {
      verifiedEntries[checked.entryIndex] = {
        ...verifiedEntries[checked.entryIndex],
        streams: checked.streams,
        verified: checked.streams.length > 0,
      };
    }
  }

  return verifiedEntries;
};

export async function GET() {
  try {
    if (cachedPayload && Date.now() - cachedAt < CACHE_MS) {
      return NextResponse.json(cachedPayload, {
        headers: {
          "Cache-Control": "public, max-age=300",
        },
      });
    }

    const [countries, channels, streams, logos, categories, blocklist] =
      await Promise.all([
        fetchJson<Country[]>("countries.json"),
        fetchJson<Channel[]>("channels.json"),
        fetchJson<Stream[]>("streams.json"),
        fetchJson<Logo[]>("logos.json"),
        fetchJson<Category[]>("categories.json"),
        fetchJson<BlocklistItem[]>("blocklist.json"),
      ]);

    const countryMap = new Map(countries.map((country) => [country.code, country]));
    const blockedChannels = new Set(blocklist.map((item) => item.channel));
    const logoMap = new Map<string, string>();
    const streamMap = new Map<string, Stream[]>();

    for (const logo of logos) {
      if (logo.in_use && !logoMap.has(logo.channel)) {
        logoMap.set(logo.channel, logo.url);
      }
    }

    for (const stream of streams) {
      if (!stream.channel) continue;
      const channelStreams = streamMap.get(stream.channel) ?? [];
      channelStreams.push(stream);
      streamMap.set(stream.channel, channelStreams);
    }

    const allEntries: ChannelEntry[] = [];

    for (const channel of channels) {
      if (!channel.country || channel.is_nsfw || blockedChannels.has(channel.id)) {
        continue;
      }

      const channelStreams = sortStreams(streamMap.get(channel.id) ?? []);
      if (!channelStreams.length) continue;

      const country = countryMap.get(channel.country);
      const logo = logoMap.get(channel.id);
      const isSports = isSportsChannel(channel);

      allEntries.push({
        id: channel.id,
        name: channel.name,
        countryCode: channel.country,
        countryName: country?.name ?? channel.country,
        flag: country?.flag ?? "",
        categories: channel.categories ?? [],
        logo,
        website: channel.website,
        streams: channelStreams,
        isSports,
        rankScore: channelRankScore(channel, channelStreams, logo),
        verified: false,
      });
    }

    const curatedEntries = curateCountryEntries(allEntries);
    const entries = await verifyIndianSportsEntries(curatedEntries);

    const payload = {
      entries: entries.filter((entry) => entry.streams.length > 0),
      categories: categories.sort((a, b) => a.name.localeCompare(b.name)),
      meta: {
        featuredPerCountry: FEATURED_PER_COUNTRY,
        verifiedCountry: VERIFIED_COUNTRY,
      },
    };

    cachedPayload = payload;
    cachedAt = Date.now();

    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Could not load IPTV channel data",
      },
      { status: 500 },
    );
  }
}
