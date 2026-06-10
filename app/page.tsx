"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

type Stream = {
  channel: string | null;
  title: string;
  url: string;
  quality?: string | null;
  label?: string | null;
  referrer?: string | null;
  user_agent?: string | null;
};

type Category = {
  id: string;
  name: string;
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

type ChannelsPayload = {
  entries: ChannelEntry[];
  categories: Category[];
  meta: {
    countryCodes: string[];
    europeCountryCodes: string[];
  };
};

type PlaybackStatus = "idle" | "loading" | "ready" | "unavailable";

type HlsInstance = {
  loadSource: (source: string) => void;
  attachMedia: (media: HTMLVideoElement) => void;
  destroy: () => void;
  on: (event: string, callback: (_event: string, data: { fatal?: boolean }) => void) => void;
};

type HlsConstructor = {
  new (config?: Record<string, unknown>): HlsInstance;
  isSupported: () => boolean;
  Events: { ERROR: string };
};

declare global {
  interface Window {
    Hls?: HlsConstructor;
  }
}

const HLS_SCRIPT = "https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js";
const FAVOURITES_STORAGE_KEY = "tv-app:favourite-channel-ids";
const ALL_COUNTRIES = "ALL";
const EUROPE_COUNTRIES = "EUROPE";
const ALL_GROUPS = "ALL";
const ALL_CATEGORIES = "ALL";
const DEFAULT_COUNTRY = "BD";
const PAGE_SIZE = 72;
const CHANNEL_GROUPS = [
  { id: ALL_GROUPS, label: "All" },
  { id: "FAVOURITES", label: "Favourites" },
  { id: "sports", label: "Sports" },
  { id: "news", label: "News" },
  { id: "kids", label: "Kids" },
  { id: "documentary", label: "Documentary" },
  { id: "entertainment", label: "Entertainment" },
];
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
const QUICK_COUNTRIES = [
  { code: "BD", flag: "🇧🇩", label: "Bangladesh" },
  { code: "IN", flag: "🇮🇳", label: "India" },
  { code: "PK", flag: "🇵🇰", label: "Pakistan" },
  { code: "US", flag: "🇺🇸", label: "USA" },
  { code: "UK", flag: "🇬🇧", label: "UK" },
  { code: "AU", flag: "🇦🇺", label: "Australia" },
  { code: EUROPE_COUNTRIES, flag: "🇪🇺", label: "Europe" },
];

const loadHls = () =>
  new Promise<HlsConstructor | null>((resolve, reject) => {
    if (window.Hls) {
      resolve(window.Hls);
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${HLS_SCRIPT}"]`,
    );

    if (existing) {
      existing.addEventListener("load", () => resolve(window.Hls ?? null), {
        once: true,
      });
      existing.addEventListener("error", reject, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = HLS_SCRIPT;
    script.async = true;
    script.onload = () => resolve(window.Hls ?? null);
    script.onerror = reject;
    document.head.appendChild(script);
  });

const normalizeCategory = (category: string) =>
  category
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

const normalizeSearchText = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();

const hasGeoWarning = (stream: Stream) =>
  `${stream.label ?? ""} ${stream.title ?? ""}`.toLowerCase().includes("geo");

const streamRank = (stream: Stream, failedUrls: Set<string>) => {
  let rank = 0;

  if (failedUrls.has(stream.url)) rank += 100;
  if (hasGeoWarning(stream)) rank += 20;
  if (stream.referrer) rank += 10;
  if (stream.user_agent) rank += 10;

  return rank;
};

const sortStreams = (streams: Stream[], failedUrls: Set<string>) =>
  [...streams].sort((a, b) => streamRank(a, failedUrls) - streamRank(b, failedUrls));

const isEuropeCountry = (countryCode: string) =>
  EUROPE_COUNTRY_CODES.includes(countryCode);

const isEntryInGroup = (
  entry: ChannelEntry,
  groupId: string,
  favouriteChannelIds: Set<string>,
) => {
  if (groupId === ALL_GROUPS) return true;
  if (groupId === "FAVOURITES") return favouriteChannelIds.has(entry.id);
  if (groupId === "sports") return entry.isSports;
  return entry.categories.includes(groupId);
};

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<HlsInstance | null>(null);
  const [entries, setEntries] = useState<ChannelEntry[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCountry, setSelectedCountry] = useState(DEFAULT_COUNTRY);
  const [selectedGroup, setSelectedGroup] = useState(ALL_GROUPS);
  const [selectedCategory, setSelectedCategory] = useState(ALL_CATEGORIES);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [selectedStreamUrl, setSelectedStreamUrl] = useState<string | null>(null);
  const [failedUrls, setFailedUrls] = useState<Set<string>>(new Set());
  const [playbackStatus, setPlaybackStatus] = useState<PlaybackStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [favouriteChannelIds, setFavouriteChannelIds] = useState<Set<string>>(
    () => {
      if (typeof window === "undefined") return new Set();

      try {
        const stored = window.localStorage.getItem(FAVOURITES_STORAGE_KEY);
        const parsed = stored ? (JSON.parse(stored) as unknown) : [];

        if (!Array.isArray(parsed)) return new Set();

        return new Set(
          parsed.filter((value): value is string => typeof value === "string"),
        );
      } catch {
        return new Set();
      }
    },
  );

  useEffect(() => {
    let isMounted = true;

    const loadData = async () => {
      try {
        setIsLoading(true);
        const response = await fetch("/api/channels");

        if (!response.ok) {
          throw new Error("Could not load available channel data");
        }

        if (!isMounted) return;

        const payload = (await response.json()) as ChannelsPayload;
        const nextEntries = payload.entries;

        setEntries(nextEntries);
        setCategories(payload.categories);
        setSelectedEntryId(
          nextEntries.find((entry) => entry.countryCode === DEFAULT_COUNTRY)?.id ??
            nextEntries[0]?.id ??
            null,
        );
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Could not load IPTV data");
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    loadData();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    void loadHls().catch(() => undefined);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      FAVOURITES_STORAGE_KEY,
      JSON.stringify(Array.from(favouriteChannelIds)),
    );
  }, [favouriteChannelIds]);

  const countryOptions = useMemo(() => {
    const countryCounts = new Map<string, { name: string; flag: string; count: number }>();

    for (const entry of entries) {
      if (!entry.streams.some((stream) => !failedUrls.has(stream.url))) continue;

      const country = countryCounts.get(entry.countryCode) ?? {
        name: entry.countryName,
        flag: entry.flag,
        count: 0,
      };
      country.count += 1;
      countryCounts.set(entry.countryCode, country);
    }

    return Array.from(countryCounts.entries())
      .map(([code, country]) => ({ code, ...country }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [entries, failedUrls]);

  const toggleFavourite = (channelId: string) => {
    setFavouriteChannelIds((current) => {
      const next = new Set(current);

      if (next.has(channelId)) {
        next.delete(channelId);
      } else {
        next.add(channelId);
      }

      return next;
    });
  };

  const filteredEntries = useMemo(() => {
    const queryTokens = normalizeSearchText(deferredQuery).split(" ").filter(Boolean);

    return entries.filter((entry) => {
      const hasWorkingCandidate = entry.streams.some((stream) => !failedUrls.has(stream.url));
      const matchesCountry =
        selectedCountry === ALL_COUNTRIES ||
        (selectedCountry === EUROPE_COUNTRIES && isEuropeCountry(entry.countryCode)) ||
        entry.countryCode === selectedCountry;
      const matchesGroup = isEntryInGroup(entry, selectedGroup, favouriteChannelIds);
      const matchesCategory =
        selectedCategory === ALL_CATEGORIES || entry.categories.includes(selectedCategory);
      const searchableText = normalizeSearchText(
        [
          entry.id,
          entry.name,
          entry.countryCode,
          entry.countryName,
          entry.categories.join(" "),
          entry.isSports ? "sports" : "",
          favouriteChannelIds.has(entry.id) ? "favourite favorite saved" : "",
        ].join(" "),
      );
      const matchesQuery =
        queryTokens.length === 0 ||
        queryTokens.every((token) => searchableText.includes(token));

      return (
        hasWorkingCandidate &&
        matchesCountry &&
        matchesGroup &&
        matchesCategory &&
        matchesQuery
      );
    });
  }, [
    deferredQuery,
    entries,
    failedUrls,
    favouriteChannelIds,
    selectedCategory,
    selectedCountry,
    selectedGroup,
  ]);

  const visibleEntries = useMemo(
    () => filteredEntries.slice(0, visibleCount),
    [filteredEntries, visibleCount],
  );

  const selectedEntry = useMemo(
    () => filteredEntries.find((entry) => entry.id === selectedEntryId) ?? filteredEntries[0],
    [filteredEntries, selectedEntryId],
  );

  const playableStreams = useMemo(
    () =>
      sortStreams(selectedEntry?.streams ?? [], failedUrls).filter(
        (stream) => !failedUrls.has(stream.url),
      ),
    [failedUrls, selectedEntry],
  );

  const selectedStream =
    playableStreams.find((stream) => stream.url === selectedStreamUrl) ?? playableStreams[0];

  useEffect(() => {
    if (!selectedEntry) {
      return;
    }

    const stream = selectedStream;
    const video = videoRef.current;

    if (!stream || !video) {
      setPlaybackStatus("unavailable");
      return;
    }

    let isCancelled = false;
    setPlaybackStatus("loading");
    setSelectedStreamUrl(stream.url);

    hlsRef.current?.destroy();
    hlsRef.current = null;
    video.removeAttribute("src");
    video.load();

    const markUnavailable = () => {
      setFailedUrls((current) => new Set(current).add(stream.url));
      const nextStream = playableStreams.find((candidate) => candidate.url !== stream.url);

      if (nextStream) {
        setSelectedStreamUrl(nextStream.url);
      } else {
        setPlaybackStatus("unavailable");
      }
    };

    const play = async () => {
      try {
        if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = stream.url;
          video.load();
          void video.play().catch(() => undefined);
          return;
        }

        const Hls = await loadHls();
        if (!Hls?.isSupported()) {
          markUnavailable();
          return;
        }

        if (isCancelled) return;

        const hls = new Hls({
          lowLatencyMode: true,
          backBufferLength: 45,
        });
        hlsRef.current = hls;
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            markUnavailable();
          }
        });
        hls.loadSource(stream.url);
        hls.attachMedia(video);
      } catch {
        markUnavailable();
      }
    };

    const handleReady = () => {
      setPlaybackStatus("ready");
      void video.play().catch(() => undefined);
    };
    const handleError = () => markUnavailable();

    video.addEventListener("canplay", handleReady);
    video.addEventListener("error", handleError);
    play();

    return () => {
      isCancelled = true;
      video.removeEventListener("canplay", handleReady);
      video.removeEventListener("error", handleError);
    };
  }, [playableStreams, selectedEntry, selectedStream]);

  useEffect(() => {
    return () => {
      hlsRef.current?.destroy();
    };
  }, []);

  const availableCount = entries.filter((entry) =>
    entry.streams.some((stream) => !failedUrls.has(stream.url)),
  ).length;
  const countryCount = countryOptions.length;
  const savedFavouriteCount = entries.filter((entry) =>
    favouriteChannelIds.has(entry.id),
  ).length;
  const hasMore = visibleEntries.length < filteredEntries.length;
  const selectedIsFavourite = selectedEntry
    ? favouriteChannelIds.has(selectedEntry.id)
    : false;

  return (
    <main className="min-h-screen overflow-x-hidden bg-[#07090d] text-[#eef2ff]">
      <section className="top-0 z-20 border-b border-white/10 bg-[#0b0f16]/90 backdrop-blur-xl lg:sticky">
        <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-5 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#6ee7b7]">
                <span className="h-2 w-2 rounded-full bg-[#22c55e] shadow-[0_0_18px_rgba(34,197,94,0.85)]" />
                Live IPTV
              </p>
              <h1 className="mt-2 text-2xl font-semibold text-white sm:text-3xl">
                Modern TV browser
              </h1>
              <p className="mt-2 max-w-2xl text-sm text-[#93a2b7]">
                Bangladesh, India, Pakistan, USA, UK, Australia, and European countries.
                Star any channel to keep it in your personal Favourites list.
              </p>
            </div>

            <div className="grid grid-cols-3 gap-2 text-sm">
              {[
                ["Channels", availableCount],
                ["Countries", countryCount],
                ["Saved", savedFavouriteCount],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="rounded-md border border-white/10 bg-white/[0.06] px-3 py-2 shadow-[0_10px_30px_rgba(0,0,0,0.18)] backdrop-blur"
                >
                  <p className="text-[#9aa7bd]">{label}</p>
                  <p className="text-lg font-semibold text-white">
                    {Number(value).toLocaleString()}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <div className="flex gap-2 overflow-x-auto pb-1">
            <CountryButton
              active={selectedCountry === ALL_COUNTRIES}
              label="All"
              onClick={() => {
                setSelectedCountry(ALL_COUNTRIES);
                setQuery("");
                setVisibleCount(PAGE_SIZE);
              }}
            />
            {QUICK_COUNTRIES.map((country) => (
              <CountryButton
                key={country.code}
                active={selectedCountry === country.code}
                label={`${country.flag} ${country.label}`}
                onClick={() => {
                  setSelectedCountry(country.code);
                  setQuery("");
                  setVisibleCount(PAGE_SIZE);
                }}
              />
            ))}
          </div>

          <div className="flex gap-2 overflow-x-auto pb-1">
            {CHANNEL_GROUPS.map((group) => (
              <GroupButton
                key={group.id}
                active={selectedGroup === group.id}
                label={group.label}
                onClick={() => {
                  setSelectedGroup(group.id);
                  setVisibleCount(PAGE_SIZE);
                }}
              />
            ))}
          </div>

          <div className="grid gap-3 lg:grid-cols-[1fr_240px_240px]">
            <label className="flex flex-col gap-1 text-sm font-medium text-[#bac5d6]">
              Search
              <input
                className="h-11 rounded-md border border-white/10 bg-[#111821] px-3 text-base text-white outline-none transition duration-200 placeholder:text-[#697386] focus:border-[#6ee7b7] focus:bg-[#151d28] focus:ring-2 focus:ring-[#6ee7b7]/20"
                placeholder="Search channels, countries, categories"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setVisibleCount(PAGE_SIZE);
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium text-[#bac5d6]">
              Country
              <select
                className="h-11 rounded-md border border-white/10 bg-[#111821] px-3 text-base text-white outline-none transition duration-200 focus:border-[#6ee7b7] focus:bg-[#151d28] focus:ring-2 focus:ring-[#6ee7b7]/20"
                value={selectedCountry}
                onChange={(event) => {
                  setSelectedCountry(event.target.value);
                  setVisibleCount(PAGE_SIZE);
                }}
              >
                <option value={ALL_COUNTRIES}>All countries</option>
                <option value={EUROPE_COUNTRIES}>🇪🇺 Europe</option>
                {countryOptions.map((country) => (
                  <option key={country.code} value={country.code}>
                    {country.flag} {country.name} ({country.count})
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium text-[#bac5d6]">
              Category
              <select
                className="h-11 rounded-md border border-white/10 bg-[#111821] px-3 text-base text-white outline-none transition duration-200 focus:border-[#6ee7b7] focus:bg-[#151d28] focus:ring-2 focus:ring-[#6ee7b7]/20"
                value={selectedCategory}
                onChange={(event) => {
                  setSelectedCategory(event.target.value);
                  setVisibleCount(PAGE_SIZE);
                }}
              >
                <option value={ALL_CATEGORIES}>All categories</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-[1500px] gap-4 px-4 py-4 sm:px-6 lg:grid-cols-[410px_1fr] lg:px-8">
        <aside className="smooth-panel order-2 overflow-hidden rounded-lg border border-white/10 bg-[#10141c]/92 shadow-[0_24px_70px_rgba(0,0,0,0.34)] backdrop-blur lg:order-1">
          <div className="flex h-12 items-center justify-between border-b border-white/10 bg-[#151b25]/90 px-4">
            <p className="text-sm font-semibold text-white">
              {filteredEntries.length.toLocaleString()} channels
            </p>
            <p className="text-xs text-[#7f8ea3]">rendering {visibleEntries.length}</p>
          </div>

          <div className="h-[55vh] min-h-[390px] overflow-y-auto">
            {isLoading && <ChannelListSkeleton />}
            {error && (
              <div className="m-4 rounded-md border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200">
                {error}
              </div>
            )}
            {!isLoading && !error && filteredEntries.length === 0 && (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[#9aa7bd]">
                {selectedGroup === "FAVOURITES"
                  ? "No saved favourites yet. Star channels to add them here."
                  : "No channels match the current filters."}
              </div>
            )}
            {visibleEntries.map((entry) => {
              const isSelected = selectedEntry?.id === entry.id;
              const isFavourite = favouriteChannelIds.has(entry.id);
              const bestStream = sortStreams(entry.streams, failedUrls).find(
                (stream) => !failedUrls.has(stream.url),
              );

              return (
                <div
                  key={entry.id}
                  className={`channel-row grid w-full grid-cols-[1fr_38px_auto] gap-2 border-b border-white/[0.06] text-left transition duration-200 ${
                    isSelected
                      ? "bg-[#123834] shadow-[inset_3px_0_0_#6ee7b7]"
                      : "bg-transparent hover:bg-white/[0.06]"
                  }`}
                >
                  <button
                    className="grid min-w-0 grid-cols-[50px_1fr] gap-3 py-3 pl-4 text-left"
                    type="button"
                    onClick={() => {
                      setSelectedEntryId(entry.id);
                      setSelectedStreamUrl(bestStream?.url ?? null);
                    }}
                  >
                    <span className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-md border border-white/10 bg-[#182131] text-xs font-semibold text-[#a9b5c7] shadow-[0_10px_30px_rgba(0,0,0,0.24)]">
                      {entry.logo ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          alt=""
                          className="max-h-9 max-w-9 object-contain"
                          src={entry.logo}
                          loading="lazy"
                        />
                      ) : (
                        entry.name.slice(0, 2).toUpperCase()
                      )}
                    </span>
                    <span className="min-w-0 self-center">
                      <span className="block truncate text-sm font-semibold text-white">
                        {entry.name}
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[#93a2b7]">
                        <span>
                          {entry.flag} {entry.countryName}
                        </span>
                        {entry.categories.slice(0, 2).map((category) => (
                          <span
                            key={category}
                            className="rounded-sm bg-white/[0.07] px-1.5 py-0.5 text-[#b9c4d4]"
                          >
                            {normalizeCategory(category)}
                          </span>
                        ))}
                        {entry.isSports && (
                          <span className="rounded-sm bg-emerald-400/12 px-1.5 py-0.5 text-emerald-200">
                            Sports
                          </span>
                        )}
                        {isFavourite && (
                          <span className="rounded-sm bg-[#f7c46c]/15 px-1.5 py-0.5 text-[#ffd98a]">
                            Favourite
                          </span>
                        )}
                        {entry.verified && (
                          <span className="rounded-sm bg-cyan-400/12 px-1.5 py-0.5 text-cyan-200">
                            Verified
                          </span>
                        )}
                      </span>
                      {bestStream &&
                        (hasGeoWarning(bestStream) ||
                          bestStream.referrer ||
                          bestStream.user_agent) && (
                          <span className="mt-1 block text-xs font-medium text-[#f7c46c]">
                            Special headers may be needed
                          </span>
                        )}
                    </span>
                  </button>
                  <button
                    aria-label={
                      isFavourite
                        ? `Remove ${entry.name} from favourites`
                        : `Add ${entry.name} to favourites`
                    }
                    className={`my-3 flex h-9 w-9 items-center justify-center rounded-md border text-lg transition duration-200 ${
                      isFavourite
                        ? "border-[#f7c46c]/45 bg-[#f7c46c]/15 text-[#ffd98a]"
                        : "border-white/10 bg-white/[0.04] text-[#7f8ea3] hover:border-[#f7c46c]/45 hover:text-[#ffd98a]"
                    }`}
                    title={isFavourite ? "Remove favourite" : "Add favourite"}
                    type="button"
                    onClick={() => toggleFavourite(entry.id)}
                  >
                    {isFavourite ? "★" : "☆"}
                  </button>
                  <span className="mr-4 self-center rounded-sm bg-white/[0.08] px-1.5 py-0.5 text-xs font-semibold text-[#9fb0c7]">
                    {entry.streams.length}
                  </span>
                </div>
              );
            })}
            {hasMore && (
              <div className="p-3">
                <button
                  className="h-10 w-full rounded-md border border-white/10 bg-white/[0.06] text-sm font-semibold text-white transition duration-200 hover:border-[#6ee7b7]/35 hover:bg-white/[0.1]"
                  type="button"
                  onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
                >
                  Load more channels
                </button>
              </div>
            )}
          </div>
        </aside>

        <section className="smooth-panel sticky top-3 z-10 order-1 overflow-hidden rounded-lg border border-white/10 bg-[#10141c]/92 shadow-[0_28px_80px_rgba(0,0,0,0.38)] backdrop-blur lg:static lg:order-2">
          <div className="relative aspect-video bg-black">
            {isLoading ? (
              <PlayerSkeleton />
            ) : selectedStream ? (
              <video
                ref={videoRef}
                className="h-full w-full bg-black"
                autoPlay
                controls
                muted
                playsInline
                poster={selectedEntry?.logo}
              />
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[#7f8ea3]">
                Select a channel to start playback.
              </div>
            )}
            {selectedEntry && (
              <div className="pointer-events-none absolute left-3 top-3 flex max-w-[calc(100%_-_1.5rem)] items-center gap-2 rounded-md border border-white/10 bg-black/60 px-3 py-2 shadow-[0_18px_60px_rgba(0,0,0,0.4)] backdrop-blur">
                <span className="h-2 w-2 shrink-0 rounded-full bg-[#22c55e] shadow-[0_0_14px_rgba(34,197,94,0.9)]" />
                <span className="truncate text-sm font-semibold text-white">
                  {selectedEntry.name}
                </span>
                <span className="shrink-0 text-xs text-[#bcc8d9]">
                  {selectedEntry.flag} {selectedEntry.countryName}
                </span>
              </div>
            )}
          </div>

          <div className="grid gap-4 border-t border-white/10 bg-[#111821] p-4 lg:grid-cols-[1fr_290px]">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-xl font-semibold text-white sm:text-2xl">
                  {selectedEntry?.name ?? "No channel selected"}
                </h2>
                {selectedEntry && (
                  <button
                    className={`h-8 rounded-md border px-2 text-sm font-semibold transition duration-200 ${
                      selectedIsFavourite
                        ? "border-[#f7c46c]/45 bg-[#f7c46c]/15 text-[#ffd98a]"
                        : "border-white/10 bg-white/[0.05] text-[#b8c4d6] hover:border-[#f7c46c]/45 hover:text-[#ffd98a]"
                    }`}
                    type="button"
                    onClick={() => toggleFavourite(selectedEntry.id)}
                  >
                    {selectedIsFavourite ? "★ Saved" : "☆ Save"}
                  </button>
                )}
                {selectedEntry && (
                  <span className="rounded-sm bg-white/[0.07] px-2 py-1 text-xs font-medium text-[#c4cfdd]">
                    {selectedEntry.flag} {selectedEntry.countryName}
                  </span>
                )}
                {selectedEntry?.isSports && (
                  <span className="rounded-sm bg-emerald-400/12 px-2 py-1 text-xs font-semibold text-emerald-200">
                    Sports
                  </span>
                )}
                {selectedEntry && selectedIsFavourite && (
                  <span className="rounded-sm bg-[#f7c46c]/15 px-2 py-1 text-xs font-semibold text-[#ffd98a]">
                    Favourite
                  </span>
                )}
                {selectedEntry?.verified && (
                  <span className="rounded-sm bg-cyan-400/12 px-2 py-1 text-xs font-semibold text-cyan-200">
                    Verified stream
                  </span>
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {selectedEntry?.categories.map((category) => (
                  <span
                    key={category}
                    className="rounded-sm border border-white/10 px-2 py-1 text-xs font-medium text-[#aebbd0]"
                  >
                    {normalizeCategory(category)}
                  </span>
                ))}
              </div>
              <p className="mt-3 text-sm text-[#93a2b7]">
                {playbackStatus === "ready"
                  ? "Playing in your browser."
                  : playbackStatus === "loading"
                    ? "Opening stream..."
                    : playbackStatus === "unavailable"
                      ? "No browser-playable stream remained for this channel."
                      : "Choose a channel from the list."}
              </p>
            </div>

            <div className="rounded-md border border-white/10 bg-[#151b25] p-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-white">Stream status</p>
                <span
                  className={`rounded-sm px-2 py-1 text-xs font-semibold ${
                    playbackStatus === "ready"
                      ? "bg-emerald-400/15 text-emerald-200"
                      : playbackStatus === "loading"
                        ? "bg-amber-400/15 text-amber-200"
                        : "bg-red-400/15 text-red-200"
                  }`}
                >
                  {playbackStatus}
                </span>
              </div>

              <label className="mt-3 flex flex-col gap-1 text-sm font-medium text-[#bac5d6]">
                Source
                <select
                  className="h-10 rounded-md border border-white/10 bg-[#10141c] px-2 text-sm text-white outline-none transition duration-200 focus:border-[#6ee7b7] focus:ring-2 focus:ring-[#6ee7b7]/20"
                  value={selectedStream?.url ?? ""}
                  disabled={!playableStreams.length}
                  onChange={(event) => setSelectedStreamUrl(event.target.value)}
                >
                  {!playableStreams.length && <option>No public streams</option>}
                  {playableStreams.map((stream, index) => (
                    <option key={`${stream.url}-${index}`} value={stream.url}>
                      {stream.quality ?? "Auto"} {stream.label ? `- ${stream.label}` : ""}
                    </option>
                  ))}
                </select>
              </label>

              <div className="mt-3 space-y-2 text-xs text-[#93a2b7]">
                {selectedStream?.label && (
                  <p className="rounded-sm bg-amber-400/10 px-2 py-1 text-amber-200">
                    {selectedStream.label}
                  </p>
                )}
                {selectedStream?.referrer && <p>May require a referrer header.</p>}
                {selectedStream?.user_agent && <p>May require a custom user-agent.</p>}
                {selectedEntry?.website && (
                  <a
                    className="inline-flex font-medium text-[#5eead4] hover:text-[#99f6e4]"
                    href={selectedEntry.website}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Official website
                  </a>
                )}
              </div>
            </div>
          </div>
        </section>
      </section>

      <footer className="mx-auto w-full max-w-[1500px] px-4 pb-6 pt-2 text-center text-xs font-medium text-[#7f8ea3] sm:px-6 lg:px-8">
        Developed by Saiful Islam
      </footer>
    </main>
  );
}

function CountryButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`h-10 shrink-0 rounded-md border px-3 text-sm font-semibold transition ${
        active
          ? "border-[#6ee7b7] bg-[#6ee7b7] text-[#06221f] shadow-[0_0_25px_rgba(110,231,183,0.22)]"
          : "border-white/10 bg-[#171d28] text-[#d8e0eb] hover:border-white/20 hover:bg-white/[0.1]"
      }`}
      type="button"
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function GroupButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`h-9 shrink-0 rounded-md border px-3 text-sm font-semibold transition duration-200 ${
        active
          ? "border-white/15 bg-white text-[#0b1018]"
          : "border-white/10 bg-white/[0.05] text-[#c6d1e0] hover:border-white/20 hover:bg-white/[0.09]"
      }`}
      type="button"
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function ChannelListSkeleton() {
  return (
    <div className="p-4">
      {Array.from({ length: 8 }, (_, index) => (
        <div
          className="grid grid-cols-[50px_1fr_40px] gap-3 border-b border-white/[0.06] py-3"
          key={index}
        >
          <div className="skeleton h-11 w-11 rounded-md" />
          <div className="space-y-2 self-center">
            <div className="skeleton h-4 w-3/4 rounded-sm" />
            <div className="skeleton h-3 w-1/2 rounded-sm" />
          </div>
          <div className="skeleton h-8 w-8 self-center rounded-md" />
        </div>
      ))}
    </div>
  );
}

function PlayerSkeleton() {
  return (
    <div className="flex h-full w-full flex-col justify-between bg-[#05070a] p-4">
      <div className="flex items-center gap-2">
        <div className="skeleton h-8 w-8 rounded-md" />
        <div className="skeleton h-4 w-44 rounded-sm" />
      </div>
      <div className="mx-auto w-full max-w-md space-y-3">
        <div className="skeleton h-5 w-full rounded-sm" />
        <div className="skeleton mx-auto h-5 w-2/3 rounded-sm" />
      </div>
      <div className="skeleton h-10 w-full rounded-md" />
    </div>
  );
}
