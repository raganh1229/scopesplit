'use client';

import { useEffect } from 'react';
import { useClerk } from '@clerk/nextjs';
import { useRouter } from 'next/navigation';

export default function SSOCallbackPage() {
  const { handleRedirectCallback } = useClerk();
  const router = useRouter();

  useEffect(() => {
    handleRedirectCallback(
      {
        signInForceRedirectUrl: '/subscribe',
        signUpForceRedirectUrl: '/subscribe',
        signInFallbackRedirectUrl: '/subscribe',
        signUpFallbackRedirectUrl: '/subscribe',
      },
      (to: string) => Promise.resolve(router.replace(to)),
    );
  }, [handleRedirectCallback, router]);

  return null;
}
