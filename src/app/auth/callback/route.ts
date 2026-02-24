import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase-server';

/**
 * Auth callback handler for Supabase email confirmation and OAuth redirects.
 * After confirming their email, users are redirected here, and we exchange
 * the auth code for a session.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const rawNext = searchParams.get('next') ?? '/';
  const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';

  if (code) {
    const supabase = await createServerSupabaseClient();
    if (supabase) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error) {
        return NextResponse.redirect(`${origin}${next}`);
      }
    }
  }

  // If code exchange fails, redirect to login
  return NextResponse.redirect(`${origin}/login`);
}
