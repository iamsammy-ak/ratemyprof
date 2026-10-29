import React, { useEffect, useMemo, useState } from "react";
import {
  Search,
  ExternalLink,
  Star,
  X,
  SlidersHorizontal,
  GraduationCap,
  Download,
  LogIn,
  LogOut,
} from "lucide-react";
import {
  fetchRatingSummariesByProfileUrls,
  isRatingsApiConfigured,
  mergeRatingSummariesIntoProfessors,
  submitProfessorRating,
} from "./lib/ratingsApi";
import {
  getCurrentUser,
  getOAuthProviderStatus,
  getSignInButtonLabel,
  onAuthStateChange,
  signInWithOAuthProvider,
  signOut,
} from "./lib/authApi";
import {
  fetchCatalogDepartments,
  fetchCatalogRoleTitles,
  fetchProfessorCatalogPage,
} from "./lib/catalogApi";
import supabase, { isSupabaseConfigured } from "./lib/supabase";

const fallbackProfessors = [
  {
    id: 1,
    name: "Sample Professor A",
    department: "DAUIN",
    role: "Full Professor",
    profileUrl: "/sample.professor.a",
    avgRating: 4.8,
    reviewsCount: 128,
    metrics: {
      teachingQuality: 5.0,
      understandability: 4.0,
      behavior: 5.0,
      englishLevel: 5.0,
      availability: 5.0,
    },
  },
  {
    id: 2,
    name: "Sample Professor B",
    department: "DAUIN",
    role: "Associate Professor",
    profileUrl: "/sample.professor.b",
    avgRating: 4.5,
    reviewsCount: 94,
    metrics: {
      teachingQuality: 4.0,
      understandability: 5.0,
      behavior: 5.0,
      englishLevel: 4.0,
      availability: 4.0,
    },
  },
  {
    id: 3,
    name: "Sample Professor C",
    department: "DET",
    role: "Full Professor",
    profileUrl: "/sample.professor.c",
    avgRating: 3.9,
    reviewsCount: 76,
    metrics: {
      teachingQuality: 4.0,
      understandability: 3.0,
      behavior: 4.0,
      englishLevel: 3.0,
      availability: 5.0,
    },
  },
  {
    id: 4,
    name: "Sample Professor D",
    department: "DIATI",
    role: "Researcher",
    profileUrl: "/sample.professor.d",
    avgRating: 4.2,
    reviewsCount: 52,
    metrics: {
      teachingQuality: 4.0,
      understandability: 4.0,
      behavior: 5.0,
      englishLevel: 3.0,
      availability: 5.0,
    },
  },
];

const defaultMetrics = {
  teachingQuality: 3.5,
  understandability: 3.5,
  behavior: 3.5,
  englishLevel: 3.5,
  availability: 3.5,
};

function mapScrapedProfessor(row, index) {
  const fullName = String(row?.full_name ?? "").trim();
  if (!fullName) return null;

  const department = String(row?.department ?? "Unknown").trim() || "Unknown";
  const role =
    String(row?.role_title ?? "Teaching Staff").trim() || "Teaching Staff";
  const profileUrl =
    String(row?.profile_url ?? "").trim() ||
    String(row?.source_url ?? "").trim() ||
    "#";

  return {
    id: `${department}-${fullName}-${index}`,
    name: fullName
      .toLowerCase()
      .split(" ")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" "),
    department,
    role,
    role_title: role,
    role_category:
      String(row?.role_category ?? "OTHER")
        .trim()
        .toUpperCase() || "OTHER",
    profileUrl,
    avgRating: 4.0,
    reviewsCount: 0,
    metrics: { ...defaultMetrics },
  };
}

function normalizeSearchText(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  if (text.includes('"') || text.includes(",") || text.includes("\n")) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function exportProfessorsToCsv(rows, fileName) {
  const headers = [
    "name",
    "department",
    "role",
    "profileUrl",
    "avgRating",
    "reviewsCount",
  ];
  const lines = [
    headers.join(","),
    ...rows.map((row) =>
      [
        row.name,
        row.department,
        row.role,
        row.profileUrl,
        row.avgRating,
        row.reviewsCount,
      ]
        .map(escapeCsvCell)
        .join(","),
    ),
  ];

  const blob = new Blob([lines.join("\n")], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.setAttribute("download", fileName);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function calculateOverallFromScores(scores) {
  const values = [
    Number(scores?.teachingQuality ?? 0),
    Number(scores?.understandability ?? 0),
    Number(scores?.behavior ?? 0),
    Number(scores?.englishLevel ?? 0),
    Number(scores?.availability ?? 0),
  ];
  const sum = values.reduce((acc, value) => acc + value, 0);
  return Number((sum / values.length).toFixed(2));
}

const metricSchema = [
  { key: "teachingQuality", label: "Teaching Quality" },
  { key: "understandability", label: "Understandability (Clarity/Accent)" },
  { key: "behavior", label: "Behavior (Respectful/Helpful)" },
  { key: "englishLevel", label: "English Level" },
  { key: "availability", label: "Availability (Office hours/Emails)" },
];

const TEACHING_POLICY_OPTIONS = [
  { value: "all", label: "All staff" },
  { value: "core", label: "Core teaching staff" },
  { value: "broad", label: "Broad teaching-related staff" },
];

function normalizeTeachingPolicy(value) {
  const normalized = String(value ?? "all")
    .trim()
    .toLowerCase();
  if (normalized === "core" || normalized === "broad") return normalized;
  return "all";
}

function getInitialFilterState() {
  if (typeof window === "undefined") {
    return {
      search: "",
      department: "All",
      roleTitle: "All",
      teachingPolicy: "all",
      page: 1,
    };
  }

  const params = new URLSearchParams(window.location.search);

  return {
    search: params.get("q") ?? "",
    department: params.get("dept") ?? "All",
    roleTitle: params.get("roleTitle") ?? "All",
    teachingPolicy: normalizeTeachingPolicy(params.get("teachingPolicy")),
    page: Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1),
  };
}

function RatingStars({ value }) {
  const rounded = Math.round(value);
  return (
    <div className="flex items-center gap-1">
      {Array.from({ length: 5 }).map((_, i) => {
        const active = i < rounded;
        return (
          <Star
            key={i}
            className={`h-4 w-4 ${
              active
                ? "fill-amber-400 text-amber-400"
                : "fill-transparent text-slate-300"
            }`}
          />
        );
      })}
    </div>
  );
}

function MetricBar({ label, value }) {
  const width = Math.max(0, Math.min(100, (value / 5) * 100));
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="text-slate-700">{label}</span>
        <span className="font-medium text-slate-900">
          {value.toFixed(1)} / 5
        </span>
      </div>
      <div className="h-2.5 w-full rounded-full bg-slate-100">
        <div
          className="h-2.5 rounded-full bg-indigo-500 transition-all"
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

function ProfessorCard({ professor, onOpen }) {
  const reviews = Number(professor?.reviewsCount ?? 0);
  const hasRatings = reviews > 0;

  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-lg font-semibold text-slate-900">
          {professor.name}
        </h3>
        <a
          href={professor.profileUrl}
          target="_blank"
          rel="noreferrer"
          className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"
          title="Open official profile"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700">
          {professor.department}
        </span>
        <span className="text-sm text-slate-600">{professor.role}</span>
      </div>

      <div className="mt-4 flex items-center justify-between rounded-xl bg-slate-50 p-3">
        {hasRatings ? (
          <>
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">
                Overall rating
              </p>
              <div className="mt-1 flex items-center gap-2">
                <span className="text-xl font-bold text-slate-900">
                  {Number(professor.avgRating ?? 0).toFixed(1)}
                </span>
                <RatingStars value={Number(professor.avgRating ?? 0)} />
              </div>
            </div>
            <span className="text-sm text-slate-500">{reviews} reviews</span>
          </>
        ) : (
          <p className="text-sm font-medium text-slate-500">Not yet rated</p>
        )}
      </div>

      <button
        onClick={() => onOpen(professor)}
        className="mt-4 inline-flex w-full items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
      >
        View Profile
      </button>
    </article>
  );
}

function RatingModal({ professor, onClose, onSubmit }) {
  const [scores, setScores] = useState({
    teachingQuality: 3,
    understandability: 3,
    behavior: 3,
    englishLevel: 3,
    availability: 3,
  });
  const [reviewText, setReviewText] = useState("");

  const handleRange = (key, value) => {
    setScores((prev) => ({ ...prev, [key]: Number(value) }));
  };

  const submit = (e) => {
    e.preventDefault();
    onSubmit({ professor, scores, reviewText });
    setReviewText("");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white shadow-2xl">
        <div className="sticky top-0 z-10 flex items-start justify-between border-b border-slate-200 bg-white p-5">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">
              {professor.name}
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              <span className="font-medium">{professor.department}</span> •{" "}
              {professor.role}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid gap-6 p-5 lg:grid-cols-2">
          <section className="space-y-4">
            <h3 className="text-base font-semibold text-slate-900">
              Rating Breakdown
            </h3>
            {metricSchema.map((m) => (
              <MetricBar
                key={m.key}
                label={m.label}
                value={professor.metrics[m.key] ?? 0}
              />
            ))}
          </section>

          <section className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-indigo-600" />
              <h3 className="text-base font-semibold text-slate-900">
                Submit New Rating
              </h3>
            </div>

            <form onSubmit={submit} className="space-y-4">
              {metricSchema.map((m) => (
                <div key={m.key}>
                  <label className="mb-1 block text-sm font-medium text-slate-700">
                    {m.label}:{" "}
                    <span className="text-indigo-700">{scores[m.key]}</span>
                  </label>
                  <input
                    type="range"
                    min="1"
                    max="5"
                    step="1"
                    value={scores[m.key]}
                    onChange={(e) => handleRange(m.key, e.target.value)}
                    className="w-full accent-indigo-600"
                  />
                </div>
              ))}

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  Optional review
                </label>
                <textarea
                  rows={4}
                  value={reviewText}
                  onChange={(e) => setReviewText(e.target.value)}
                  placeholder="Share your experience..."
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none ring-indigo-500 transition focus:ring"
                />
              </div>

              <button
                type="submit"
                className="w-full rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-500"
              >
                Submit Rating (Mock)
              </button>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
}

function AuthFlipModal({
  open,
  onClose,
  onOAuthSignIn,
  onMagicLinkSignIn,
  onEmailLogin,
  onEmailSignUp,
  oauthProvider,
  isOAuthProviderEnabled,
  isProviderStatusLoading,
}) {
  const [isSignUp, setIsSignUp] = useState(false);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [signUpName, setSignUpName] = useState("");
  const [signUpEmail, setSignUpEmail] = useState("");
  const [signUpPassword, setSignUpPassword] = useState("");

  useEffect(() => {
    if (!open) return;
    setIsSignUp(false);
    setLoginEmail("");
    setLoginPassword("");
    setSignUpName("");
    setSignUpEmail("");
    setSignUpPassword("");
  }, [open]);

  if (!open) return null;

  const handleLoginSubmit = async (e) => {
    e.preventDefault();
    await onEmailLogin({ email: loginEmail, password: loginPassword });
  };

  const handleSignUpSubmit = async (e) => {
    e.preventDefault();
    await onEmailSignUp({
      name: signUpName,
      email: signUpEmail,
      password: signUpPassword,
    });
  };

  const selectedEmail = (isSignUp ? signUpEmail : loginEmail).trim();

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/60 p-4">
      <style>{`
        .auth-flip-wrapper {
          --input-focus: #2d8cf0;
          --font-color: #323232;
          --font-color-sub: #666;
          --bg-color: #fff;
          --main-color: #323232;
        }
        .auth-flip-wrapper .switch {
          position: relative;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          gap: 30px;
          width: 50px;
          height: 20px;
          margin-top: 8px;
        }
        .auth-flip-wrapper .card-side::before {
          position: absolute;
          content: 'Log in';
          left: -70px;
          top: 0;
          width: 100px;
          text-decoration: underline;
          color: var(--font-color);
          font-weight: 600;
        }
        .auth-flip-wrapper .card-side::after {
          position: absolute;
          content: 'Sign up';
          left: 70px;
          top: 0;
          width: 100px;
          color: var(--font-color);
          font-weight: 600;
        }
        .auth-flip-wrapper .toggle {
          opacity: 0;
          width: 0;
          height: 0;
        }
        .auth-flip-wrapper .slider {
          box-sizing: border-box;
          border-radius: 5px;
          border: 2px solid var(--main-color);
          box-shadow: 4px 4px var(--main-color);
          position: absolute;
          cursor: pointer;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-color: var(--bg-color);
          transition: 0.3s;
        }
        .auth-flip-wrapper .slider:before {
          box-sizing: border-box;
          position: absolute;
          content: "";
          height: 20px;
          width: 20px;
          border: 2px solid var(--main-color);
          border-radius: 5px;
          left: -2px;
          bottom: 2px;
          background-color: var(--bg-color);
          box-shadow: 0 3px 0 var(--main-color);
          transition: 0.3s;
        }
        .auth-flip-wrapper .toggle:checked + .slider {
          background-color: var(--input-focus);
        }
        .auth-flip-wrapper .toggle:checked + .slider:before {
          transform: translateX(30px);
        }
        .auth-flip-wrapper .toggle:checked ~ .card-side:before {
          text-decoration: none;
        }
        .auth-flip-wrapper .toggle:checked ~ .card-side:after {
          text-decoration: underline;
        }
        .auth-flip-wrapper .flip-card__inner {
          width: 320px;
          height: 440px;
          position: relative;
          background-color: transparent;
          perspective: 1000px;
          text-align: center;
          transition: transform 0.8s;
          transform-style: preserve-3d;
        }
        .auth-flip-wrapper .toggle:checked ~ .flip-card__inner {
          transform: rotateY(180deg);
        }
        .auth-flip-wrapper .flip-card__front,
        .auth-flip-wrapper .flip-card__back {
          padding: 20px;
          position: absolute;
          inset: 0;
          display: flex;
          flex-direction: column;
          justify-content: flex-start;
          align-items: center;
          -webkit-backface-visibility: hidden;
          backface-visibility: hidden;
          background: #f1f5f9;
          gap: 14px;
          border-radius: 8px;
          border: 2px solid var(--main-color);
          box-shadow: 4px 4px var(--main-color);
        }
        .auth-flip-wrapper .flip-card__back {
          transform: rotateY(180deg);
        }
        .auth-flip-wrapper .flip-card__form {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 12px;
          width: 100%;
        }
        .auth-flip-wrapper .title {
          margin: 8px 0 6px 0;
          font-size: 24px;
          font-weight: 900;
          text-align: center;
          color: var(--main-color);
        }
        .auth-flip-wrapper .flip-card__input {
          width: 260px;
          height: 42px;
          border-radius: 5px;
          border: 2px solid var(--main-color);
          background-color: var(--bg-color);
          box-shadow: 4px 4px var(--main-color);
          font-size: 15px;
          font-weight: 600;
          color: var(--font-color);
          padding: 5px 10px;
          outline: none;
        }
        .auth-flip-wrapper .flip-card__input::placeholder {
          color: var(--font-color-sub);
          opacity: 0.8;
        }
        .auth-flip-wrapper .flip-card__input:focus {
          border: 2px solid var(--input-focus);
        }
        .auth-flip-wrapper .flip-card__btn {
          margin-top: 2px;
          width: 140px;
          height: 40px;
          border-radius: 5px;
          border: 2px solid var(--main-color);
          background-color: var(--bg-color);
          box-shadow: 4px 4px var(--main-color);
          font-size: 16px;
          font-weight: 700;
          color: var(--font-color);
          cursor: pointer;
        }
        .auth-flip-wrapper .flip-card__btn:active {
          box-shadow: 0px 0px var(--main-color);
          transform: translate(3px, 3px);
        }
      `}</style>

      <div className="auth-flip-wrapper relative">
        <button
          onClick={onClose}
          className="absolute right-2 top-2 z-20 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          Close
        </button>

        <div className="card-switch">
          <label className="switch">
            <input
              type="checkbox"
              className="toggle"
              checked={isSignUp}
              onChange={(e) => setIsSignUp(e.target.checked)}
            />
            <span className="slider"></span>
            <span className="card-side"></span>

            <div className="flip-card__inner">
              <div className="flip-card__front">
                <div className="title">Log in</div>
                <form className="flip-card__form" onSubmit={handleLoginSubmit}>
                  <input
                    className="flip-card__input"
                    name="email"
                    placeholder="Email"
                    type="email"
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    required
                  />
                  <input
                    className="flip-card__input"
                    name="password"
                    placeholder="Password"
                    type="password"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    required
                  />
                  <button className="flip-card__btn" type="submit">
                    Let`s go!
                  </button>
                </form>

                <div className="mt-1 flex flex-col items-center gap-2">
                  <button
                    type="button"
                    onClick={onOAuthSignIn}
                    disabled={isProviderStatusLoading}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                  >
                    {isProviderStatusLoading
                      ? "Checking provider..."
                      : isOAuthProviderEnabled
                        ? `Continue with ${String(oauthProvider || "google")
                            .charAt(0)
                            .toUpperCase()}${String(oauthProvider || "google").slice(1)}`
                        : "Provider disabled"}
                  </button>
                  <button
                    type="button"
                    onClick={() => onMagicLinkSignIn(selectedEmail)}
                    className="rounded-md border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-100"
                  >
                    Send magic link
                  </button>
                </div>
              </div>

              <div className="flip-card__back">
                <div className="title">Sign up</div>
                <form className="flip-card__form" onSubmit={handleSignUpSubmit}>
                  <input
                    className="flip-card__input"
                    placeholder="Name"
                    type="text"
                    value={signUpName}
                    onChange={(e) => setSignUpName(e.target.value)}
                    required
                  />
                  <input
                    className="flip-card__input"
                    name="email"
                    placeholder="Email"
                    type="email"
                    value={signUpEmail}
                    onChange={(e) => setSignUpEmail(e.target.value)}
                    required
                  />
                  <input
                    className="flip-card__input"
                    name="password"
                    placeholder="Password"
                    type="password"
                    value={signUpPassword}
                    onChange={(e) => setSignUpPassword(e.target.value)}
                    required
                  />
                  <button className="flip-card__btn" type="submit">
                    Confirm!
                  </button>
                </form>
                <button
                  type="button"
                  onClick={() => onMagicLinkSignIn(selectedEmail)}
                  className="rounded-md border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-100"
                >
                  Send magic link instead
                </button>
              </div>
            </div>
          </label>
        </div>
      </div>
    </div>
  );
}

export default function ProfessorDirectoryApp() {
  const initialFilters = getInitialFilterState();

  const [professors, setProfessors] = useState(fallbackProfessors);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [searchInput, setSearchInput] = useState(initialFilters.search);
  const [search, setSearch] = useState(initialFilters.search);
  const [activeDepartment, setActiveDepartment] = useState(
    initialFilters.department,
  );
  const [selectedProfessor, setSelectedProfessor] = useState(null);
  const [currentPage, setCurrentPage] = useState(initialFilters.page);
  const [isSyncingRatings, setIsSyncingRatings] = useState(false);
  const [ratingsError, setRatingsError] = useState("");
  const [currentUser, setCurrentUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);

  const [departments, setDepartments] = useState(["All"]);
  const [roleTitles, setRoleTitles] = useState(["All"]);
  const [activeRoleTitle, setActiveRoleTitle] = useState(
    initialFilters.roleTitle,
  );
  const [teachingPolicy, setTeachingPolicy] = useState(
    initialFilters.teachingPolicy,
  );
  const [totalResults, setTotalResults] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [isCatalogLoading, setIsCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");

  const pageSize = 6;
  const oauthProvider = String(import.meta.env.VITE_OAUTH_PROVIDER ?? "google")
    .trim()
    .toLowerCase();
  const [isOAuthProviderEnabled, setIsOAuthProviderEnabled] = useState(true);
  const [isProviderStatusLoading, setIsProviderStatusLoading] = useState(true);
  const signInButtonLabel = isProviderStatusLoading
    ? "Checking sign-in..."
    : getSignInButtonLabel({
        provider: oauthProvider,
        providerEnabled: isOAuthProviderEnabled,
      });

  useEffect(() => {
    let active = true;

    const checkProviderStatus = async () => {
      setIsProviderStatusLoading(true);
      const status = await getOAuthProviderStatus(oauthProvider);
      if (!active) return;
      setIsOAuthProviderEnabled(Boolean(status?.enabled));
      setIsProviderStatusLoading(false);
    };

    checkProviderStatus();

    return () => {
      active = false;
    };
  }, [oauthProvider]);

  useEffect(() => {
    let mounted = true;

    const bootstrapAuth = async () => {
      try {
        const user = await getCurrentUser();
        if (mounted) setCurrentUser(user);
      } catch (error) {
        if (mounted) {
          setAuthError("Could not initialize auth session.");
        }
      } finally {
        if (mounted) setAuthLoading(false);
      }
    };

    bootstrapAuth();

    const unsubscribe = onAuthStateChange((session) => {
      if (!mounted) return;
      setCurrentUser(session?.user ?? null);
      setAuthError("");
    });

    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setSearch(searchInput);
    }, 350);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [searchInput]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const params = new URLSearchParams();

    if (search.trim()) params.set("q", search.trim());
    if (activeDepartment !== "All") params.set("dept", activeDepartment);
    if (activeRoleTitle !== "All") params.set("roleTitle", activeRoleTitle);
    if (teachingPolicy !== "all") params.set("teachingPolicy", teachingPolicy);
    if (currentPage > 1) params.set("page", String(currentPage));

    const query = params.toString();
    const nextUrl = query
      ? `${window.location.pathname}?${query}`
      : window.location.pathname;

    window.history.replaceState({}, "", nextUrl);
  }, [search, activeDepartment, activeRoleTitle, teachingPolicy, currentPage]);

  useEffect(() => {
    let isMounted = true;

    const bootstrapData = async () => {
      if (isSupabaseConfigured) {
        try {
          const [deptList, roleTitleList] = await Promise.all([
            fetchCatalogDepartments(),
            fetchCatalogRoleTitles(),
          ]);

          let localDepartments = [];
          let localRoleTitles = [];

          try {
            const localResponse = await fetch("/professors.json");
            if (localResponse.ok) {
              const localRaw = await localResponse.json();

              localDepartments = Array.from(
                new Set(
                  (Array.isArray(localRaw) ? localRaw : [])
                    .map((row) => String(row?.department ?? "").trim())
                    .filter(Boolean),
                ),
              );

              localRoleTitles = Array.from(
                new Set(
                  (Array.isArray(localRaw) ? localRaw : [])
                    .map((row) => String(row?.role_title ?? "").trim())
                    .filter(Boolean),
                ),
              );
            }
          } catch (_localError) {
            // Non-critical fallback metadata read failure.
          }

          if (!isMounted) return;

          setDepartments([
            "All",
            ...new Set([
              ...(deptList ?? []).filter((d) => d && d !== "All"),
              ...localDepartments,
            ]),
          ]);
          setRoleTitles([
            "All",
            ...new Set([
              ...(roleTitleList ?? []).filter((t) => t && t !== "All"),
              ...localRoleTitles,
            ]),
          ]);

          setLoadError("");
          setIsLoading(false);
          return;
        } catch (_error) {
          if (!isMounted) return;
          setLoadError(
            "Catalog API unavailable. Falling back to local professors.json.",
          );
        }
      }

      try {
        const response = await fetch("/professors.json");
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const raw = await response.json();
        const mapped = Array.isArray(raw)
          ? raw.map(mapScrapedProfessor).filter(Boolean)
          : [];

        if (!isMounted) return;

        if (mapped.length > 0) {
          let hydrated = mapped;

          if (isRatingsApiConfigured()) {
            try {
              if (isMounted) {
                setRatingsError("");
                setIsSyncingRatings(true);
              }
              const summaries = await fetchRatingSummariesByProfileUrls(
                mapped.map((p) => p.profileUrl),
              );
              hydrated = mergeRatingSummariesIntoProfessors(mapped, summaries);
            } catch (_error) {
              if (isMounted) {
                setRatingsError("");
              }
            } finally {
              if (isMounted) setIsSyncingRatings(false);
            }
          }

          setProfessors(hydrated);
          setDepartments([
            "All",
            ...new Set(hydrated.map((p) => p.department)),
          ]);
          setRoleTitles([
            "All",
            ...new Set(
              hydrated
                .map((p) => String(p.role_title ?? p.role ?? "").trim())
                .filter(Boolean),
            ),
          ]);

          setTotalResults(hydrated.length);
          setTotalPages(1);
        } else {
          setLoadError(
            "No records found in professors.json. Showing fallback mock data.",
          );
        }
      } catch (_error) {
        if (!isMounted) return;
        setLoadError(
          "Could not load professors.json. Showing fallback mock data.",
        );
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };

    bootstrapData();
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    if (isLoading) return;

    let isMounted = true;

    const fetchCatalogPage = async () => {
      try {
        setIsCatalogLoading(true);
        setCatalogError("");

        const pageData = await fetchProfessorCatalogPage({
          page: currentPage,
          pageSize,
          search,
          department: activeDepartment,
          roleTitle: activeRoleTitle,
          teachingPolicy,
          sortBy: "display_name",
          sortOrder: "asc",
        });

        if (!isMounted) return;

        const mapped = (pageData.data ?? []).map((row) => ({
          id: `${row.canonical_id}-${row.department}`,
          name: row.display_name || row.full_name,
          department: row.department,
          role: row.role_title || row.role_category || "Teaching Staff",
          role_category: row.role_category || "OTHER",
          profileUrl: row.profile_url || row.source_url || "#",
          avgRating: 4.0,
          reviewsCount: 0,
          metrics: { ...defaultMetrics },
        }));

        setProfessors(mapped);
        setTotalResults(pageData.total ?? 0);
        setTotalPages(pageData.totalPages ?? 1);

        if (isRatingsApiConfigured() && mapped.length > 0) {
          try {
            setRatingsError("");
            setIsSyncingRatings(true);
            const summaries = await fetchRatingSummariesByProfileUrls(
              mapped.map((p) => p.profileUrl),
            );
            if (!isMounted) return;
            setProfessors(
              mergeRatingSummariesIntoProfessors(mapped, summaries),
            );
          } catch (_error) {
            if (isMounted) {
              setRatingsError("");
            }
          } finally {
            if (isMounted) setIsSyncingRatings(false);
          }
        }
      } catch (_error) {
        if (!isMounted) return;
        setCatalogError("Failed to load catalog page from Supabase.");
      } finally {
        if (isMounted) setIsCatalogLoading(false);
      }
    };

    fetchCatalogPage();

    return () => {
      isMounted = false;
    };
  }, [
    currentPage,
    pageSize,
    search,
    activeDepartment,
    activeRoleTitle,
    teachingPolicy,
    isLoading,
  ]);

  const filteredProfessors = useMemo(() => {
    if (isSupabaseConfigured) return professors;

    const normalizedSearch = normalizeSearchText(search);
    const teachingCategories = new Set([
      "FULL_PROFESSOR",
      "ASSOCIATE_PROFESSOR",
      "RESEARCHER",
    ]);
    const broadTeachingPattern =
      /professor|researcher|assegnista|docente|ricerca|contratto|fixed-term|phd|dottorando/i;

    return (professors ?? []).filter((p) => {
      const deptMatch =
        activeDepartment === "All" || p.department === activeDepartment;

      const categoryValue = String(p.role_category ?? "OTHER")
        .trim()
        .toUpperCase();

      const titleValue = String(p.role_title ?? p.role ?? "").trim();
      const titleMatch =
        activeRoleTitle === "All" || titleValue === activeRoleTitle;

      let teachingMatch = true;
      if (teachingPolicy === "core") {
        teachingMatch = teachingCategories.has(categoryValue);
      } else if (teachingPolicy === "broad") {
        teachingMatch =
          teachingCategories.has(categoryValue) ||
          broadTeachingPattern.test(titleValue);
      }

      if (!normalizedSearch) {
        return deptMatch && titleMatch && teachingMatch;
      }

      const haystack = normalizeSearchText(
        [
          p.name,
          p.department,
          p.role,
          p.role_title,
          p.role_category,
          p.profileUrl,
        ]
          .filter(Boolean)
          .join(" "),
      );

      return (
        deptMatch &&
        titleMatch &&
        teachingMatch &&
        haystack.includes(normalizedSearch)
      );
    });
  }, [professors, search, activeDepartment, activeRoleTitle, teachingPolicy]);

  const effectiveTotalResults = isSupabaseConfigured
    ? totalResults
    : filteredProfessors.length;
  const effectiveTotalPages = isSupabaseConfigured ? totalPages : 1;
  const safePage = Math.min(currentPage, Math.max(1, effectiveTotalPages));

  useEffect(() => {
    setCurrentPage(1);
  }, [search, activeDepartment, activeRoleTitle, teachingPolicy]);

  const handleExportFilteredCsv = () => {
    exportProfessorsToCsv(
      filteredProfessors,
      `professors_filtered_page_${safePage}_${Date.now()}.csv`,
    );
  };

  const handleExportCurrentPageCsv = () => {
    exportProfessorsToCsv(
      filteredProfessors,
      `professors_page_${safePage}_${Date.now()}.csv`,
    );
  };

  const handleSubmitRating = async ({ professor, scores, reviewText }) => {
    if (!professor) return;

    try {
      setRatingsError("");

      if (!currentUser) {
        setRatingsError("Please sign in before submitting a rating.");
        return;
      }

      if (isRatingsApiConfigured()) {
        await submitProfessorRating({
          profileUrl: professor.profileUrl,
          professorName: professor.name,
          department: professor.department,
          scores,
          reviewText,
          reviewerUniversity: "PoliTo",
          reviewerCourse: "Computer Engineering",
        });

        const summaries = await fetchRatingSummariesByProfileUrls([
          professor.profileUrl,
        ]);

        setProfessors((prev) =>
          mergeRatingSummariesIntoProfessors(prev, summaries),
        );
      } else {
        const overall = calculateOverallFromScores(scores);

        setProfessors((prev) =>
          prev.map((p) => {
            if (p.id !== professor.id) return p;

            const nextReviewsCount = Number(p.reviewsCount ?? 0) + 1;
            const previousWeightedTotal =
              Number(p.avgRating ?? 0) * Number(p.reviewsCount ?? 0);
            const nextAvg = Number(
              ((previousWeightedTotal + overall) / nextReviewsCount).toFixed(2),
            );

            return {
              ...p,
              avgRating: nextAvg,
              reviewsCount: nextReviewsCount,
              metrics: {
                teachingQuality: Number(scores.teachingQuality),
                understandability: Number(scores.understandability),
                behavior: Number(scores.behavior),
                englishLevel: Number(scores.englishLevel),
                availability: Number(scores.availability),
              },
            };
          }),
        );
      }

      setSelectedProfessor(null);
    } catch (error) {
      setRatingsError(
        "Failed to submit rating to Supabase. Please try again in a moment.",
      );
    }
  };

  const handleSignIn = async () => {
    setAuthError("");
    setIsAuthModalOpen(true);
  };

  const handleOAuthSignIn = async () => {
    try {
      setAuthError("");

      if (!supabase || !isSupabaseConfigured) {
        setAuthError(
          "Auth is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your frontend environment.",
        );
        return;
      }

      const status = await getOAuthProviderStatus(oauthProvider);
      setIsOAuthProviderEnabled(Boolean(status?.enabled));

      if (!status?.enabled) {
        setAuthError(
          `OAuth provider "${oauthProvider}" is disabled in Supabase. Use email login/signup or magic link.`,
        );
        return;
      }

      await signInWithOAuthProvider({
        provider: oauthProvider,
        redirectTo: window.location.href,
        checkProviderStatus: true,
      });
    } catch (error) {
      setAuthError(
        `Sign-in failed for provider "${oauthProvider}". ${String(
          error?.message ?? "Please try again.",
        )}`,
      );
    }
  };

  const handleMagicLinkSignIn = async (rawEmail) => {
    try {
      setAuthError("");

      const email = String(rawEmail ?? "")
        .trim()
        .toLowerCase();

      if (!email || !email.includes("@")) {
        setAuthError("Enter a valid email to receive a magic link.");
        return;
      }

      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: window.location.href,
        },
      });

      if (error) throw error;

      setAuthError(`Magic link sent to ${email}. Check your inbox.`);
    } catch (error) {
      setAuthError(
        `Magic-link sign-in failed. ${String(error?.message ?? "Please try again.")}`,
      );
    }
  };

  const handleEmailLogin = async ({ email, password }) => {
    try {
      setAuthError("");

      const normalizedEmail = String(email ?? "")
        .trim()
        .toLowerCase();
      const normalizedPassword = String(password ?? "");

      if (!normalizedEmail || !normalizedPassword) {
        setAuthError("Email and password are required.");
        return;
      }

      const { data, error } = await supabase.auth.signInWithPassword({
        email: normalizedEmail,
        password: normalizedPassword,
      });

      if (error) throw error;

      setCurrentUser(data?.user ?? null);
      setIsAuthModalOpen(false);
    } catch (error) {
      setAuthError(
        `Email login failed. ${String(error?.message ?? "Please try again.")}`,
      );
    }
  };

  const handleEmailSignUp = async ({ name, email, password }) => {
    try {
      setAuthError("");

      const normalizedName = String(name ?? "").trim();
      const normalizedEmail = String(email ?? "")
        .trim()
        .toLowerCase();
      const normalizedPassword = String(password ?? "");

      if (!normalizedName || !normalizedEmail || !normalizedPassword) {
        setAuthError("Name, email, and password are required.");
        return;
      }

      const { data, error } = await supabase.auth.signUp({
        email: normalizedEmail,
        password: normalizedPassword,
        options: {
          data: {
            full_name: normalizedName,
          },
          emailRedirectTo: window.location.href,
        },
      });

      if (error) throw error;

      if (data?.session) {
        setCurrentUser(data?.user ?? null);
        setIsAuthModalOpen(false);
      } else {
        setAuthError(
          `Sign-up successful for ${normalizedEmail}. Check your inbox to confirm your email, then log in.`,
        );
      }
    } catch (error) {
      setAuthError(
        `Sign-up failed. ${String(error?.message ?? "Please try again.")}`,
      );
    }
  };

  const handleSignOut = async () => {
    try {
      setAuthError("");
      await signOut();
      setCurrentUser(null);
    } catch (error) {
      setAuthError("Sign-out failed. Please try again.");
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <header className="relative mb-8 flex min-h-[42vh] flex-col items-center justify-center rounded-3xl border border-slate-200 bg-white px-6 py-10 text-center shadow-sm">
          <div className="absolute right-4 top-4">
            {authLoading ? (
              <div className="rounded-full bg-slate-100 px-3 py-1.5 text-sm text-slate-600">
                Checking session...
              </div>
            ) : currentUser ? (
              <div className="flex items-center gap-2">
                <div className="hidden items-center gap-2 rounded-full bg-emerald-50 px-3 py-1.5 text-sm text-emerald-700 sm:flex">
                  <GraduationCap className="h-4 w-4" />
                  {currentUser.email ?? "PoliTo Student"}
                </div>
                <button
                  onClick={handleSignOut}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50"
                >
                  <LogOut className="h-4 w-4" />
                  Sign out
                </button>
              </div>
            ) : (
              <button
                onClick={handleSignIn}
                disabled={isProviderStatusLoading}
                className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-70"
              >
                <LogIn className="h-4 w-4" />
                Log in / Sign up
              </button>
            )}
          </div>

          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">
            Politecnico di Torino
          </p>
          <h1 className="mt-2 text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">
            RateMyProf
          </h1>
          <p className="mt-3 text-sm text-slate-500 sm:text-base">
            Rate your professors at Politecnico and discover trusted student
            feedback.
          </p>

          <div className="mt-8 w-full max-w-4xl rounded-2xl border border-slate-200 bg-slate-50 p-2 shadow-inner">
            <div className="grid gap-2 md:grid-cols-[1fr_220px]">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search professor by name..."
                  className="h-12 w-full rounded-xl border border-slate-300 bg-white py-2.5 pl-11 pr-3 text-sm outline-none ring-indigo-500 transition focus:ring"
                />
              </div>
              <select
                value={activeDepartment}
                onChange={(e) => setActiveDepartment(e.target.value)}
                className="h-12 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none ring-indigo-500 transition focus:ring"
              >
                {departments.map((dept) => (
                  <option key={dept} value={dept}>
                    {dept}
                  </option>
                ))}
              </select>
            </div>

            <div className="mt-2 grid gap-2 md:grid-cols-[1fr_220px]">
              <select
                value={activeRoleTitle}
                onChange={(e) => setActiveRoleTitle(e.target.value)}
                className="h-12 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none ring-indigo-500 transition focus:ring"
              >
                {roleTitles.map((title) => (
                  <option key={title} value={title}>
                    {title}
                  </option>
                ))}
              </select>
              <select
                value={teachingPolicy}
                onChange={(e) => setTeachingPolicy(e.target.value)}
                className="h-12 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none ring-indigo-500 transition focus:ring"
              >
                {TEACHING_POLICY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <p className="mt-4 text-sm text-slate-600">
            Showing{" "}
            <span className="font-semibold">{filteredProfessors.length}</span>{" "}
            of <span className="font-semibold">{effectiveTotalResults}</span>{" "}
            professors • Page <span className="font-semibold">{safePage}</span>{" "}
            of <span className="font-semibold">{effectiveTotalPages}</span>
          </p>
        </header>

        <section className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleExportCurrentPageCsv}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50"
            >
              <Download className="h-4 w-4" />
              Export current page CSV
            </button>
            <button
              onClick={handleExportFilteredCsv}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50"
            >
              <Download className="h-4 w-4" />
              Export filtered CSV
            </button>
          </div>

          {isLoading && (
            <p className="text-sm text-slate-500">Loading professors.json...</p>
          )}
          {!isLoading && loadError && (
            <p className="text-sm text-amber-700">{loadError}</p>
          )}
          {!isLoading && isSyncingRatings && (
            <p className="text-sm text-slate-500">Syncing live ratings...</p>
          )}
          {!isLoading && ratingsError && (
            <p className="text-sm text-rose-700">{ratingsError}</p>
          )}
          {!isLoading && catalogError && (
            <p className="text-sm text-rose-700">{catalogError}</p>
          )}
          {!isLoading && authError && (
            <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {authError}
            </p>
          )}
          {isCatalogLoading && (
            <p className="text-sm text-slate-500">Loading catalog page...</p>
          )}
        </section>

        {filteredProfessors.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-slate-600">
            {isLoading
              ? "Loading professors..."
              : "No professors match your filters."}
          </div>
        ) : (
          <>
            <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredProfessors.map((professor) => (
                <ProfessorCard
                  key={professor.id}
                  professor={professor}
                  onOpen={setSelectedProfessor}
                />
              ))}
            </section>

            <section className="mt-5 flex items-center justify-center gap-2">
              <button
                onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
                disabled={safePage <= 1}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Previous
              </button>
              <span className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700">
                {safePage} / {effectiveTotalPages}
              </span>
              <button
                onClick={() =>
                  setCurrentPage((prev) =>
                    Math.min(effectiveTotalPages, prev + 1),
                  )
                }
                disabled={safePage >= effectiveTotalPages}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Next
              </button>
            </section>
          </>
        )}
      </div>

      <AuthFlipModal
        open={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
        onOAuthSignIn={handleOAuthSignIn}
        onMagicLinkSignIn={handleMagicLinkSignIn}
        onEmailLogin={handleEmailLogin}
        onEmailSignUp={handleEmailSignUp}
        oauthProvider={oauthProvider}
        isOAuthProviderEnabled={isOAuthProviderEnabled}
        isProviderStatusLoading={isProviderStatusLoading}
      />

      {selectedProfessor && (
        <RatingModal
          professor={selectedProfessor}
          onClose={() => setSelectedProfessor(null)}
          onSubmit={handleSubmitRating}
        />
      )}
    </div>
  );
}
