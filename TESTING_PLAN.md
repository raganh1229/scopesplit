# ScopeSplit — Comprehensive Testing Plan

> **Purpose**: Full manual QA checklist before public launch. Cover every feature, every flow, every edge case, every screen size.
> **Devices**: Desktop (1440px+), Laptop (1280px), Tablet (768px), Mobile (390px iPhone 14, 360px Android)
> **Browsers**: Chrome, Safari, Firefox, Edge · Mobile: Chrome iOS, Safari iOS
> **Status legend**: ⬜ Untested · ✅ Pass · ❌ Fail · ⚠️ Partial

---

## 1. Marketing Site

### 1.1 Homepage (`/`)
- [x] Page loads without errors on all breakpoints
- [x] Hero headline, subheadline, and CTA button render correctly
- [x] CTA button navigates to `/signup`
- [x] Pricing cards display correct prices: Starter $59, Professional $179, Business $349
- [x] Pricing cards display correct comparison limits: 10, 35, 100
- [x] Feature sections render and are readable on mobile
- [x] Navigation links work (all nav items route correctly)
- [x] Footer links all work (Privacy, Terms, FAQ, Contact, etc.)
- [x] Page is fully responsive — no horizontal scroll on any breakpoint
- [x] No console errors

### 1.2 FAQ Page (`/faq`)
- [x] All FAQ sections expand/collapse correctly
- [x] Plan pricing in FAQ reads: Starter $59/10, Professional $179/35, Business $349/100
- [x] Page is readable on mobile
- [x] No console errors

### 1.3 Contact Page (`/contact`)
- [x] Form renders with Name, Email, Message fields
- [x] Submitting empty form shows validation errors
- [x] Name over 120 chars is rejected
- [x] Email with invalid format is rejected
- [x] Message over 5000 chars is rejected
- [x] Valid submission shows success message
- [x] Email is received at configured inbox with correct reply_to header
- [x] No auth required to submit
- [x] No console errors

### 1.4 Legal Pages
- [x] `/privacy` loads and renders
- [x] `/terms` loads and renders
- [x] `/cookies` loads and renders
- [x] `/acceptable-use` loads and renders
- [x] `/security` loads and renders
- [x] `/billing-refunds` loads and renders
- [x] `/data-processing-addendum` loads and renders
- [x] All are readable on mobile

---

## 2. Authentication Flows

### 2.1 Sign Up (`/signup`)
- [ ] Page renders correctly on all breakpoints
- [ ] Email/password sign up works end-to-end
- [ ] Google OAuth sign up works end-to-end
- [ ] Duplicate email shows appropriate error
- [ ] Weak password is rejected with clear feedback
- [ ] After sign up, user is redirected to `/verify-phone`
- [ ] No console errors

### 2.2 Phone Verification (`/verify-phone`)
- [ ] Page renders after sign up
- [ ] Phone number input accepts valid format
- [ ] Invalid phone number shows error
- [ ] SMS is delivered within 30 seconds
- [ ] Correct OTP code completes verification
- [ ] Wrong OTP code shows error
- [ ] Expired OTP shows error
- [ ] After verification, user is redirected to `/subscribe`
- [ ] Attempting to skip `/verify-phone` still requires verification
- [ ] No console errors

### 2.3 Login (`/login`)
- [ ] Page renders correctly
- [ ] Email/password login works
- [ ] Google OAuth login works
- [ ] Wrong password shows error
- [ ] Non-existent email shows error
- [ ] After login, user is redirected to app or last visited page
- [ ] No console errors

### 2.4 Forgot Password (`/forgot-password`)
- [ ] Form renders
- [ ] Valid email submission sends reset email
- [ ] Invalid email shows error
- [ ] Reset email is received
- [ ] Reset link navigates to `/reset-password`

### 2.5 Reset Password (`/reset-password`)
- [ ] Form renders with new password and confirm fields
- [ ] Mismatched passwords show error
- [ ] Weak password is rejected
- [ ] Successful reset redirects to login
- [ ] Old password no longer works after reset

### 2.6 SSO Callback (`/sso-callback`)
- [ ] Google OAuth redirect completes without error
- [ ] User lands in app after successful OAuth

### 2.7 Subscribe Page (`/subscribe`)
- [ ] Redirects unauthenticated users to `/login`
- [ ] Shows all three plan cards with correct prices and limits
- [ ] Professional plan is highlighted as recommended
- [ ] Clicking a plan initiates Stripe checkout
- [ ] Trial is offered to eligible users (not used trial, not active subscriber)
- [ ] Trial is NOT offered to users who have already used it
- [ ] Cancel during checkout returns user to `/subscribe`

---

## 3. Stripe Checkout and Subscription

### 3.1 New Subscription Checkout
- [ ] Starter plan checkout completes with real card
- [ ] Professional plan checkout completes
- [ ] Business plan checkout completes
- [ ] After successful checkout, user redirected to `/app/new-comparison?checkout=success`
- [ ] Stripe dashboard shows subscription as Active
- [ ] User plan badge in Settings reflects correct plan
- [ ] `customer.subscription.created` webhook fires and delivers 200

### 3.2 Trial Checkout
- [ ] Trial applied when user is eligible
- [ ] Stripe shows 7-day trial period on subscription
- [ ] Trial phone number stored in Stripe customer metadata
- [ ] Trial IP hash stored in Stripe customer metadata (when TRIAL_IP_HASH_SALT is set)
- [ ] Second trial from same phone number rejected with 403
- [ ] Second trial from same IP rejected with 403
- [ ] `hasUsedTrial` flag set in DB after trial checkout

### 3.3 Add-on Purchase
- [ ] Starter add-on (5 comparisons, $34.99) checkout completes
- [ ] Professional add-on (10 comparisons, $64.99) checkout completes
- [ ] Business add-on (10 comparisons, $44.99) checkout completes
- [ ] After purchase, `addonComparisonsThisPeriod` increments correctly in DB
- [ ] Add-on comparisons reflected in Settings usage bar
- [ ] `checkout.session.completed` webhook fires and delivers 200
- [ ] Duplicate session replay does NOT double-grant comparisons (idempotency)

### 3.4 Plan Upgrade
- [ ] Upgrading Starter to Professional works
- [ ] Upgrading Starter to Business works
- [ ] Upgrading Professional to Business works
- [ ] Upgrade takes effect immediately
- [ ] Stripe subscription item updated to new price
- [ ] DB `subscriptionTier` updates to new tier
- [ ] Clerk `publicMetadata.plan` updates
- [ ] `customer.subscription.updated` webhook fires and delivers 200
- [ ] Comparison limit in Settings updates to new tier limit

### 3.5 Plan Downgrade
- [ ] Downgrading Business to Professional works
- [ ] Downgrading Business to Starter works
- [ ] Downgrading Professional to Starter works
- [ ] Downgrade is scheduled for end of billing period (not immediate)
- [ ] Pending downgrade badge shows in Settings with effective date
- [ ] User retains higher tier access until period ends
- [ ] Cancel downgrade removes pending downgrade
- [ ] `customer.subscription.updated` webhook fires correctly

### 3.6 Cancel Subscription
- [ ] Cancel confirmation modal appears
- [ ] User retains access until end of current billing period
- [ ] After period ends, plan is removed
- [ ] Stripe shows subscription as canceled
- [ ] DB `subscriptionStatus` becomes CANCELED after period ends
- [ ] Clerk `publicMetadata.plan` is cleared

### 3.7 Resume Subscription
- [ ] Resume button appears for canceled (but still active period) subscriptions
- [ ] Resuming reactivates the subscription in Stripe
- [ ] Plan access maintained without interruption

### 3.8 Webhook Health
- [ ] All 5 webhook events deliver 200 in Stripe dashboard
- [ ] `STRIPE_WEBHOOK_UNMAPPED_PRICE` does NOT appear in server logs
- [ ] Webhook signature verification rejects tampered payloads (returns 400)

---

## 4. New Comparison (`/app/new-comparison`)

### 4.1 Upload UI
- [ ] Page requires auth — unauthenticated users redirected to login
- [ ] Comparison Name field accepts text up to 80 characters
- [ ] Character counter shows correctly (e.g. "23/80")
- [ ] Format dropdowns render for both estimates
- [ ] Format options: Xactimate (PDF), Symbility (PDF), Xactimate (Excel/CSV)
- [ ] Drop zones disabled until a format is selected
- [ ] Selecting a format enables the drop zone and browse button
- [ ] Changing format after file upload clears the file
- [ ] "What Qualifies?" link reveals inline section
- [ ] "What Qualifies?" section can be closed
- [ ] Compare button disabled until name + both files + both formats are all set
- [ ] Trial banner shows for trial users

### 4.2 File Upload — PDF
- [ ] Drag and drop a valid Xactimate PDF onto Your Estimate drop zone
- [ ] File name appears in drop zone after upload
- [ ] Remove button (x) clears the file
- [ ] Dragging a non-PDF shows error: "Only PDF files are allowed."
- [ ] Browse button opens file picker filtered to .pdf

### 4.3 File Upload — Excel/CSV
- [ ] Drag and drop a valid .xlsx file
- [ ] Drag and drop a valid .xls file
- [ ] Drag and drop a valid .csv file
- [ ] Dragging a non-XLS file shows error about correct file types
- [ ] Browse button opens file picker filtered to .xlsx,.xls,.csv

### 4.4 Validation Errors
- [ ] Submit with no name: "Please enter a name for this comparison."
- [ ] Submit with no files: "Please upload both estimate files before comparing."
- [ ] Submit with no format: "Please select the estimate format for both files."
- [ ] Usage limit reached: shows used/limit/refresh date message

### 4.5 Processing State
- [ ] Form hides and processing state shows after submit
- [ ] Spinner and "Compiling zones..." headline appear
- [ ] Progress bar animates upward over time
- [ ] Elapsed seconds counter increments
- [ ] After 10 minutes, timeout error message appears
- [ ] FAILED status shows error message with pipeline detail

### 4.6 Successful Redirect
- [ ] COMPLETED status: progress hits 100% then redirects to `/app/comparison/[id]`
- [ ] AWAITING_ZONE_REVIEW: redirects to comparison page
- [ ] AWAITING_MATCH_REVIEW: redirects to comparison page
- [ ] AWAITING_LINE_ITEM_REVIEW: redirects to comparison page

### 4.7 Format Combinations
- [ ] Xactimate PDF vs Xactimate PDF
- [ ] Symbility PDF vs Symbility PDF
- [ ] Xactimate PDF vs Symbility PDF (cross-format)
- [ ] Xactimate XLS vs Xactimate PDF
- [ ] Xactimate XLS vs Xactimate XLS

---

## 5. Comparisons List (`/app/comparisons`)

### 5.1 List Display
- [ ] All user comparisons listed (paginated)
- [ ] Each row: Name, Date, Status badge, Gap amount
- [ ] Status badge colors: green (Completed), amber (Processing), gray (Failed)
- [ ] Gap shows dash when null, red when positive, green when negative
- [ ] Empty state message when no comparisons
- [ ] Loading state while fetching
- [ ] Error state if fetch fails

### 5.2 Pagination
- [ ] "Load more" button appears when more comparisons exist
- [ ] Clicking appends next page
- [ ] Spinner shows during load more
- [ ] "Load more" disappears when all records loaded

### 5.3 Rename
- [ ] Clicking "..." opens dropdown with Rename and Delete
- [ ] Clicking outside dropdown closes it
- [ ] Rename replaces name cell with pre-filled input
- [ ] Enter saves the rename
- [ ] Escape cancels
- [ ] Blank name not accepted
- [ ] Saved name updates in list immediately
- [ ] Max 200 chars enforced

### 5.4 Delete
- [ ] Clicking Delete shows confirmation dialog
- [ ] Cancel dismisses confirmation
- [ ] "Yes, delete" removes comparison from list
- [ ] Spinner shows while deleting
- [ ] Error message if delete fails

### 5.5 Navigation
- [ ] Clicking a row navigates to `/app/comparison/[id]`
- [ ] "New Comparison" button navigates to `/app/new-comparison`

---

## 6. Comparison Detail Page (`/app/comparison/[id]`)

### 6.1 Page Load
- [ ] Loads correctly for COMPLETED comparison
- [ ] Shows appropriate state for PROCESSING comparison
- [ ] Shows error state for FAILED comparison
- [ ] Unauthorized access (not owner) returns 403 or redirect
- [ ] Non-existent comparison ID returns 404

### 6.2 Version History
- [ ] Current active version is displayed
- [ ] Version selector shows all versions
- [ ] Switching versions updates the comparison table
- [ ] Active version clearly indicated

### 6.3 Comparison Table
- [ ] All matched line items display correctly
- [ ] Zone grouping headers show correctly
- [ ] Gap amounts calculated and displayed correctly
- [ ] Match status badges show correctly
- [ ] Table scrollable on long comparisons
- [ ] Table readable on mobile (horizontal scroll or stacked layout)

### 6.4 Inline Editing
- [ ] Clicking a cell enters edit mode
- [ ] "Save N changes as new version" button appears after edits
- [ ] Saving creates new version with correct recomputed values
- [ ] Canceling discards changes
- [ ] New version becomes active version after save

### 6.5 LLM Bulk Edit
- [ ] Prompt input renders
- [ ] Valid prompt triggers AI edit
- [ ] Loading state shows during AI call
- [ ] Result creates a new version
- [ ] Usage counter increments in Settings after each call
- [ ] Starter: blocked after 5 uses (usage limit error shown) — `PLAN_LLM_EDIT_LIMITS.STARTER = 5`
- [ ] Professional: blocked after 30 uses — `PLAN_LLM_EDIT_LIMITS.PROFESSIONAL = 30`
- [ ] Business: blocked after 100 uses — `PLAN_LLM_EDIT_LIMITS.ENTERPRISE = 100`
- [ ] Timeout at 45s shows appropriate error message

### 6.6 Executive Summary
- [ ] Generate button renders
- [ ] Clicking generates summary via AI
- [ ] Loading state shows during generation
- [ ] Summary renders with formatted content
- [ ] Print button opens print dialog in new window
- [ ] Regenerate triggers a fresh call
- [ ] Usage counter increments in Settings after each call
- [ ] Starter: blocked after 3 uses — `PLAN_EXECUTIVE_SUMMARY_LIMITS.STARTER = 3`
- [ ] Professional: blocked after 15 uses — `PLAN_EXECUTIVE_SUMMARY_LIMITS.PROFESSIONAL = 15`
- [ ] Business: blocked after 50 uses — `PLAN_EXECUTIVE_SUMMARY_LIMITS.ENTERPRISE = 50`
- [ ] Timeout at 55s shows appropriate error message

### 6.7 Zone Review (AWAITING_ZONE_REVIEW)
- [ ] Zone review UI renders for comparisons awaiting zone review
- [ ] User can correct detected zones
- [ ] Confirming zones advances pipeline to next stage
- [ ] Editing zones works correctly

### 6.8 Match Review (AWAITING_MATCH_REVIEW)
- [ ] Match review UI renders
- [ ] User can adjust matched pairs
- [ ] Confirming matches advances pipeline

### 6.9 Line Item Review (AWAITING_LINE_ITEM_REVIEW)
- [ ] Line item review UI renders
- [ ] User can re-extract or correct line items
- [ ] Confirming advances to completion

### 6.10 Notes
- [ ] Notes panel renders
- [ ] Adding a note saves correctly
- [ ] Notes persist across page refreshes
- [ ] Editing a note works
- [ ] Deleting a note works

### 6.11 PDF Export / Print
- [ ] Export/Print button generates a printable view
- [ ] Exported content includes all line items
- [ ] Formatting is clean in print preview

---

## 7. Settings (`/app/settings`)

### 7.1 Page Load and Tabs
- [ ] Page loads for authenticated user
- [ ] All tabs render and are clickable
- [ ] Tab switching works
- [ ] Active tab is visually indicated

### 7.2 Profile Tab
- [ ] Displays current user name and email
- [ ] Name can be edited and saved
- [ ] Profile changes persist after page refresh
- [ ] Account deletion option is present and requires confirmation

### 7.3 Plan and Billing Tab
- [ ] Current plan name and price display correctly
- [ ] Starter shows: "$59/month - Up to 10 comparisons"
- [ ] Professional shows: "$179/month - Up to 35 comparisons"
- [ ] Business shows: "$349/month - Up to 100 comparisons"
- [ ] Usage bars show: Comparisons used vs limit
- [ ] Usage bars show: LLM Edits used vs limit
- [ ] Usage bars show: Executive Summaries used vs limit
- [ ] Add-on comparisons shown separately when present
- [ ] Period reset date shown correctly
- [ ] "Change Plan" button opens plan selector modal
- [ ] Plan selector shows all three plans with correct prices and limits
- [ ] Upgrade flow works (see section 3.4)
- [ ] Downgrade flow works (see section 3.5)
- [ ] Pending downgrade badge shows with effective date
- [ ] "Cancel Downgrade" button works
- [ ] "Cancel Subscription" option present
- [ ] "Resume Subscription" shows for canceled subscriptions
- [ ] Add-on purchase button opens checkout

### 7.4 Cancel Subscription Page (`/app/settings/cancel`)
- [ ] Cancel confirmation page loads
- [ ] Confirming cancel calls API and returns to settings
- [ ] Confirmation shows access retained until period end

---

## 8. In-App Help (`/app/help`)

- [ ] Help page loads
- [ ] All sections expand/collapse correctly
- [ ] Plan pricing reads: Starter $59/10, Professional $179/35, Business $349/100
- [ ] Contact Us tab renders bug report form
- [ ] Bug report: name, email, message, optional screenshots (max 3, 5MB each)
- [ ] Submitting bug report sends email to configured inbox
- [ ] Screenshot upload works for jpeg, png, gif, webp
- [ ] Invalid file type is rejected
- [ ] File over 5MB is rejected
- [ ] More than 3 screenshots rejected
- [ ] Auth required for bug report submission (unauthenticated gets 401)

---

## 9. Security and Access Control

### 9.1 Authentication Guards
- [ ] All `/app/*` routes redirect unauthenticated users to `/login`
- [ ] All protected API routes return 401 for unauthenticated requests
- [ ] `/api/webhooks/clerk` is public (no auth required)
- [ ] `/api/webhooks/stripe` is public (no auth required)
- [ ] `/api/inngest` is public (no auth required)
- [ ] `/api/contact` is public (no auth required)

### 9.2 Ownership Checks
- [ ] User A cannot view User B comparisons via API
- [ ] User A cannot delete User B comparison
- [ ] User A cannot edit User B comparison
- [ ] User A cannot generate executive summary for User B comparison

### 9.3 Subscription Guards
- [ ] Users with no active subscription cannot create comparisons
- [ ] Users at usage limit receive correct error with refresh date
- [ ] Expired/canceled users lose access after period ends

### 9.4 Trial Abuse Guards
- [ ] Phone number reuse blocks second trial
- [ ] IP hash check blocks second trial from same network
- [ ] Unverified users cannot access trial checkout

---

## 10. Usage Limits and Billing Reset

- [ ] Comparisons counter increments on each successful comparison creation
- [ ] LLM edits counter increments on each successful apply-edits call
- [ ] Executive summaries counter increments on each successful summary generation
- [ ] All counters reset to 0 when new billing period begins
- [ ] Add-on comparisons added to addon pool separately
- [ ] Usage limit check correctly sums plan limit + addon comparisons
- [ ] Settings usage bars accurately reflect DB values in real time

---

## 11. Unverified Account Cleanup

- [ ] POST to `/api/internal/cleanup-unverified-users` with correct secret header returns 200
- [ ] Without secret header returns 401/403
- [ ] Without `UNVERIFIED_ACCOUNT_CLEANUP_ENABLED=true` returns disabled response
- [ ] Stale unverified accounts (no phone, older than MAX_AGE_HOURS) are deleted from Clerk
- [ ] Corresponding Supabase users row is also deleted
- [ ] Verified or non-stale accounts are NOT deleted
- [ ] Vercel Cron triggers the route daily at 04:00 UTC (check Vercel Cron logs)

---

## 12. Clerk Webhook Sync

- [ ] `user.created` inserts row in Supabase users table
- [ ] `user.updated` updates row in Supabase users table
- [ ] `user.deleted` deletes row from Supabase users table
- [ ] Webhook signature verification rejects tampered payloads
- [ ] Clerk dashboard shows all events as successfully delivered

---

## 13. Responsive Design and Devices

### 13.1 Breakpoints to Test on Every App Screen
- **390px** — iPhone 14 / small mobile
- **430px** — iPhone 14 Pro Max
- **360px** — Android (Samsung Galaxy S)
- **768px** — iPad portrait / tablet
- **1024px** — iPad landscape / small laptop
- **1280px** — laptop
- **1440px+** — desktop

### 13.2 Mobile-Specific Checks
- [ ] Mobile app bar renders on all app pages on mobile
- [ ] Sidebar/nav collapses on mobile
- [ ] Mobile nav menu opens and closes correctly
- [ ] Touch targets are large enough (min 44x44px)
- [ ] No horizontal scroll on any page
- [ ] FAQ/Help tap-to-expand works on touch
- [ ] File upload (browse + drag-drop) works on mobile browsers
- [ ] Comparison table scrolls horizontally on mobile without breaking layout
- [ ] Settings modal is usable on mobile
- [ ] Trial banner is readable and dismissable on mobile

### 13.3 Tablet
- [ ] Layout adapts correctly at 768px tablet portrait
- [ ] Two-column layouts stack appropriately
- [ ] No overlapping elements

---

## 14. Error States and Edge Cases

- [ ] 404 page renders for unknown routes
- [ ] Error boundary renders when an unhandled error occurs
- [ ] Network offline: upload failure shows user-friendly error
- [ ] Very large PDF (50+ pages) upload does not time out client-side
- [ ] Comparison with 0 line items handles gracefully
- [ ] Comparison with 1000+ line items renders without crashing
- [ ] Special characters in comparison name handled correctly
- [ ] Concurrent comparison submissions by same user handled correctly
- [ ] Stripe webhook replay (duplicate event) does not double-process

---

## 15. Performance and Accessibility

### 15.1 Performance
- [ ] Homepage Lighthouse Performance score above 80
- [ ] No significant layout shift on page load (CLS below 0.1)
- [ ] Comparison list loads in under 2 seconds on good connection
- [ ] No unusually large JS bundles

### 15.2 Accessibility
- [ ] All form inputs have associated labels
- [ ] All icon-only buttons have descriptive aria-label
- [ ] Color contrast meets WCAG AA (4.5:1 for normal text)
- [ ] Tab order is logical on all forms
- [ ] Modals trap focus correctly
- [ ] Screen reader announces loading states

---

## 16. Email Delivery

- [ ] Bug report email received at configured inbox with correct subject and reply_to
- [ ] Contact form email received with correct subject and reply_to
- [ ] Bug report with 1 screenshot attachment delivers correctly
- [ ] Bug report with 3 screenshot attachments delivers correctly
- [ ] Sender shows as bugs@scopesplit.com (Resend domain verified)

---

## 17. Unit Test Suite Regression

Run `npx vitest run` from `estimatch-app/` and verify all tests pass:

- [ ] All 16 pricing tests pass (`__tests__/billing/plan-pricing.test.ts`)
  - Starter = 5900 cents, Professional = 17900, Business = 34900
  - Comparison limits: STARTER=10, PROFESSIONAL=35, ENTERPRISE=100
  - LLM edit limits: STARTER=5, PROFESSIONAL=30, ENTERPRISE=100 (from `lib/plan-constants.ts`)
  - Executive summary limits: STARTER=3, PROFESSIONAL=15, ENTERPRISE=50
  - Volume discount ordering is correct
- [ ] All 21 zone-merge tests pass (`__tests__/n2/zone-merge.test.ts`)
- [ ] All 14 chunk-pdf tests pass (`__tests__/n2/chunk-pdf.test.ts`)
- [ ] All 128 normalization tests pass (`__tests__/n3/normalization.test.ts`)
- [ ] All 14 api-match-review tests pass (`__tests__/n2/api-match-review.test.ts`) — *note: rewrote to test N3/N4 paths (Jun 5, 2026)*
- [ ] All 27 ai-response tests pass (`__tests__/n2/ai-response.test.ts`)
- [ ] **Total: 220 tests, 0 failures** *(match-zones-parse.test.ts deleted Jun 5, 2026 — 16 tests removed)*

---

## 18. Final Go-Live Signoff

Reference `PRODUCTION_CUTOVER_CHECKLIST.md` Section 9 for the complete signoff list. Key gates:

- [ ] One full production Stripe checkout updates DB and grants app access
- [ ] In-app plan change modal drives upgrade/downgrade correctly
- [ ] Cancel and resume subscription flows work end-to-end
- [ ] Add-on purchase grants comparisons correctly
- [ ] Billing summary API returns correct plan, usage, and add-on data
- [ ] Resend sender domain verified — both email routes deliver
- [ ] No test/dev keys present in any production env var
- [ ] STRIPE_CHECKOUT_SUCCESS_URL and STRIPE_CHECKOUT_CANCEL_URL deleted or empty (unused)
- [ ] Secrets exposed during dev rotated (see PRODUCTION_CUTOVER_CHECKLIST.md Section 8)
- [ ] Inngest Cloud production environment synced and first comparison completes PENDING to COMPLETED
