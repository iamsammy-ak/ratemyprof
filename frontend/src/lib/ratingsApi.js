import { createClient } from "@supabase/supabase-js";

const RATINGS_TABLE = "professor_ratings";

const METRIC_KEYS = [
  "teachingQuality",
  "understandability",
  "behavior",
  "englishLevel",
  "availability",
];

const DB_COLUMN_BY_METRIC = {
  teachingQuality: "teaching_quality",
  understandability: "understandability",
  behavior: "behavior",
  englishLevel: "english_level",
  availability: "availability",
};

const DEFAULT_SUMMARY = {
  avgRating: 0,
  reviewsCount: 0,
  metrics: {
    teachingQuality: 0,
    understandability: 0,
    behavior: 0,
    englishLevel: 0,
    availability: 0,
  },
};

let supabaseSingleton = null;

function getEnv(name) {
  const value = import.meta.env[name];
  return typeof value === "string" ? value.trim() : "";
}

export function isRatingsApiConfigured() {
  return Boolean(
    getEnv("VITE_SUPABASE_URL") && getEnv("VITE_SUPABASE_ANON_KEY"),
  );
}

export function getSupabaseClient() {
  if (supabaseSingleton) return supabaseSingleton;

  const supabaseUrl = getEnv("VITE_SUPABASE_URL");
  const supabaseAnonKey = getEnv("VITE_SUPABASE_ANON_KEY");

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Missing Supabase environment variables. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.",
    );
  }

  supabaseSingleton = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });

  return supabaseSingleton;
}

async function requireAuthenticatedUser() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.getUser();

  if (error) {
    throw new Error(`Authentication check failed: ${error.message}`);
  }

  const user = data?.user ?? null;
  if (!user) {
    throw new Error("You must be logged in to submit or update a rating.");
  }

  return user;
}

function normalizeProfileUrl(url) {
  return String(url ?? "").trim();
}

function coerceScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(1, Math.min(5, Math.round(numeric)));
}

function validateScores(scores) {
  if (!scores || typeof scores !== "object") {
    throw new Error("scores must be an object with 5 metric values.");
  }

  const validated = {};
  for (const key of METRIC_KEYS) {
    const value = coerceScore(scores[key]);
    if (value === null) {
      throw new Error(
        `Invalid score for "${key}". Expected a number between 1 and 5.`,
      );
    }
    validated[key] = value;
  }
  return validated;
}

function computeOverall(scores) {
  const total = METRIC_KEYS.reduce(
    (sum, key) => sum + Number(scores[key] ?? 0),
    0,
  );
  return total / METRIC_KEYS.length;
}

function rowToMetricValues(row) {
  return {
    teachingQuality: Number(row?.teaching_quality ?? 0),
    understandability: Number(row?.understandability ?? 0),
    behavior: Number(row?.behavior ?? 0),
    englishLevel: Number(row?.english_level ?? 0),
    availability: Number(row?.availability ?? 0),
  };
}

function summarizeRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ...DEFAULT_SUMMARY, metrics: { ...DEFAULT_SUMMARY.metrics } };
  }

  const acc = {
    reviewsCount: rows.length,
    overallSum: 0,
    metricSums: {
      teachingQuality: 0,
      understandability: 0,
      behavior: 0,
      englishLevel: 0,
      availability: 0,
    },
  };

  for (const row of rows) {
    const metrics = rowToMetricValues(row);

    for (const key of METRIC_KEYS) {
      acc.metricSums[key] += metrics[key];
    }

    const rowOverall =
      row?.overall_rating !== null && row?.overall_rating !== undefined
        ? Number(row.overall_rating)
        : computeOverall(metrics);

    acc.overallSum += Number.isFinite(rowOverall) ? rowOverall : 0;
  }

  const avgRating = acc.overallSum / acc.reviewsCount;
  const averagedMetrics = {};
  for (const key of METRIC_KEYS) {
    averagedMetrics[key] = Number(
      (acc.metricSums[key] / acc.reviewsCount).toFixed(2),
    );
  }

  return {
    avgRating: Number(avgRating.toFixed(2)),
    reviewsCount: acc.reviewsCount,
    metrics: averagedMetrics,
  };
}

export async function fetchRatingSummaryByProfileUrl(profileUrl) {
  const normalized = normalizeProfileUrl(profileUrl);
  if (!normalized) {
    return { ...DEFAULT_SUMMARY, metrics: { ...DEFAULT_SUMMARY.metrics } };
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from(RATINGS_TABLE)
    .select(
      "profile_url,teaching_quality,understandability,behavior,english_level,availability,overall_rating",
    )
    .eq("profile_url", normalized);

  if (error) {
    throw new Error(`Failed to fetch rating summary: ${error.message}`);
  }

  return summarizeRows(data ?? []);
}

export async function fetchRatingSummariesByProfileUrls(profileUrls) {
  const normalizedUrls = Array.from(
    new Set((profileUrls ?? []).map(normalizeProfileUrl).filter(Boolean)),
  );

  const summaryMap = {};
  for (const url of normalizedUrls) {
    summaryMap[url] = {
      ...DEFAULT_SUMMARY,
      metrics: { ...DEFAULT_SUMMARY.metrics },
    };
  }

  if (normalizedUrls.length === 0) return summaryMap;

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from(RATINGS_TABLE)
    .select(
      "profile_url,teaching_quality,understandability,behavior,english_level,availability,overall_rating",
    )
    .in("profile_url", normalizedUrls);

  if (error) {
    throw new Error(`Failed to fetch rating summaries: ${error.message}`);
  }

  const grouped = {};
  for (const row of data ?? []) {
    const key = normalizeProfileUrl(row.profile_url);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(row);
  }

  for (const url of normalizedUrls) {
    summaryMap[url] = summarizeRows(grouped[url] ?? []);
  }

  return summaryMap;
}

export function mergeRatingSummariesIntoProfessors(
  professors,
  summaryByProfileUrl,
) {
  return (professors ?? []).map((professor) => {
    const profileUrl = normalizeProfileUrl(professor?.profileUrl);
    const summary = profileUrl ? summaryByProfileUrl?.[profileUrl] : null;

    if (!summary || summary.reviewsCount === 0) return professor;

    return {
      ...professor,
      avgRating: summary.avgRating,
      reviewsCount: summary.reviewsCount,
      metrics: {
        ...professor.metrics,
        ...summary.metrics,
      },
    };
  });
}

/**
 * Requires authenticated user and upserts one rating per user-professor.
 *
 * Expected DB constraint:
 *   unique(user_id, profile_url)
 */
export async function submitProfessorRating(input) {
  const profileUrl = normalizeProfileUrl(input?.profileUrl);
  if (!profileUrl) {
    throw new Error("profileUrl is required.");
  }

  const user = await requireAuthenticatedUser();
  const validatedScores = validateScores(input?.scores ?? {});
  const overall = Number(computeOverall(validatedScores).toFixed(2));
  const reviewText = String(input?.reviewText ?? "").trim();

  const payload = {
    user_id: user.id,
    profile_url: profileUrl,
    department: String(input?.department ?? "").trim() || null,
    professor_name: String(input?.professorName ?? "").trim() || null,
    teaching_quality: validatedScores.teachingQuality,
    understandability: validatedScores.understandability,
    behavior: validatedScores.behavior,
    english_level: validatedScores.englishLevel,
    availability: validatedScores.availability,
    overall_rating: overall,
    review_text: reviewText || null,
    reviewer_university: String(input?.reviewerUniversity ?? "").trim() || null,
    reviewer_course: String(input?.reviewerCourse ?? "").trim() || null,
    updated_at: new Date().toISOString(),
  };

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from(RATINGS_TABLE)
    .upsert(payload, {
      onConflict: "user_id,profile_url",
      ignoreDuplicates: false,
    })
    .select("*")
    .single();

  if (error) {
    throw new Error(`Failed to upsert rating: ${error.message}`);
  }

  return data;
}

export async function getCurrentUser() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.getUser();
  if (error) {
    throw new Error(`Failed to get current user: ${error.message}`);
  }
  return data?.user ?? null;
}
