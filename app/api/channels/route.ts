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
const REVALIDATE_SECONDS = 30 * 60;
const EUROPE_COUNTRY_CODES = [
  "AL",
  "AD",
  "AT",
  "BY",
  "BE",
  "BA",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IS",
  "IE",
  "IT",
  "XK",
  "LV",
  "LI",
  "LT",
  "LU",
  "MT",
  "MD",
  "MC",
  "ME",
  "NL",
  "MK",
  "NO",
  "PL",
  "PT",
  "RO",
  "RU",
  "SM",
  "RS",
  "SK",
  "SI",
  "ES",
  "SE",
  "CH",
  "TR",
  "UA",
  "VA",
];
const ALLOWED_COUNTRY_CODES = new Set([
  "BD",
  "IN",
  "PK",
  "US",
  "UK",
  "AU",
  ...EUROPE_COUNTRY_CODES,
]);

export const dynamic = "force-static";
export const revalidate = 1800;
export const maxDuration = 60;

const fetchJson = async <T,>(path: string): Promise<T> => {
  const response = await fetch(`${API_ROOT}/${path}`, {
    next: {
      revalidate: REVALIDATE_SECONDS,
      tags: ["iptv-directory"],
    },
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

export async function GET() {
  try {
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
      if (
        !channel.country ||
        !ALLOWED_COUNTRY_CODES.has(channel.country) ||
        channel.is_nsfw ||
        blockedChannels.has(channel.id)
      ) {
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

    const entries = allEntries.sort((a, b) => {
      const countrySort = a.countryName.localeCompare(b.countryName);
      if (countrySort) return countrySort;
      if (a.isSports !== b.isSports) return a.isSports ? -1 : 1;
      return b.rankScore - a.rankScore || a.name.localeCompare(b.name);
    });

    const payload = {
      entries: entries.filter((entry) => entry.streams.length > 0),
      categories: categories.sort((a, b) => a.name.localeCompare(b.name)),
      meta: {
        countryCodes: Array.from(ALLOWED_COUNTRY_CODES).sort(),
        europeCountryCodes: EUROPE_COUNTRY_CODES,
      },
    };

    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600",
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
