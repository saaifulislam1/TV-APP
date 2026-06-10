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
    featuredPerCountry: number;
    verifiedCountry: string;
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
const ALL_COUNTRIES = "ALL";
const ALL_CATEGORIES = "ALL";
const DEFAULT_COUNTRY = "BD";
const PAGE_SIZE = 72;
const FEATURED_PER_COUNTRY = 30;
const QUICK_COUNTRIES = [
  { code: "BD", flag: "🇧🇩", label: "Bangladesh" },
  { code: "IN", flag: "🇮🇳", label: "India" },
  { code: "PK", flag: "🇵🇰", label: "Pakistan" },
  { code: "US", flag: "🇺🇸", label: "USA" },
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

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<HlsInstance | null>(null);
  const [entries, setEntries] = useState<ChannelEntry[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCountry, setSelectedCountry] = useState(DEFAULT_COUNTRY);
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

  const filteredEntries = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLowerCase();

    return entries.filter((entry) => {
      const hasWorkingCandidate = entry.streams.some((stream) => !failedUrls.has(stream.url));
      const matchesCountry =
        selectedCountry === ALL_COUNTRIES || entry.countryCode === selectedCountry;
      const matchesCategory =
        selectedCategory === ALL_CATEGORIES || entry.categories.includes(selectedCategory);
      const matchesQuery =
        !normalizedQuery ||
        entry.name.toLowerCase().includes(normalizedQuery) ||
        entry.countryName.toLowerCase().includes(normalizedQuery);

      return hasWorkingCandidate && matchesCountry && matchesCategory && matchesQuery;
    });
  }, [deferredQuery, entries, failedUrls, selectedCategory, selectedCountry]);

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
  const hasMore = visibleEntries.length < filteredEntries.length;

  return (
    <main className="min-h-screen bg-[#080b12] text-[#eef2ff]">
      <section className="border-b border-white/10 bg-[#0d111a]/95">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#2dd4bf]">
                Public IPTV Explorer
              </p>
              <h1 className="mt-2 text-3xl font-semibold text-white sm:text-4xl">
                Featured live TV and sports
              </h1>
              <p className="mt-2 max-w-2xl text-sm text-[#93a2b7]">
                Showing all sports channels plus {FEATURED_PER_COUNTRY} featured public
                channels per country.
              </p>
            </div>

            <div className="grid grid-cols-3 gap-2 text-sm">
              {[
                ["Available", availableCount],
                ["Countries", countryCount],
                ["Visible", filteredEntries.length],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="rounded-md border border-white/10 bg-white/[0.06] px-3 py-2 shadow-[0_10px_30px_rgba(0,0,0,0.18)]"
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
              label="🌐 All"
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

          <div className="grid gap-3 lg:grid-cols-[1fr_240px_240px]">
            <label className="flex flex-col gap-1 text-sm font-medium text-[#bac5d6]">
              Search
              <input
                className="h-11 rounded-md border border-white/10 bg-[#151b29] px-3 text-base text-white outline-none transition placeholder:text-[#697386] focus:border-[#2dd4bf] focus:ring-2 focus:ring-[#2dd4bf]/25"
                placeholder="Find a channel or country"
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
                className="h-11 rounded-md border border-white/10 bg-[#151b29] px-3 text-base text-white outline-none transition focus:border-[#2dd4bf] focus:ring-2 focus:ring-[#2dd4bf]/25"
                value={selectedCountry}
                onChange={(event) => {
                  setSelectedCountry(event.target.value);
                  setVisibleCount(PAGE_SIZE);
                }}
              >
                <option value={ALL_COUNTRIES}>All countries</option>
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
                className="h-11 rounded-md border border-white/10 bg-[#151b29] px-3 text-base text-white outline-none transition focus:border-[#2dd4bf] focus:ring-2 focus:ring-[#2dd4bf]/25"
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

      <section className="mx-auto grid w-full max-w-7xl gap-4 px-4 py-4 sm:px-6 lg:grid-cols-[380px_1fr] lg:px-8">
        <aside className="order-2 overflow-hidden rounded-md border border-white/10 bg-[#0d111a] shadow-[0_24px_70px_rgba(0,0,0,0.3)] lg:order-1">
          <div className="flex h-12 items-center justify-between border-b border-white/10 px-4">
            <p className="text-sm font-semibold text-white">
              {filteredEntries.length.toLocaleString()} curated channels
            </p>
            <p className="text-xs text-[#7f8ea3]">rendering {visibleEntries.length}</p>
          </div>

          <div className="h-[52vh] min-h-[360px] overflow-y-auto">
            {isLoading && (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[#9aa7bd]">
                Loading public channel directory...
              </div>
            )}
            {error && (
              <div className="m-4 rounded-md border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200">
                {error}
              </div>
            )}
            {!isLoading && !error && filteredEntries.length === 0 && (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[#9aa7bd]">
                No channels match the current filters.
              </div>
            )}
            {visibleEntries.map((entry) => {
              const isSelected = selectedEntry?.id === entry.id;
              const bestStream = sortStreams(entry.streams, failedUrls).find(
                (stream) => !failedUrls.has(stream.url),
              );

              return (
                <button
                  key={entry.id}
                  className={`grid w-full grid-cols-[46px_1fr] gap-3 border-b border-white/[0.06] px-4 py-3 text-left transition ${
                    isSelected
                      ? "bg-[#123832]"
                      : "bg-transparent hover:bg-white/[0.05]"
                  }`}
                  type="button"
                  onClick={() => {
                    setSelectedEntryId(entry.id);
                    setSelectedStreamUrl(bestStream?.url ?? null);
                  }}
                >
                  <span className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-md border border-white/10 bg-[#171f2e] text-xs font-semibold text-[#a9b5c7]">
                    {entry.logo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        alt=""
                        className="max-h-8 max-w-8 object-contain"
                        src={entry.logo}
                        loading="lazy"
                      />
                    ) : (
                      entry.name.slice(0, 2).toUpperCase()
                    )}
                  </span>
                  <span className="min-w-0">
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
                        <span className="mt-1 block text-xs font-medium text-amber-300">
                          Fallback stream ready
                        </span>
                      )}
                  </span>
                </button>
              );
            })}
            {hasMore && (
              <div className="p-3">
                <button
                  className="h-10 w-full rounded-md border border-white/10 bg-white/[0.06] text-sm font-semibold text-white transition hover:bg-white/[0.1]"
                  type="button"
                  onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
                >
                  Load more channels
                </button>
              </div>
            )}
          </div>
        </aside>

        <section className="order-1 overflow-hidden rounded-md border border-white/10 bg-[#0d111a] shadow-[0_24px_70px_rgba(0,0,0,0.3)] lg:order-2">
          <div className="aspect-video bg-black">
            {selectedStream ? (
              <video
                ref={videoRef}
                className="h-full w-full"
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
          </div>

          <div className="grid gap-4 p-4 lg:grid-cols-[1fr_260px]">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-2xl font-semibold text-white">
                  {selectedEntry?.name ?? "No channel selected"}
                </h2>
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
                  ? "Stream is playing in your browser."
                  : playbackStatus === "loading"
                    ? "Opening stream..."
                    : playbackStatus === "unavailable"
                      ? "No browser-playable stream remained for this channel."
                      : "Choose a channel from the list."}
              </p>
            </div>

            <div className="rounded-md border border-white/10 bg-white/[0.04] p-3">
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
                  className="h-10 rounded-md border border-white/10 bg-[#151b29] px-2 text-sm text-white outline-none focus:border-[#2dd4bf] focus:ring-2 focus:ring-[#2dd4bf]/25"
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
          ? "border-[#2dd4bf] bg-[#2dd4bf] text-[#06221f] shadow-[0_0_25px_rgba(45,212,191,0.22)]"
          : "border-white/10 bg-white/[0.06] text-[#d8e0eb] hover:bg-white/[0.1]"
      }`}
      type="button"
      onClick={onClick}
    >
      {label}
    </button>
  );
}
