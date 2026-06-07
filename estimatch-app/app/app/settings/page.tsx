'use client';

import { useEffect, useState, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useReverification, useUser } from '@clerk/nextjs';
import MobileAppBar from '@/components/app/MobileAppBar';
import TrialBanner from '@/components/app/TrialBanner';
import { useTheme } from '@/lib/theme-context';
import styles from './page.module.css';

const tabs = ['Account', 'Plan & Billing', 'Appearance', 'Notifications', 'Legal & Privacy'];

type BillingSummary = {
  fullName: string | null;
  email: string;
  phoneNumber?: string | null;
  plan: 'starter' | 'professional' | 'business' | null;
  pendingDowngradePlan: 'starter' | 'professional' | 'business' | null;
  pendingDowngradeEffectiveAt: string | null;
  status: 'TRIALING' | 'ACTIVE' | 'CANCELED' | 'PAST_DUE' | 'EXPIRED' | null;
  subscriptionEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  comparisonsUsed: number;
  comparisonLimit: number | null;
  llmEditsUsed: number;
  llmEditLimit: number | null;
  executiveSummariesUsed: number;
  executiveSummaryLimit: number | null;
  periodResetDate: string | null;
  usageLocked: boolean;
  llmEditsLocked: boolean;
  executiveSummariesLocked: boolean;
  addonOption:
    | {
        key: 'starter_addon_5' | 'professional_addon_10' | 'business_addon_10';
        label: string;
        priceLabel: string;
      }
    | null;
};

type AvailablePlan = NonNullable<BillingSummary['plan']>;

type PlanChangeResponse = {
  plan: AvailablePlan;
  previousPlan: AvailablePlan;
  changeType: 'upgrade' | 'downgrade' | 'none';
  subscriptionEndsAt: string | null;
  comparisonsUsed: number;
  effectiveComparisonLimit: number;
  nextComparisonLimit: number;
  amountDueNowCents: number;
  nextChargeAmountCents: number;
  error?: string;
};

type EmailOptInPreference = {
  emailOptIn: boolean;
  neverShowAgain: boolean;
  error?: string;
};

const BILLING_SUMMARY_CACHE_TTL_MS = 15_000;
let billingSummaryCache:
  | {
      fetchedAt: number;
      value: BillingSummary;
    }
  | null = null;

const PLAN_LABELS: Record<NonNullable<BillingSummary['plan']>, string> = {
  starter: 'Starter',
  professional: 'Professional',
  business: 'Business',
};

const PLAN_COPY: Record<NonNullable<BillingSummary['plan']>, string> = {
  starter: '$59/month · Up to 10 comparisons',
  professional: '$179/month · Up to 35 comparisons',
  business: '$349/month · Up to 100 comparisons',
};

const PLAN_ORDER: AvailablePlan[] = ['starter', 'professional', 'business'];

function formatCurrencyFromCents(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100);
}

function formatDate(value: string | null): string {
  if (!value) return 'Not available';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';

  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

// Next.js requires `useSearchParams()` to be inside a Suspense boundary so
// the page can be statically prerendered. The default export wraps the
// actual content in <Suspense>; SettingsContent below is the real page.
export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsContent />
    </Suspense>
  );
}

function SettingsContent() {
  const [activeTab, setActiveTab] = useState('Account');
  const [resumeLoading, setResumeLoading] = useState(false);
  const [cancelDowngradeLoading, setCancelDowngradeLoading] = useState(false);
  const [planChangeLoading, setPlanChangeLoading] = useState<AvailablePlan | null>(null);
  const [addonLoading, setAddonLoading] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [billingSummary, setBillingSummary] = useState<BillingSummary | null>(null);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [showKeepSubscriptionPrompt, setShowKeepSubscriptionPrompt] = useState(false);
  const [showTierSelector, setShowTierSelector] = useState(false);
  const [latestPlanChange, setLatestPlanChange] = useState<PlanChangeResponse | null>(null);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);
  const [isHydrated, setIsHydrated] = useState(false);
  const [openLegal, setOpenLegal] = useState<Set<string>>(new Set());
  const [emailOptIn, setEmailOptIn] = useState(false);
  const [emailOptInLoaded, setEmailOptInLoaded] = useState(false);
  const [emailOptInLoading, setEmailOptInLoading] = useState(false);
  const [emailOptInError, setEmailOptInError] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const { user } = useUser();
  const { theme, setTheme } = useTheme();

  const updatePasswordWithReverification = useReverification(async (password: string) => {
    if (!user) {
      throw new Error('User is not available.');
    }

    return user.updatePassword({
      newPassword: password,
      signOutOfOtherSessions: false,
    });
  });

  const passwordEnabled = Boolean((user as unknown as { passwordEnabled?: boolean } | null)?.passwordEnabled);
  const externalProvider = (user as unknown as {
    externalAccounts?: Array<{ provider?: string }>;
  } | null)?.externalAccounts?.[0]?.provider;
  const googleLinked = typeof externalProvider === 'string' && externalProvider.toLowerCase().includes('google');
  const passwordButtonLabel = !isHydrated
    ? 'Loading...'
    : passwordEnabled
      ? 'Reset password'
      : googleLinked
        ? 'Logged in with Google'
        : 'Password unavailable';

  async function loadBillingSummary(options?: { force?: boolean }) {
    const forceRefresh = options?.force ?? false;
    const now = Date.now();
    if (!forceRefresh && billingSummaryCache && now - billingSummaryCache.fetchedAt < BILLING_SUMMARY_CACHE_TTL_MS) {
      setBillingSummary(billingSummaryCache.value);
      setSummaryLoading(false);
      return;
    }

    if (forceRefresh) {
      billingSummaryCache = null;
    }

    setSummaryLoading(true);

    try {
      const response = await fetch(
        `/api/billing/summary${forceRefresh ? `?refresh=${Date.now()}` : ''}`,
        { cache: 'no-store' }
      );
      const payload = (await response.json()) as BillingSummary & { error?: string };

      if (!response.ok) {
        throw new Error(payload.error ?? 'Unable to load billing summary.');
      }

      billingSummaryCache = {
        fetchedAt: Date.now(),
        value: payload,
      };
      setBillingSummary(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load billing summary.';
      setBillingError(message);
    } finally {
      setSummaryLoading(false);
    }
  }

  async function cancelDowngrade() {
    if (!hasPendingDowngrade || cancelDowngradeLoading) return;

    setCancelDowngradeLoading(true);
    setBillingError(null);

    try {
      const response = await fetch('/api/stripe/cancel-downgrade', {
        method: 'POST',
      });

      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? 'Unable to cancel scheduled downgrade.');
      }

      await loadBillingSummary({ force: true });
      window.dispatchEvent(new CustomEvent('billing-summary-updated'));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to cancel scheduled downgrade.';
      setBillingError(message);
    } finally {
      setCancelDowngradeLoading(false);
    }
  }

  async function setEmailOptInPreference(nextValue: boolean) {
    if (emailOptInLoading) return;

    setEmailOptInLoading(true);
    setEmailOptInError(null);

    try {
      const response = await fetch('/api/user/email-opt-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enrolled: nextValue }),
      });

      const payload = (await response.json()) as EmailOptInPreference;

      if (!response.ok) {
        throw new Error(payload.error ?? 'Unable to update notification preferences.');
      }

      setEmailOptIn(payload.emailOptIn);
      window.dispatchEvent(
        new CustomEvent('email-opt-in-updated', {
          detail: { emailOptIn: payload.emailOptIn },
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to update notification preferences.';
      setEmailOptInError(message);
    } finally {
      setEmailOptInLoading(false);
    }
  }

  useEffect(() => {
    async function loadSummary() {
      await loadBillingSummary();
    }

    void loadSummary();
  }, []);

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  useEffect(() => {
    async function loadEmailOptInPreference() {
      try {
        const response = await fetch('/api/user/email-opt-in');
        const payload = (await response.json()) as EmailOptInPreference;

        if (!response.ok) {
          throw new Error(payload.error ?? 'Unable to load notification preferences.');
        }

        setEmailOptIn(payload.emailOptIn);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to load notification preferences.';
        setEmailOptInError(message);
      } finally {
        setEmailOptInLoaded(true);
      }
    }

    void loadEmailOptInPreference();
  }, []);

  useEffect(() => {
    function handleEmailOptInUpdated(event: Event) {
      const customEvent = event as CustomEvent<{ emailOptIn?: boolean }>;
      if (typeof customEvent.detail?.emailOptIn === 'boolean') {
        setEmailOptIn(customEvent.detail.emailOptIn);
      }
    }

    window.addEventListener('email-opt-in-updated', handleEmailOptInUpdated);
    return () => {
      window.removeEventListener('email-opt-in-updated', handleEmailOptInUpdated);
    };
  }, []);

  useEffect(() => {
    if (searchParams.get('tierSelector') === '1') {
      setActiveTab('Plan & Billing');
      setShowKeepSubscriptionPrompt(false);
      setShowTierSelector(true);
    }
  }, [searchParams]);

  useEffect(() => {
    if (searchParams.get('cancelled') === '1') {
      setActiveTab('Plan & Billing');
      setShowTierSelector(false);
      setShowKeepSubscriptionPrompt(false);
      void loadBillingSummary({ force: true });
    }
  }, [searchParams]);

  function openManageSubscription() {
    // Opens the in-app tier-selector modal. If the user has already scheduled
    // a cancellation, prompt them to keep their subscription first instead of
    // jumping straight to plan change. No Stripe-hosted portal is used —
    // plan changes flow through POST /api/stripe/change-plan via the modal.
    if (isCancellationScheduled) {
      setShowKeepSubscriptionPrompt(true);
      return;
    }

    setShowTierSelector(true);
  }

  function openTierSelectorFromPrompt() {
    setShowKeepSubscriptionPrompt(false);
    setShowTierSelector(true);
  }

  async function changePlan(plan: AvailablePlan) {
    setPlanChangeLoading(plan);
    setBillingError(null);

    try {
      const response = await fetch('/api/stripe/change-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
      });

      const payload = (await response.json()) as PlanChangeResponse;
      if (!response.ok) {
        throw new Error(payload.error ?? 'Unable to change subscription plan.');
      }

      setShowTierSelector(false);
      setShowKeepSubscriptionPrompt(false);
      await loadBillingSummary({ force: true });
      window.dispatchEvent(new CustomEvent('billing-summary-updated'));
      setLatestPlanChange(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to change subscription plan.';
      setBillingError(message);
    } finally {
      setPlanChangeLoading(null);
    }
  }

  async function keepSubscription() {
    setResumeLoading(true);
    setBillingError(null);

    try {
      const response = await fetch('/api/stripe/resume', {
        method: 'POST',
      });

      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? 'Unable to keep subscription.');
      }

      setShowKeepSubscriptionPrompt(false);
      await loadBillingSummary({ force: true });
      window.dispatchEvent(new CustomEvent('billing-summary-updated'));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to keep subscription.';
      setBillingError(message);
    } finally {
      setResumeLoading(false);
    }
  }

  async function openAddonCheckout() {
    if (!billingSummary?.addonOption) return;

    setAddonLoading(true);
    setBillingError(null);

    try {
      const response = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'addon',
          addon: billingSummary.addonOption.key,
        }),
      });

      const payload = (await response.json()) as { url?: string; error?: string };

      if (!response.ok || !payload.url) {
        throw new Error(payload.error ?? 'Unable to start add-on checkout.');
      }

      window.location.href = payload.url;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to start add-on checkout.';
      setBillingError(message);
      setAddonLoading(false);
    }
  }

  function openPasswordModal() {
    setNewPassword('');
    setConfirmPassword('');
    setPasswordError(null);
    setPasswordSuccess(null);
    setShowPasswordModal(true);
  }

  function closePasswordModal() {
    setShowPasswordModal(false);
    setNewPassword('');
    setConfirmPassword('');
    setPasswordError(null);
    setPasswordSuccess(null);
  }

  async function handlePasswordReset() {
    if (!passwordEnabled || passwordLoading || !user) return;

    if (!newPassword || !confirmPassword) {
      setPasswordError('Please complete both password fields.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordError('New password and confirmation do not match.');
      return;
    }

    setPasswordLoading(true);
    setPasswordError(null);
    setPasswordSuccess(null);

    try {
      await updatePasswordWithReverification(newPassword);

      setPasswordSuccess('Password updated successfully. You can now sign in with your new password.');
      setNewPassword('');
      setConfirmPassword('');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to reset password.';
      setPasswordError(message);
    } finally {
      setPasswordLoading(false);
    }
  }

  const isCancellationScheduled = billingSummary?.cancelAtPeriodEnd ?? false;
  const hasPendingDowngrade =
    Boolean(billingSummary?.plan)
    && Boolean(billingSummary?.pendingDowngradePlan)
    && billingSummary?.pendingDowngradePlan !== billingSummary?.plan;
  const pendingDowngradeCurrentPlanLabel =
    billingSummary?.plan ? PLAN_LABELS[billingSummary.plan] : null;
  const pendingDowngradeTargetPlanLabel =
    billingSummary?.pendingDowngradePlan ? PLAN_LABELS[billingSummary.pendingDowngradePlan] : null;
  const planStatusLabel = isCancellationScheduled
    ? 'EXPIRING'
    : (billingSummary?.status ?? 'INACTIVE');
  const latestChangeDate = formatDate(
    latestPlanChange?.subscriptionEndsAt
      ?? billingSummary?.periodResetDate
      ?? billingSummary?.subscriptionEndsAt
      ?? null
  );
  const latestRemainingComparisons = latestPlanChange
    ? Math.max(latestPlanChange.effectiveComparisonLimit - latestPlanChange.comparisonsUsed, 0)
    : 0;

  return (
    <>
      <MobileAppBar title="Settings" />
      <TrialBanner />

      <div className={styles.settingsHeader}>
        <h1>Settings</h1>
      </div>

      <div className={styles.settingsBody}>
        {/* Tabs */}
        <div className={styles.tabs}>
          {tabs.map(t => (
            <button key={t} className={`${styles.tab} ${activeTab === t ? styles.tabActive : ''}`} onClick={() => setActiveTab(t)}>
              {t}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className={styles.panel}>
          {activeTab === 'Account' && (
            <>
              <h2>Account</h2>
              <p className={styles.desc}>Manage your profile information and security.</p>
              <div className={styles.group}>
                <div className={styles.groupTitle}>Profile</div>
                <div className={styles.row}>
                  <div><div className={styles.rowLabel}>Full name</div><div className={styles.rowDesc}>The name displayed on your account and reports.</div></div>
                  <span className={styles.usageVal}>{billingSummary?.fullName?.trim() || 'Not set'}</span>
                </div>
                <div className={styles.row}>
                  <div><div className={styles.rowLabel}>Email address</div><div className={styles.rowDesc}>Used for login and notifications.</div></div>
                  <span className={styles.usageVal}>{billingSummary?.email ?? 'Not available'}</span>
                </div>
                <div className={styles.row}>
                  <div><div className={styles.rowLabel}>Verified phone number</div><div className={styles.rowDesc}>Used to verify account ownership and trial eligibility.</div></div>
                  <span className={styles.usageVal}>{billingSummary?.phoneNumber?.trim() || 'Not verified'}</span>
                </div>
              </div>
              <div className={styles.group}>
                <div className={styles.groupTitle}>Security</div>
                <div className={styles.row}>
                  <div>
                    <div className={styles.rowLabel}>Change password</div>
                    <div className={styles.rowDesc}>
                      {!isHydrated
                        ? 'Loading password options...'
                        : passwordEnabled
                          ? 'Set a new password. Clerk will prompt verification if required.'
                          : googleLinked
                            ? 'Logged in using Google. Manage your password in your Google account.'
                            : 'Password reset is unavailable for this sign-in method.'}
                    </div>
                  </div>
                  <button className={styles.btn} onClick={openPasswordModal} disabled={!isHydrated || !passwordEnabled}>
                    {passwordButtonLabel}
                  </button>
                </div>
              </div>
            </>
          )}

          {activeTab === 'Plan & Billing' && (
            <>
              <h2>Plan &amp; Billing</h2>
              <p className={styles.desc}>Manage your subscription and payment details.</p>
              {billingError && <p className={styles.billingError}>{billingError}</p>}
              {summaryLoading && <p className={styles.desc}>Loading billing details…</p>}
              <div className={styles.group}>
                <div className={styles.groupTitle}>Current plan</div>
                <div className={styles.planCard}>
                  <div>
                    <h3>
                      {billingSummary?.plan ? PLAN_LABELS[billingSummary.plan] : 'No active plan'}
                      <span className={`${styles.planBadge} ${isCancellationScheduled ? styles.planBadgeExpiring : ''}`}>
                        {planStatusLabel}
                      </span>
                    </h3>
                    <p>
                      {billingSummary?.plan
                        ? PLAN_COPY[billingSummary.plan]
                        : 'Subscribe to unlock comparisons and billing controls.'}
                    </p>
                    {billingSummary?.plan && !isCancellationScheduled && (
                      <p className={styles.expiringNotice}>
                        Card will be charged on {formatDate(billingSummary?.periodResetDate ?? null)}.
                      </p>
                    )}
                    {isCancellationScheduled && (
                      <p className={styles.expiringNotice}>
                        Your current plan will expire on {formatDate(billingSummary?.subscriptionEndsAt ?? null)}.
                      </p>
                    )}
                    {hasPendingDowngrade && pendingDowngradeCurrentPlanLabel && pendingDowngradeTargetPlanLabel && (
                      <div className={styles.downgradeNotice}>
                        <span className={styles.downgradeArrow} aria-hidden="true">↘</span>
                        <div>
                          <p className={styles.downgradeRoute}>
                            {pendingDowngradeCurrentPlanLabel} &rarr; {pendingDowngradeTargetPlanLabel}
                          </p>
                          <p className={styles.downgradeCopy}>
                            This tier change is currently planned to take effect next billing cycle on {formatDate(billingSummary?.pendingDowngradeEffectiveAt ?? billingSummary?.periodResetDate ?? null)}.
                          </p>
                          <div className={styles.downgradeActions}>
                            <button
                              type="button"
                              className={styles.btn}
                              onClick={() => void cancelDowngrade()}
                              disabled={cancelDowngradeLoading || planChangeLoading !== null || resumeLoading}
                            >
                              {cancelDowngradeLoading ? 'Canceling…' : 'Cancel downgrade'}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                  <button className={styles.btn} onClick={openManageSubscription} disabled={resumeLoading || cancelDowngradeLoading || planChangeLoading !== null}>
                    Manage subscription
                  </button>
                </div>
              </div>
              {isCancellationScheduled && billingSummary?.plan && (
                <div className={styles.cancellationBanner}>
                  <span className={styles.cancellationBannerIcon} aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  </span>
                  <div>
                    <p className={styles.cancellationBannerTitle}>Your subscription has been cancelled</p>
                    <p className={styles.cancellationBannerBody}>
                      You will lose access to ScopeSplit on <strong>{formatDate(billingSummary.subscriptionEndsAt)}</strong>. You have{' '}
                      <strong>{Math.max(0, (billingSummary.comparisonLimit ?? 0) - billingSummary.comparisonsUsed)} comparison{Math.max(0, (billingSummary.comparisonLimit ?? 0) - billingSummary.comparisonsUsed) !== 1 ? 's' : ''}</strong>{' '}
                      remaining this period. To continue using ScopeSplit, click <strong>Manage Subscription</strong> above to resubscribe.
                    </p>
                  </div>
                </div>
              )}
              <div className={styles.group}>
                <div className={styles.groupTitle}>Usage this month</div>
                <div className={styles.row}>
                  <div>
                    <div className={styles.rowLabel}>Comparisons used</div>
                    <div className={styles.rowDesc}>Resets at the end of your current billing cycle.</div>
                  </div>
                  <span className={styles.usageVal}>
                    {billingSummary?.comparisonsUsed ?? 0} / {billingSummary?.comparisonLimit ?? 0}
                  </span>
                </div>
                <div className={styles.row}>
                  <div>
                    <div className={styles.rowLabel}>LLM bulk edits used</div>
                    <div className={styles.rowDesc}>Powered by AI. Resets each billing cycle.</div>
                  </div>
                  <span className={styles.usageVal}>
                    {billingSummary?.llmEditsUsed ?? 0} / {billingSummary?.llmEditLimit ?? 0}
                  </span>
                </div>
                <div className={styles.row}>
                  <div>
                    <div className={styles.rowLabel}>Executive summaries used</div>
                    <div className={styles.rowDesc}>Powered by AI. Resets each billing cycle.</div>
                  </div>
                  <span className={styles.usageVal}>
                    {billingSummary?.executiveSummariesUsed ?? 0} / {billingSummary?.executiveSummaryLimit ?? 0}
                  </span>
                </div>
                {billingSummary?.status === 'TRIALING' && (
                  <div className={styles.trialUsageNotice}>
                    <span className={styles.trialUsageIcon} aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                    </span>
                    <p className={styles.trialUsageText}>
                      During your free trial, usage is limited to <strong>4 comparisons</strong>, <strong>2 LLM bulk edits</strong>, and <strong>2 executive summaries</strong>. Once you have used your trial amount, you can subscribe immediately for more comparisons.
                    </p>
                  </div>
                )}
                {!isCancellationScheduled && (
                  <div className={styles.row}>
                    <div>
                      <div className={styles.rowLabel}>Usage refresh date</div>
                    </div>
                    <span className={styles.usageVal}>{formatDate(billingSummary?.periodResetDate ?? null)}</span>
                  </div>
                )}
                {billingSummary?.usageLocked && (
                  <p className={styles.limitNotice}>
                    You have reached your limit. New comparisons unlock on {formatDate(billingSummary.periodResetDate)}.
                  </p>
                )}
                {billingSummary?.cancelAtPeriodEnd && (
                  <div className={styles.row}>
                    <div>
                      <div className={styles.rowLabel}>Subscription end date</div>
                      <div className={styles.rowDesc}>Your plan is scheduled to cancel at period end.</div>
                    </div>
                    <span className={styles.usageVal}>{formatDate(billingSummary.subscriptionEndsAt)}</span>
                  </div>
                )}
              </div>
              <div className={styles.group}>
                <div className={styles.groupTitle}>Purchase more comparisons</div>
                <div className={styles.row}>
                  <div>
                    <div className={styles.rowLabel}>{billingSummary?.addonOption?.label ?? 'No add-on available'}</div>
                    <div className={styles.rowDesc}>
                      {billingSummary?.addonOption?.priceLabel ?? 'Add-on options are tied to an active plan.'}
                    </div>
                  </div>
                  <span
                    className={styles.addonBtnWrapper}
                    data-tooltip={billingSummary?.status === 'TRIALING' ? 'Extra comparisons cannot be purchased during the trial period.' : undefined}
                  >
                    <button
                      className={styles.btn}
                      onClick={openAddonCheckout}
                      disabled={!billingSummary?.addonOption || addonLoading || billingSummary?.status === 'TRIALING'}
                    >
                      {addonLoading ? 'Opening…' : 'Purchase add-on'}
                    </button>
                  </span>
                </div>
              </div>
              {!isCancellationScheduled && (
                <div className={styles.group}>
                  <div className={styles.dangerZone}>
                    <h3>Cancel subscription</h3>
                    <p>Cancel your plan at the end of the current billing period. You will retain access until then.</p>
                    <Link className={styles.btnDanger} href="/app/settings/cancel">Cancel plan</Link>
                  </div>
                </div>
              )}
              {showKeepSubscriptionPrompt && (
                <div className={styles.promptOverlay}>
                  <div className={styles.promptCard}>
                    <h3>Keep your subscription?</h3>
                    <p>
                      Your plan is currently scheduled to end on {formatDate(billingSummary?.subscriptionEndsAt ?? null)}.
                      Do you want to keep your subscription active?
                    </p>
                    <div className={styles.promptActions}>
                      <button className={styles.btn} onClick={() => setShowKeepSubscriptionPrompt(false)} disabled={resumeLoading || planChangeLoading !== null}>
                        Not now
                      </button>
                      <button className={styles.btn} onClick={openTierSelectorFromPrompt} disabled={resumeLoading || planChangeLoading !== null}>
                        Choose tier
                      </button>
                      <button className={styles.btnDanger} onClick={keepSubscription} disabled={resumeLoading || planChangeLoading !== null}>
                        {resumeLoading ? 'Saving…' : 'Keep subscription'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {showTierSelector && (
                <div className={styles.promptOverlay}>
                  <div className={styles.promptCard}>
                    <h3>Choose your plan</h3>
                    <p>Select the tier you want to use going forward. Changes are applied directly from your settings.</p>
                    <div className={styles.planPickerList}>
                      {PLAN_ORDER.map((plan) => {
                        const isCurrentPlan = billingSummary?.plan === plan && !isCancellationScheduled;
                        const isLoadingPlan = planChangeLoading === plan;

                        return (
                          <div key={plan} className={styles.planPickerItem}>
                            <div className={styles.planPickerMeta}>
                              <div className={styles.planPickerName}>{PLAN_LABELS[plan]}</div>
                              <div className={styles.planPickerCopy}>{PLAN_COPY[plan]}</div>
                            </div>
                            <button
                              className={styles.btn}
                              onClick={() => void changePlan(plan)}
                              disabled={isCurrentPlan || planChangeLoading !== null || resumeLoading}
                            >
                              {isLoadingPlan
                                ? 'Updating…'
                                : isCurrentPlan
                                  ? 'Current plan'
                                  : `Switch to ${PLAN_LABELS[plan]}`}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                    <div className={styles.promptActions}>
                      <button className={styles.btn} onClick={() => setShowTierSelector(false)} disabled={planChangeLoading !== null || resumeLoading}>
                        Close
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {latestPlanChange && (
                <div className={styles.promptOverlay}>
                  <div className={styles.promptCard}>
                    {latestPlanChange.changeType === 'upgrade' && (
                      <>
                        <h3>Your account has been upgraded to {PLAN_LABELS[latestPlanChange.plan]} tier</h3>
                        <p>
                          The card on file has been charged the difference of {formatCurrencyFromCents(latestPlanChange.amountDueNowCents)}. You will be charged {formatCurrencyFromCents(latestPlanChange.nextChargeAmountCents)} on {latestChangeDate}.
                        </p>
                        <p className={styles.resultLine}>
                          {billingSummary?.status === 'TRIALING'
                            ? <>Your {PLAN_LABELS[latestPlanChange.plan]} plan ({latestPlanChange.effectiveComparisonLimit} comparisons/month) activates when your trial ends on {latestChangeDate}.</>
                            : <>You now have {latestPlanChange.effectiveComparisonLimit} comparisons to use before {latestChangeDate}.</>
                          }
                        </p>
                      </>
                    )}
                    {latestPlanChange.changeType === 'downgrade' && (
                      <>
                        <h3>Your downgrade to {PLAN_LABELS[latestPlanChange.plan]} tier is scheduled</h3>
                        <p>
                          Your current plan stays active until {latestChangeDate}. The card on file will be charged {formatCurrencyFromCents(latestPlanChange.nextChargeAmountCents)} for the {PLAN_LABELS[latestPlanChange.plan]} tier at that time.
                        </p>
                        <p className={styles.resultLine}>
                          You have {latestRemainingComparisons} remaining comparisons to use before the change takes effect.
                        </p>
                      </>
                    )}
                    {latestPlanChange.changeType === 'none' && (
                      <>
                        <h3>Your subscription is unchanged</h3>
                        <p>You are already on the selected tier.</p>
                      </>
                    )}
                    <div className={styles.promptActions}>
                      <button className={styles.btn} onClick={() => setLatestPlanChange(null)}>
                        Done
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {activeTab === 'Appearance' && (
            <>
              <h2>Appearance</h2>
              <p className={styles.desc}>Customize how ScopeSplit looks for you.</p>
              <div className={styles.group}>
                <div className={styles.groupTitle}>Theme</div>
                <div className={styles.themeOptions}>
                  <button type="button" className={`${styles.themeCard} ${theme === 'light' ? styles.themeSelected : ''}`} onClick={() => setTheme('light')}>
                    <div className={styles.themePreviewLight}>
                      <svg viewBox="0 0 80 60" fill="none" xmlns="http://www.w3.org/2000/svg" className={styles.themePreviewSvg}>
                        <rect x="8" y="6" width="30" height="40" rx="3" fill="#fff" stroke="#ccc" strokeWidth="1" />
                        <rect x="14" y="14" width="18" height="2" rx="1" fill="#ddd" />
                        <rect x="14" y="19" width="14" height="2" rx="1" fill="#ddd" />
                        <rect x="14" y="24" width="16" height="2" rx="1" fill="#ddd" />
                        <rect x="14" y="29" width="12" height="2" rx="1" fill="#ddd" />
                        <path d="M28 6V12H38" stroke="#ccc" strokeWidth="1" fill="#F0EFE9" />
                        <rect x="42" y="14" width="30" height="40" rx="3" fill="#fff" stroke="#b0cfeb" strokeWidth="1" />
                        <rect x="48" y="22" width="18" height="2" rx="1" fill="#d0e4f7" />
                        <rect x="48" y="27" width="14" height="2" rx="1" fill="#d0e4f7" />
                        <rect x="48" y="32" width="16" height="2" rx="1" fill="#d0e4f7" />
                        <rect x="48" y="37" width="12" height="2" rx="1" fill="#d0e4f7" />
                        <path d="M62 14V20H72" stroke="#b0cfeb" strokeWidth="1" fill="#e6f0fa" />
                      </svg>
                    </div>
                    <div className={styles.themeLabel}>Light</div>
                  </button>
                  <button type="button" className={`${styles.themeCard} ${theme === 'dark' ? styles.themeSelected : ''}`} onClick={() => setTheme('dark')}>
                    <div className={styles.themePreviewDark}>
                      <svg viewBox="0 0 80 60" fill="none" xmlns="http://www.w3.org/2000/svg" className={styles.themePreviewSvg}>
                        <rect x="8" y="6" width="30" height="40" rx="3" fill="#2e2e2e" stroke="#444" strokeWidth="1" />
                        <rect x="14" y="14" width="18" height="2" rx="1" fill="#444" />
                        <rect x="14" y="19" width="14" height="2" rx="1" fill="#444" />
                        <rect x="14" y="24" width="16" height="2" rx="1" fill="#444" />
                        <rect x="14" y="29" width="12" height="2" rx="1" fill="#444" />
                        <path d="M28 6V12H38" stroke="#444" strokeWidth="1" fill="#333" />
                        <rect x="42" y="14" width="30" height="40" rx="3" fill="#2e2e2e" stroke="#3a5570" strokeWidth="1" />
                        <rect x="48" y="22" width="18" height="2" rx="1" fill="#3a5570" />
                        <rect x="48" y="27" width="14" height="2" rx="1" fill="#3a5570" />
                        <rect x="48" y="32" width="16" height="2" rx="1" fill="#3a5570" />
                        <rect x="48" y="37" width="12" height="2" rx="1" fill="#3a5570" />
                        <path d="M62 14V20H72" stroke="#3a5570" strokeWidth="1" fill="#2a3d50" />
                      </svg>
                    </div>
                    <div className={styles.themeLabel}>Dark</div>
                  </button>
                </div>
              </div>
            </>
          )}

          {activeTab === 'Legal & Privacy' && (() => {
            const toggle = (key: string) => setOpenLegal(prev => {
              const next = new Set(prev);
              if (next.has(key)) { next.delete(key); } else { next.add(key); }
              return next;
            });
            const Chevron = ({ id }: { id: string }) => (
              <svg className={`${styles.legalAccordionChevron} ${openLegal.has(id) ? styles.legalAccordionChevronOpen : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
            );
            return (
              <>
                <h2>Legal &amp; Privacy</h2>
                <p className={styles.desc}>Review our policies and privacy information. Click any item to expand its full content.</p>

                <div className={styles.group}>
                  <div className={styles.groupTitle}>Privacy</div>

                  <div className={styles.legalAccordionItem}>
                    <button className={styles.legalAccordionTrigger} onClick={() => toggle('privacy')}>
                      <div><div className={styles.legalAccordionTitle}>Privacy Policy</div><div className={styles.legalAccordionDesc}>How we collect, use, and protect your personal data.</div></div>
                      <Chevron id="privacy" />
                    </button>
                    {openLegal.has('privacy') && (
                      <div className={styles.legalAccordionBody}>
                        <div className={styles.legalDocMeta}>Effective date: April 23, 2026</div>
                        <div className={styles.legalDocSection}><h2>Information we collect</h2><p>We collect account information (like name and email), billing details handled through Stripe, usage data needed to run the app, and estimate files and comparison outputs you upload.</p></div>
                        <div className={styles.legalDocSection}><h2>How we use information</h2><ul><li>Provide, maintain, and improve ScopeSplit</li><li>Process comparisons and generate dispute-ready outputs</li><li>Authenticate users and secure accounts</li><li>Process billing and subscription events</li><li>Respond to support and bug-report requests</li></ul></div>
                        <div className={styles.legalDocSection}><h2>Vendors and subprocessors</h2><p>We use service providers including Clerk (authentication), Stripe (billing), Supabase (data/storage), Anthropic (AI processing), and Resend (support email delivery) to operate the product.</p></div>
                        <div className={styles.legalDocSection}><h2>Data retention and deletion</h2><p>You can delete comparisons from your account. Account deletion requests remove associated account data, except where we must retain records for security, fraud prevention, legal, or accounting purposes.</p></div>
                        <div className={styles.legalDocSection}><h2>Contact</h2><p>Questions about privacy can be sent through our <Link href="/app/help?tab=bug">Contact Us</Link> form.</p></div>
                      </div>
                    )}
                  </div>

                  <div className={styles.legalAccordionItem}>
                    <button className={styles.legalAccordionTrigger} onClick={() => toggle('privacy-choices')}>
                      <div><div className={styles.legalAccordionTitle}>Your Privacy Choices</div><div className={styles.legalAccordionDesc}>Options and rights related to your personal information.</div></div>
                      <Chevron id="privacy-choices" />
                    </button>
                    {openLegal.has('privacy-choices') && (
                      <div className={styles.legalAccordionBody}>
                        <div className={styles.legalDocSection}><h2>Access, update, or delete data</h2><p>You can request access to, correction of, or deletion of personal information associated with your account, subject to legal and security obligations.</p></div>
                        <div className={styles.legalDocSection}><h2>Marketing and communication preferences</h2><p>You can opt out of non-essential communications at any time using unsubscribe links or by contacting us.</p></div>
                        <div className={styles.legalDocSection}><h2>Region-specific rights</h2><p>Depending on where you live, you may have additional rights under privacy laws such as CCPA/CPRA or GDPR. We honor valid requests in accordance with applicable law.</p></div>
                        <div className={styles.legalDocSection}><h2>Submit a request</h2><p>Use our <Link href="/app/help?tab=bug">Contact Us</Link> form and include &quot;Privacy Request&quot; in your message subject.</p></div>
                      </div>
                    )}
                  </div>

                  <div className={styles.legalAccordionItem}>
                    <button className={styles.legalAccordionTrigger} onClick={() => toggle('cookies')}>
                      <div><div className={styles.legalAccordionTitle}>Cookie Policy</div><div className={styles.legalAccordionDesc}>How cookies and similar technologies are used on ScopeSplit.</div></div>
                      <Chevron id="cookies" />
                    </button>
                    {openLegal.has('cookies') && (
                      <div className={styles.legalAccordionBody}>
                        <div className={styles.legalDocMeta}>Effective date: April 23, 2026</div>
                        <div className={styles.legalDocSection}><h2>What are cookies?</h2><p>Cookies are small text files stored in your browser that help websites remember preferences, authentication state, and usage behavior.</p></div>
                        <div className={styles.legalDocSection}><h2>How we use them</h2><ul><li>Essential cookies for sign-in and session security</li><li>Performance and analytics cookies to improve product usability</li><li>Preference cookies to remember interface settings where applicable</li></ul></div>
                        <div className={styles.legalDocSection}><h2>Managing cookies</h2><p>You can manage cookies through your browser settings. Disabling certain cookies may affect how parts of ScopeSplit function.</p></div>
                      </div>
                    )}
                  </div>

                  <div className={styles.legalAccordionItem}>
                    <button className={styles.legalAccordionTrigger} onClick={() => toggle('dpa')}>
                      <div><div className={styles.legalAccordionTitle}>Data Processing Addendum</div><div className={styles.legalAccordionDesc}>Terms for customers that require a formal data processing framework.</div></div>
                      <Chevron id="dpa" />
                    </button>
                    {openLegal.has('dpa') && (
                      <div className={styles.legalAccordionBody}>
                        <div className={styles.legalDocMeta}>Effective date: April 23, 2026</div>
                        <div className={styles.legalDocSection}><h2>Roles</h2><p>For customer content, the customer acts as data controller and ScopeSplit acts as data processor, processing data only on documented customer instructions.</p></div>
                        <div className={styles.legalDocSection}><h2>Security measures</h2><p>ScopeSplit maintains administrative, technical, and organizational safeguards intended to protect personal data against unauthorized access, alteration, disclosure, and destruction.</p></div>
                        <div className={styles.legalDocSection}><h2>Subprocessors</h2><p>ScopeSplit uses vetted subprocessors to deliver services. Current infrastructure and service providers are listed in our Privacy Policy.</p></div>
                        <div className={styles.legalDocSection}><h2>Requesting a signed DPA</h2><p>To request a signed DPA for your organization, contact us through the <Link href="/app/help?tab=bug">Contact Us</Link> form with your legal entity name and billing email.</p></div>
                      </div>
                    )}
                  </div>
                </div>

                <div className={styles.group}>
                  <div className={styles.groupTitle}>Terms &amp; Policies</div>

                  <div className={styles.legalAccordionItem}>
                    <button className={styles.legalAccordionTrigger} onClick={() => toggle('terms')}>
                      <div><div className={styles.legalAccordionTitle}>Terms of Service</div><div className={styles.legalAccordionDesc}>The rules and responsibilities for using ScopeSplit.</div></div>
                      <Chevron id="terms" />
                    </button>
                    {openLegal.has('terms') && (
                      <div className={styles.legalAccordionBody}>
                        <div className={styles.legalDocMeta}>Effective date: April 23, 2026</div>
                        <div className={styles.legalDocSection}><h2>Use of service</h2><p>ScopeSplit is provided for business use to compare estimate files and assist users in preparing disputes. You are responsible for uploaded content and for compliance with your local laws and contracts.</p></div>
                        <div className={styles.legalDocSection}><h2>Account security</h2><p>You must keep your login credentials secure and are responsible for activity under your account.</p></div>
                        <div className={styles.legalDocSection}><h2>Billing and subscriptions</h2><p>Paid plans renew according to your selected billing cycle unless canceled. Plan limits and usage caps apply based on your active subscription and purchased add-ons.</p></div>
                        <div className={styles.legalDocSection}><h2>Disclaimers</h2><p>ScopeSplit provides software tools and workflow assistance. Final claim, estimate, and dispute decisions remain your responsibility.</p></div>
                        <div className={styles.legalDocSection}><h2>Liability limits</h2><p>To the fullest extent permitted by law, ScopeSplit is not liable for indirect, incidental, special, consequential, or punitive damages arising from use of the service.</p></div>
                      </div>
                    )}
                  </div>

                  <div className={styles.legalAccordionItem}>
                    <button className={styles.legalAccordionTrigger} onClick={() => toggle('acceptable-use')}>
                      <div><div className={styles.legalAccordionTitle}>Acceptable Use Policy</div><div className={styles.legalAccordionDesc}>Rules that keep ScopeSplit reliable and safe for all customers.</div></div>
                      <Chevron id="acceptable-use" />
                    </button>
                    {openLegal.has('acceptable-use') && (
                      <div className={styles.legalAccordionBody}>
                        <div className={styles.legalDocSection}><h2>Allowed use</h2><p>Use ScopeSplit for lawful estimate comparison and dispute preparation workflows within your business.</p></div>
                        <div className={styles.legalDocSection}><h2>Prohibited activity</h2><ul><li>Attempting to access data that is not yours</li><li>Uploading malware or harmful code</li><li>Abusing rate limits, automation, or service infrastructure</li><li>Reverse engineering, scraping, or unauthorized data extraction</li><li>Using the platform for unlawful, deceptive, or fraudulent conduct</li></ul></div>
                        <div className={styles.legalDocSection}><h2>Enforcement</h2><p>We may suspend or terminate accounts that violate this policy to protect the platform and other users.</p></div>
                      </div>
                    )}
                  </div>

                  <div className={styles.legalAccordionItem}>
                    <button className={styles.legalAccordionTrigger} onClick={() => toggle('billing-refunds')}>
                      <div><div className={styles.legalAccordionTitle}>Billing &amp; Refund Policy</div><div className={styles.legalAccordionDesc}>Subscriptions, renewals, and refund eligibility.</div></div>
                      <Chevron id="billing-refunds" />
                    </button>
                    {openLegal.has('billing-refunds') && (
                      <div className={styles.legalAccordionBody}>
                        <div className={styles.legalDocSection}><h2>Subscriptions and renewals</h2><p>Paid plans renew automatically at the end of each billing period unless canceled beforehand from account settings.</p></div>
                        <div className={styles.legalDocSection}><h2>Upgrades and downgrades</h2><p>Plan upgrades take effect immediately. Downgrades take effect at the next billing cycle unless otherwise stated in your account.</p></div>
                        <div className={styles.legalDocSection}><h2>Refunds</h2><p>Fees are generally non-refundable unless required by law or explicitly approved by ScopeSplit in writing.</p></div>
                        <div className={styles.legalDocSection}><h2>Questions about charges</h2><p>If you believe a charge is incorrect, contact support through our <Link href="/app/help?tab=bug">Contact Us</Link> form with your account email and invoice details.</p></div>
                      </div>
                    )}
                  </div>

                  <div className={styles.legalAccordionItem}>
                    <button className={styles.legalAccordionTrigger} onClick={() => toggle('security')}>
                      <div><div className={styles.legalAccordionTitle}>Security</div><div className={styles.legalAccordionDesc}>How ScopeSplit approaches product and data security.</div></div>
                      <Chevron id="security" />
                    </button>
                    {openLegal.has('security') && (
                      <div className={styles.legalAccordionBody}>
                        <div className={styles.legalDocSection}><h2>Platform safeguards</h2><ul><li>Encrypted transport via HTTPS/TLS</li><li>Authenticated access with Clerk</li><li>Managed infrastructure and data services</li><li>Access controls and role-limited operational access</li></ul></div>
                        <div className={styles.legalDocSection}><h2>Operational security</h2><p>We monitor service health, investigate suspicious activity, and patch known vulnerabilities as part of regular maintenance and deployment workflows.</p></div>
                        <div className={styles.legalDocSection}><h2>Report a security issue</h2><p>If you believe you found a vulnerability, contact us immediately through the <Link href="/app/help?tab=bug">Contact Us</Link> form and include reproduction details.</p></div>
                      </div>
                    )}
                  </div>
                </div>
              </>
            );
          })()}

          {activeTab === 'Notifications' && (
            <>
              <h2>Notifications</h2>
              <p className={styles.desc}>Choose which notifications you receive.</p>
              {emailOptInError && <p className={styles.billingError}>{emailOptInError}</p>}
              <div className={styles.group}>
                <div className={styles.groupTitle}>Email notifications</div>
                <div className={styles.row}>
                  <div><div className={styles.rowLabel}>Product updates</div><div className={styles.rowDesc}>Receive emails about important updates, new features, and improvements.</div></div>
                  <button
                    type="button"
                    className={`${styles.toggle} ${emailOptIn ? styles.toggleOn : ''}`}
                    onClick={() => void setEmailOptInPreference(!emailOptIn)}
                    aria-pressed={emailOptIn}
                    disabled={!emailOptInLoaded || emailOptInLoading}
                  />
                </div>
              </div>
            </>
          )}

          {showPasswordModal && (
            <div className={styles.promptOverlay}>
              <div className={styles.promptCard}>
                <h3>Reset password</h3>
                <p>Enter your new password and confirm it. If verification is required, Clerk will prompt you.</p>
                <div className={styles.passwordForm}>
                  <input
                    type="text"
                    className={styles.input}
                    placeholder="New password"
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    disabled={passwordLoading}
                  />
                  <input
                    type="text"
                    className={styles.input}
                    placeholder="Confirm new password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    disabled={passwordLoading}
                  />
                </div>
                {passwordError && <p className={styles.billingError}>{passwordError}</p>}
                {passwordSuccess && <p className={styles.resultLine}>{passwordSuccess}</p>}
                <div className={styles.promptActions}>
                  <button
                    className={styles.btn}
                    onClick={closePasswordModal}
                    disabled={passwordLoading}
                  >
                    Close
                  </button>
                  <button className={styles.btn} onClick={handlePasswordReset} disabled={passwordLoading}>
                    {passwordLoading ? 'Saving…' : 'Update password'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
