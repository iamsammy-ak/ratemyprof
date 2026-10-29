import supabase, { isSupabaseConfigured } from "./supabase";

/**
 * Returns true when Supabase auth can be used.
 */
export function isAuthConfigured() {
  return isSupabaseConfigured && Boolean(supabase);
}

const SUPPORTED_OAUTH_PROVIDERS = new Set([
  "apple",
  "azure",
  "bitbucket",
  "discord",
  "facebook",
  "figma",
  "github",
  "gitlab",
  "google",
  "kakao",
  "keycloak",
  "linkedin_oidc",
  "notion",
  "slack_oidc",
  "spotify",
  "twitch",
  "twitter",
  "workos",
  "zoom",
]);

function normalizeProvider(provider) {
  return String(provider ?? "")
    .trim()
    .toLowerCase();
}

function listSupportedProviders() {
  return Array.from(SUPPORTED_OAUTH_PROVIDERS).sort().join(", ");
}

function formatProviderName(provider) {
  const normalized = normalizeProvider(provider) || "google";
  return normalized
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getSupabasePublicConfig() {
  const supabaseUrl = String(import.meta.env.VITE_SUPABASE_URL ?? "").trim();
  const publishableKey = String(
    import.meta.env.VITE_SUPABASE_ANON_KEY ??
      import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
      "",
  ).trim();

  return { supabaseUrl, publishableKey };
}

export async function getOAuthProviderStatus(provider = "google") {
  const normalizedProvider = normalizeProvider(provider);
  if (!SUPPORTED_OAUTH_PROVIDERS.has(normalizedProvider)) {
    throw new Error(
      `Unsupported OAuth provider "${provider}". Supported providers: ${listSupportedProviders()}.`,
    );
  }

  const { supabaseUrl, publishableKey } = getSupabasePublicConfig();
  if (!supabaseUrl || !publishableKey) {
    return {
      provider: normalizedProvider,
      enabled: false,
      settings: null,
      reason: "supabase_not_configured",
    };
  }

  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/settings`, {
      headers: {
        apikey: publishableKey,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Auth settings request failed with HTTP ${response.status}`,
      );
    }

    const settings = await response.json();
    const enabled = Boolean(settings?.external?.[normalizedProvider]);

    return {
      provider: normalizedProvider,
      enabled,
      settings,
      reason: enabled ? "enabled" : "disabled_in_project",
    };
  } catch (error) {
    return {
      provider: normalizedProvider,
      enabled: false,
      settings: null,
      reason: "settings_fetch_failed",
      error: String(error?.message ?? error ?? "Unknown error"),
    };
  }
}

export function getSignInButtonLabel({
  provider = "google",
  providerEnabled = true,
} = {}) {
  const providerName = formatProviderName(provider);
  if (providerEnabled) return `Sign in with ${providerName}`;
  return "Sign in with Magic Link";
}

/**
 * Starts OAuth sign-in for a configurable provider.
 * You can pass `redirectTo`, `scopes`, and `queryParams`.
 */
export async function signInWithOAuthProvider({
  provider = "google",
  redirectTo,
  scopes,
  queryParams,
  checkProviderStatus = false,
} = {}) {
  if (!isAuthConfigured()) {
    throw new Error(
      "Supabase auth is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.",
    );
  }

  const normalizedProvider = normalizeProvider(provider);
  if (!SUPPORTED_OAUTH_PROVIDERS.has(normalizedProvider)) {
    throw new Error(
      `Unsupported OAuth provider "${provider}". Supported providers: ${listSupportedProviders()}.`,
    );
  }

  if (checkProviderStatus) {
    const status = await getOAuthProviderStatus(normalizedProvider);
    if (!status.enabled) {
      throw new Error(
        `OAuth provider "${normalizedProvider}" is not enabled on your Supabase project. Enable it in Authentication > Providers and try again.`,
      );
    }
  }

  const options = {};
  if (redirectTo) options.redirectTo = redirectTo;
  if (typeof scopes === "string" && scopes.trim())
    options.scopes = scopes.trim();
  if (queryParams && typeof queryParams === "object") {
    options.queryParams = queryParams;
  }

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: normalizedProvider,
    options,
  });

  if (error) {
    const message = String(error?.message ?? "Unknown OAuth error");
    const code = String(error?.code ?? error?.error_code ?? "").toLowerCase();

    if (code === "validation_failed" || /unsupported provider/i.test(message)) {
      throw new Error(
        `OAuth provider "${normalizedProvider}" is not enabled on your Supabase project. Enable it in Authentication > Providers and try again.`,
      );
    }

    throw new Error(
      `OAuth sign-in failed for provider "${normalizedProvider}": ${message}`,
    );
  }

  return data;
}

/**
 * Backward-compatible helper for Google sign-in.
 */
export async function signInWithGoogle({
  redirectTo,
  scopes,
  queryParams,
  checkProviderStatus = true,
} = {}) {
  return signInWithOAuthProvider({
    provider: "google",
    redirectTo,
    scopes,
    queryParams,
    checkProviderStatus,
  });
}

/**
 * Signs out the current user.
 */
export async function signOut() {
  if (!isAuthConfigured()) {
    throw new Error("Supabase auth is not configured.");
  }

  const { error } = await supabase.auth.signOut();
  if (error) {
    throw new Error(`Sign-out failed: ${error.message}`);
  }

  return true;
}

/**
 * Returns current authenticated user or null.
 */
export async function getCurrentUser() {
  if (!isAuthConfigured()) return null;

  const { data, error } = await supabase.auth.getUser();
  if (error) {
    throw new Error(`Failed to fetch current user: ${error.message}`);
  }

  return data?.user ?? null;
}

/**
 * Returns current session or null.
 */
export async function getCurrentSession() {
  if (!isAuthConfigured()) return null;

  const { data, error } = await supabase.auth.getSession();
  if (error) {
    throw new Error(`Failed to fetch current session: ${error.message}`);
  }

  return data?.session ?? null;
}

/**
 * Subscribe to auth state changes.
 * Returns a function to unsubscribe.
 */
export function onAuthStateChange(callback) {
  if (!isAuthConfigured()) {
    return () => {};
  }

  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    callback?.(session ?? null);
  });

  return () => {
    data?.subscription?.unsubscribe();
  };
}
