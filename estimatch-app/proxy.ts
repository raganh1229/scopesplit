import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

// ── Protected routes (require auth) ──
// Everything else is public by default. This prevents drift when adding new
// marketing pages — no need to update this file for each new public page.
// (#24 fix: inverted from allow-list to block-list approach)
const isProtectedRoute = createRouteMatcher([
  '/app(.*)',
  '/subscribe(.*)',
  '/verify-phone(.*)',
  '/api/comparisons(.*)',
  '/api/bug-report(.*)',
  '/api/contact(.*)', // has public handler, but auth routes exist too
  '/api/settings(.*)',
  '/api/verification(.*)',
  '/api/stripe(.*)',
  '/api/internal(.*)',
  '/api/notes(.*)',
  '/api/billing(.*)',
  '/api/user(.*)',
]);

// ── Public API routes (webhooks, contact form) ──
// These API routes are explicitly public and skip auth checks
const isPublicApiRoute = createRouteMatcher([
  '/api/webhooks/clerk(.*)',
  '/api/webhooks/stripe(.*)',
  '/api/contact(.*)',
  '/api/inngest(.*)',
]);

// Route matchers for post-auth redirects (phone verification, plan checks)
const isAppRoute = createRouteMatcher(['/app(.*)']);
const isSubscribeRoute = createRouteMatcher(['/subscribe(.*)']);
const isVerifyPhoneRoute = createRouteMatcher(['/verify-phone(.*)']);
// Only redirect subscribed users away from promotional/marketing pages.
// Legal & policy pages remain reachable from the Settings → Legal & Privacy tab.
const isMarketingRoute = createRouteMatcher([
  '/',
  '/faq(.*)',
  '/contact(.*)',
]);

type SessionMeta = { plan?: string; phoneVerifiedForTrial?: boolean };

export default clerkMiddleware(async (auth, request) => {
  const { userId, sessionClaims } = await auth();

  // Protect private routes (everything else is public by default - #24 fix)
  if (isProtectedRoute(request) && !isPublicApiRoute(request)) {
    await auth.protect();
  }

  if (userId && (isAppRoute(request) || isSubscribeRoute(request) || isVerifyPhoneRoute(request))) {
    const meta = (sessionClaims?.metadata ?? {}) as SessionMeta;
    const plan = meta.plan;
    const phoneVerified = meta.phoneVerifiedForTrial === true;

    if (!phoneVerified && !plan && (isAppRoute(request) || isSubscribeRoute(request))) {
      const returnTo = `${request.nextUrl.pathname}${request.nextUrl.search}`;
      const verifyPhoneUrl = new URL('/verify-phone', request.url);
      verifyPhoneUrl.searchParams.set('returnTo', returnTo);
      return NextResponse.redirect(verifyPhoneUrl);
    }

    if (isVerifyPhoneRoute(request) && (phoneVerified || Boolean(plan))) {
      return NextResponse.redirect(new URL(plan ? '/app/new-comparison' : '/subscribe', request.url));
    }

    if (isAppRoute(request) && !plan) {
      const subscribeUrl = new URL('/subscribe', request.url);
      subscribeUrl.search = request.nextUrl.search;
      return NextResponse.redirect(subscribeUrl);
    }

    if (isSubscribeRoute(request) && plan) {
      return NextResponse.redirect(new URL('/app/new-comparison', request.url));
    }
  }

  // Subscribed + logged-in users have no business on marketing pages
  if (userId && isMarketingRoute(request)) {
    const meta = (sessionClaims?.metadata ?? {}) as SessionMeta;
    if (meta.plan) {
      return NextResponse.redirect(new URL('/app/new-comparison', request.url));
    }
  }
});

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
