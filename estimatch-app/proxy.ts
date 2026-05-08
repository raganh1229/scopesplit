import { clerkClient, clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

const isPublicRoute = createRouteMatcher([
  '/',
  '/login(.*)',
  '/signup(.*)',
  '/verify(.*)',
  '/forgot-password(.*)',
  '/reset-password(.*)',
  '/faq(.*)',
  '/contact(.*)',
  '/privacy(.*)',
  '/terms(.*)',
  '/cookies(.*)',
  '/privacy-choices(.*)',
  '/security(.*)',
  '/acceptable-use(.*)',
  '/billing-refunds(.*)',
  '/data-processing-addendum(.*)',
  '/subscribe(.*)',
  '/error(.*)',
  '/sso-callback(.*)',
  '/api/webhooks/clerk(.*)',
  '/api/webhooks/stripe(.*)',
  '/api/internal/cleanup-unverified-users(.*)',
  '/api/contact(.*)',
  '/api/inngest(.*)',
]);

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

export default clerkMiddleware(async (auth, request) => {
  const { userId } = await auth();

  if (!isPublicRoute(request)) {
    await auth.protect();
  }

  if (userId && (isAppRoute(request) || isSubscribeRoute(request) || isVerifyPhoneRoute(request))) {
    const client = await clerkClient();
    let user;

    try {
      user = await client.users.getUser(userId);
    } catch {
      return NextResponse.redirect(new URL('/login', request.url));
    }

    const plan = (user.publicMetadata as { plan?: string })?.plan;
    const phoneVerified = (user.publicMetadata as { phoneVerifiedForTrial?: boolean })?.phoneVerifiedForTrial === true;

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
    try {
      const client = await clerkClient();
      const user = await client.users.getUser(userId);
      const plan = (user.publicMetadata as { plan?: string })?.plan;
      if (plan) {
        return NextResponse.redirect(new URL('/app/new-comparison', request.url));
      }
    } catch {
      // On error just let them view the page
    }
  }
});

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
