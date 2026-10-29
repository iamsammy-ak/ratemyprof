import supabase, { isSupabaseConfigured } from "./supabase";

const TABLE = "professors_catalog";
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 200;

const ALLOWED_SORT_FIELDS = new Set([
  "display_name",
  "normalized_name",
  "department",
  "role_category",
  "role_title",
  "created_at",
  "updated_at",
]);

const ALLOWED_SORT_ORDERS = new Set(["asc", "desc"]);
const ALLOWED_TEACHING_POLICIES = new Set(["all", "core", "broad"]);

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function sanitizeSortBy(sortBy) {
  const field = String(sortBy ?? "display_name").trim();
  return ALLOWED_SORT_FIELDS.has(field) ? field : "display_name";
}

function sanitizeSortOrder(sortOrder) {
  const order = String(sortOrder ?? "asc")
    .trim()
    .toLowerCase();
  return ALLOWED_SORT_ORDERS.has(order) ? order : "asc";
}

function validateConfigured() {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error(
      "Supabase catalog API is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.",
    );
  }
}

function sanitizeTeachingPolicy(teachingPolicy, isTeachingStaffOnly) {
  const fallback = Boolean(isTeachingStaffOnly) ? "core" : "all";
  const policy = String(teachingPolicy ?? fallback)
    .trim()
    .toLowerCase();
  return ALLOWED_TEACHING_POLICIES.has(policy) ? policy : fallback;
}

/**
 * Builds a paginated query for professors_catalog with server-side filters.
 */
function buildCatalogQuery({
  search = "",
  department = "All",
  roleCategory = "All",
  roleTitle = "All",
  teachingPolicy = "all",
  isTeachingStaffOnly = false,
  sortBy = "display_name",
  sortOrder = "asc",
} = {}) {
  let query = supabase.from(TABLE).select(
    `
      id,
      canonical_id,
      full_name,
      normalized_name,
      display_name,
      department,
      role_title,
      role_category,
      is_teaching_staff,
      profile_url,
      source_url,
      created_at,
      updated_at
    `,
    { count: "exact" },
  );

  const normalizedDepartment = String(department ?? "").trim();
  if (normalizedDepartment && normalizedDepartment.toLowerCase() !== "all") {
    query = query.eq("department", normalizedDepartment);
  }

  const normalizedRoleCategory = String(roleCategory ?? "").trim();
  if (
    normalizedRoleCategory &&
    normalizedRoleCategory.toLowerCase() !== "all"
  ) {
    query = query.eq("role_category", normalizedRoleCategory);
  }

  const normalizedRoleTitle = String(roleTitle ?? "").trim();
  if (normalizedRoleTitle && normalizedRoleTitle.toLowerCase() !== "all") {
    query = query.eq("role_title", normalizedRoleTitle);
  }

  const normalizedTeachingPolicy = sanitizeTeachingPolicy(
    teachingPolicy,
    isTeachingStaffOnly,
  );

  if (normalizedTeachingPolicy === "core") {
    query = query.eq("is_teaching_staff", true);
  } else if (normalizedTeachingPolicy === "broad") {
    query = query.or(
      "is_teaching_staff.eq.true,role_category.eq.RESEARCHER,role_title.ilike.*assegnista*,role_title.ilike.*docente*,role_title.ilike.*contratto*,role_title.ilike.*fixed-term*,role_title.ilike.*phd*",
    );
  }

  const normalizedSearch = normalizeText(search);
  if (normalizedSearch) {
    const tokens = normalizedSearch.split(/\s+/).filter(Boolean);

    // AND semantics across tokens using normalized_name for robust matching.
    for (const token of tokens) {
      query = query.ilike("normalized_name", `%${token}%`);
    }
  }

  const orderField = sanitizeSortBy(sortBy);
  const orderDirection = sanitizeSortOrder(sortOrder);

  query = query.order(orderField, {
    ascending: orderDirection === "asc",
    nullsFirst: false,
  });

  return query;
}

/**
 * Fetches one page of professor catalog records from Supabase.
 *
 * @param {Object} params
 * @param {number} params.page 1-based page
 * @param {number} params.pageSize records per page
 * @param {string} params.search name search text
 * @param {string} params.department department filter, e.g. "DAUIN" or "All"
 * @param {string} params.roleCategory role category filter, e.g. "RESEARCHER" or "All"
 * @param {string} params.roleTitle role title filter, e.g. "Assegnista di Ricerca" or "All"
 * @param {string} params.teachingPolicy "all" | "core" | "broad"
 * @param {boolean} params.isTeachingStaffOnly legacy boolean alias (maps to "core" when true)
 * @param {string} params.sortBy field to sort by
 * @param {string} params.sortOrder "asc" | "desc"
 */
export async function fetchProfessorCatalogPage(params = {}) {
  validateConfigured();

  const page = clampInt(params.page, 1, 1_000_000, DEFAULT_PAGE);
  const pageSize = clampInt(
    params.pageSize,
    1,
    MAX_PAGE_SIZE,
    DEFAULT_PAGE_SIZE,
  );

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const query = buildCatalogQuery(params).range(from, to);
  const { data, error, count } = await query;

  if (error) {
    throw new Error(`Failed to fetch professor catalog: ${error.message}`);
  }

  const total = Number(count ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return {
    data: data ?? [],
    page,
    pageSize,
    total,
    totalPages,
    hasPrev: page > 1,
    hasNext: page < totalPages,
  };
}

/**
 * Fetches distinct departments from the catalog.
 */
export async function fetchCatalogDepartments() {
  validateConfigured();

  const { data, error } = await supabase
    .from(TABLE)
    .select("department")
    .order("department", { ascending: true });

  if (error) {
    throw new Error(`Failed to fetch departments: ${error.message}`);
  }

  const departments = Array.from(
    new Set(
      (data ?? [])
        .map((r) => String(r.department ?? "").trim())
        .filter(Boolean),
    ),
  );

  return ["All", ...departments];
}

/**
 * Fetches distinct role categories from the catalog.
 */
export async function fetchCatalogRoleCategories() {
  validateConfigured();

  const { data, error } = await supabase
    .from(TABLE)
    .select("role_category")
    .order("role_category", { ascending: true });

  if (error) {
    throw new Error(`Failed to fetch role categories: ${error.message}`);
  }

  const roleCategories = Array.from(
    new Set(
      (data ?? [])
        .map((r) => String(r.role_category ?? "").trim())
        .filter(Boolean),
    ),
  );

  return ["All", ...roleCategories];
}

/**
 * Fetches distinct role titles from the catalog.
 */
export async function fetchCatalogRoleTitles() {
  validateConfigured();

  const { data, error } = await supabase
    .from(TABLE)
    .select("role_title")
    .order("role_title", { ascending: true });

  if (error) {
    throw new Error(`Failed to fetch role titles: ${error.message}`);
  }

  const roleTitles = Array.from(
    new Set(
      (data ?? [])
        .map((r) => String(r.role_title ?? "").trim())
        .filter(Boolean),
    ),
  );

  return ["All", ...roleTitles];
}

/**
 * Fetch one professor by canonical_id + department (or canonical_id only).
 */
export async function fetchProfessorByCanonicalId(
  canonicalId,
  department = null,
) {
  validateConfigured();

  const canonical = String(canonicalId ?? "").trim();
  if (!canonical) {
    throw new Error("canonicalId is required.");
  }

  let query = supabase
    .from(TABLE)
    .select(
      `
      id,
      canonical_id,
      full_name,
      normalized_name,
      display_name,
      department,
      role_title,
      role_category,
      is_teaching_staff,
      profile_url,
      source_url,
      created_at,
      updated_at
    `,
    )
    .eq("canonical_id", canonical);

  const dept = String(department ?? "").trim();
  if (dept) {
    query = query.eq("department", dept);
  }

  const { data, error } = await query.limit(1).maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch professor: ${error.message}`);
  }

  return data ?? null;
}

/**
 * Convenience wrapper for teaching-staff-only browse mode.
 */
export async function fetchTeachingStaffPage(params = {}) {
  return fetchProfessorCatalogPage({
    ...params,
    teachingPolicy: "core",
  });
}
