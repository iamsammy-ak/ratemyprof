# RateMyProf Frontend — Supabase Auth + Moderator Workflow

This document explains how to enable authentication, persist ratings in Supabase, and operate moderation for the frontend in `ratemyprof/frontend`.

## What is already wired in code

The frontend includes:

- Supabase environment-based initialization in `src/lib/supabase.js`
- Auth helpers in `src/lib/authApi.js` (Google sign-in/sign-out + session)
- Ratings API in `src/lib/ratingsApi.js` with:
  - authenticated rating upsert (one rating per user per professor)
  - live summary fetch and merge into cards
- UI integration in `src/ProfessorDirectoryApp.jsx`:
  - sign-in/sign-out controls in header
  - login required before rating submit
  - live ratings sync status/errors

Database schema for this flow is provided in:

- `supabase_ratings_schema.sql`

---

## 1) Create and configure a Supabase project

1. Create a Supabase project.
2. Open **Project Settings → API** and copy:
   - Project URL
   - Publishable/anon key
3. In `ratemyprof/frontend`, create `.env` from `.env.example`:

```ratemyprof/frontend/.env.example#L1-8
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your_public_anon_or_publishable_key
VITE_SUPABASE_DEBUG=false
```

Example `.env`:

```ratemyprof/frontend/.env#L1-3
VITE_SUPABASE_URL=https://abcdxyzcompany.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_xxxxxxxxxxxxxxxxxxxxxxxxx
VITE_SUPABASE_DEBUG=false
```

> Restart the dev server after changing environment variables.

---

## 2) Enable Google OAuth

Go to **Authentication → Providers → Google**:

1. Enable Google provider.
2. Configure Google OAuth credentials in Google Cloud Console.
3. Add Supabase callback URL in Google:
   - `https://<PROJECT_REF>.supabase.co/auth/v1/callback`
4. In Supabase **Authentication → URL Configuration**, set:
   - Site URL (local): `http://localhost:5173`
   - Production site URL (your deployed frontend)
   - Redirect URLs including both local and production URLs

This is required because `signInWithGoogle` uses redirect-based OAuth.

---

## 3) Apply database schema

In Supabase SQL Editor, run:

- `ratemyprof/frontend/supabase_ratings_schema.sql`

This creates:

- `public.professor_ratings`
- trigger functions (`updated_at`, server-side overall score calculation, moderation edit protection)
- moderation-aware RLS policies
- summary view `public.professor_rating_summary`
- indexes and grants

### Important constraints in schema

- One rating per user per professor:
  - unique key: `(user_id, profile_url)`
- Upsert compatibility:
  - frontend upsert uses `onConflict: "user_id,profile_url"`
- Public visibility:
  - only `approved` + not `hidden` records are publicly readable

---

## 4) Run frontend and verify auth

From `ratemyprof/frontend`:

```ratemyprof/frontend/package.json#L5-9
"scripts": {
  "dev": "vite",
  "build": "vite build",
  "preview": "vite preview"
}
```

Start app:

- `npm run dev`

Expected behavior:

- Header shows **Sign in with Google** when logged out
- After login, header shows user email + **Sign out**
- Rating submission requires login
- On submit, rating is inserted/updated in Supabase

---

## 5) Moderator role model

The SQL uses this function:

- `public.is_moderator()`

It checks JWT claim:

- `auth.jwt() -> 'app_metadata' ->> 'role' = 'moderator'`

So moderators are users with app metadata role `moderator`.

### Assign moderator role (Admin API / dashboard flow)

Set user app metadata to include:

```ratemyprof/frontend/README.md#L1-4
{
  "role": "moderator"
}
```

Once this claim is in the user JWT:

- Moderator can read all ratings (including pending/rejected/hidden)
- Moderator can update moderation fields on any row
- Moderator can delete ratings

Regular authenticated users:

- can insert/update only their own row (`auth.uid() = user_id`)
- cannot edit moderation-only fields

Public/anon users:

- can read only approved + visible ratings

---

## 6) Moderation workflow (recommended)

Suggested lifecycle:

1. User submits rating → default status `pending`
2. Moderator reviews content
3. Moderator sets:
   - `moderation_status`: `approved` or `rejected` or `flagged`
   - optional `moderation_reason`
   - `moderated_by`, `moderated_at`
   - `is_hidden` if temporary suppression needed
4. Public UI aggregates only approved + visible rows

### Useful SQL snippets

Approve a rating:

```ratemyprof/frontend/README.md#L1-7
update public.professor_ratings
set moderation_status = 'approved',
    moderation_reason = null,
    moderated_by = '<MODERATOR_USER_UUID>',
    moderated_at = now(),
    is_hidden = false
where id = '<RATING_UUID>';
```

Reject a rating:

```ratemyprof/frontend/README.md#L1-7
update public.professor_ratings
set moderation_status = 'rejected',
    moderation_reason = 'Off-topic or abusive language',
    moderated_by = '<MODERATOR_USER_UUID>',
    moderated_at = now(),
    is_hidden = true
where id = '<RATING_UUID>';
```

---

## 7) Current frontend limitations

At the moment:

- There is no dedicated moderator dashboard UI yet.
- Moderation actions are expected to be done in SQL or an admin tool.
- Review text is accepted as-is; no automatic profanity filtering in frontend.

Recommended next additions:

1. Moderator dashboard page with filters by status
2. Report button + `report_count` increment flow
3. Server-side content checks (Edge Function or backend moderation service)
4. Audit log table for moderation actions

---

## 8) Troubleshooting

### “Missing Supabase environment variables”
- Confirm `.env` exists in `ratemyprof/frontend`
- Ensure keys use `VITE_` prefix
- Restart dev server

### Sign-in opens Google but does not return to app
- Check Supabase redirect URL settings
- Check Google OAuth callback and authorized origins
- Verify `redirectTo` host matches allowed URL list

### “You must be logged in to submit or update a rating.”
- Session not established or expired
- Sign in again
- Confirm provider is enabled in Supabase

### Upsert errors mentioning conflict target
- Ensure unique constraint exists:
  - `(user_id, profile_url)`

### Public users cannot see ratings
- Confirm rows are moderated:
  - `moderation_status = 'approved'`
  - `is_hidden = false`

---

## 9) Security notes

- Frontend must only use the public/publishable key.
- Never expose service-role key in client code.
- Keep RLS enabled on `professor_ratings`.
- Prefer authenticated submissions to reduce abuse.
- For production, rate-limit and add anti-spam validation before write.

---

## 10) Quick checklist

- [ ] Supabase project created
- [ ] Google provider enabled
- [ ] `.env` configured with `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`
- [ ] `supabase_ratings_schema.sql` executed
- [ ] Login works in UI
- [ ] Submit rating creates/upserts row
- [ ] Moderator role assigned to at least one account
- [ ] Approved ratings visible publicly