import React, { useMemo, useState } from "react";
import {
  Search,
  ExternalLink,
  Star,
  X,
  SlidersHorizontal,
  GraduationCap,
} from "lucide-react";

const initialProfessors = [
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

const metricSchema = [
  { key: "teachingQuality", label: "Teaching Quality" },
  { key: "understandability", label: "Understandability (Clarity/Accent)" },
  { key: "behavior", label: "Behavior (Respectful/Helpful)" },
  { key: "englishLevel", label: "English Level" },
  { key: "availability", label: "Availability (Office hours/Emails)" },
];

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
        <span className="font-medium text-slate-900">{value.toFixed(1)} / 5</span>
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
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-lg font-semibold text-slate-900">{professor.name}</h3>
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
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Overall rating</p>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-xl font-bold text-slate-900">
              {professor.avgRating.toFixed(1)}
            </span>
            <RatingStars value={professor.avgRating} />
          </div>
        </div>
        <span className="text-sm text-slate-500">{professor.reviewsCount} reviews</span>
      </div>

      <button
        onClick={() => onOpen(professor)}
        className="mt-4 inline-flex w-full items-center justify-center rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-700"
      >
        Rate / View Details
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
    onSubmit({ professorId: professor.id, scores, reviewText });
    setReviewText("");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white shadow-2xl">
        <div className="sticky top-0 z-10 flex items-start justify-between border-b border-slate-200 bg-white p-5">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">{professor.name}</h2>
            <p className="mt-1 text-sm text-slate-600">
              <span className="font-medium">{professor.department}</span> • {professor.role}
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
            <h3 className="text-base font-semibold text-slate-900">Rating Breakdown</h3>
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
              <h3 className="text-base font-semibold text-slate-900">Submit New Rating</h3>
            </div>

            <form onSubmit={submit} className="space-y-4">
              {metricSchema.map((m) => (
                <div key={m.key}>
                  <label className="mb-1 block text-sm font-medium text-slate-700">
                    {m.label}: <span className="text-indigo-700">{scores[m.key]}</span>
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

export default function ProfessorDirectoryApp() {
  const [professors] = useState(initialProfessors);
  const [search, setSearch] = useState("");
  const [activeDepartment, setActiveDepartment] = useState("All");
  const [selectedProfessor, setSelectedProfessor] = useState(null);

  const departments = useMemo(() => {
    const unique = [...new Set(professors.map((p) => p.department))].sort();
    return ["All", ...unique];
  }, [professors]);

  const filteredProfessors = useMemo(() => {
    const query = search.trim().toLowerCase();

    return professors.filter((p) => {
      const matchesDept =
        activeDepartment === "All" || p.department === activeDepartment;
      const matchesSearch =
        !query ||
        p.name.toLowerCase().includes(query) ||
        p.role.toLowerCase().includes(query) ||
        p.department.toLowerCase().includes(query);
      return matchesDept && matchesSearch;
    });
  }, [professors, search, activeDepartment]);

  const handleSubmitRating = (payload) => {
    console.log("Mock rating submitted:", payload);
    setSelectedProfessor(null);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <header className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">Auth State</p>
              <h1 className="mt-1 text-xl font-semibold">Rate My Professor</h1>
            </div>
            <div className="flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1.5 text-sm text-emerald-700">
              <GraduationCap className="h-4 w-4" />
              Logged in • PoliTo • Computer Engineering
            </div>
          </div>
        </header>

        <section className="mb-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search professors by name, role, or department..."
              className="w-full rounded-xl border border-slate-300 bg-slate-50 py-2.5 pl-10 pr-3 text-sm outline-none ring-indigo-500 transition focus:bg-white focus:ring"
            />
          </div>

          <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
            {departments.map((dept) => {
              const active = dept === activeDepartment;
              return (
                <button
                  key={dept}
                  onClick={() => setActiveDepartment(dept)}
                  className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                    active
                      ? "border-indigo-600 bg-indigo-600 text-white"
                      : "border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50"
                  }`}
                >
                  {dept}
                </button>
              );
            })}
          </div>
        </section>

        <section className="mb-3 flex items-center justify-between">
          <p className="text-sm text-slate-600">
            Showing <span className="font-semibold">{filteredProfessors.length}</span>{" "}
            professor{filteredProfessors.length === 1 ? "" : "s"}
          </p>
        </section>

        {filteredProfessors.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-slate-600">
            No professors match your filters.
          </div>
        ) : (
          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filteredProfessors.map((professor) => (
              <ProfessorCard
                key={professor.id}
                professor={professor}
                onOpen={setSelectedProfessor}
              />
            ))}
          </section>
        )}
      </div>

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
