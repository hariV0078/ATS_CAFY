# Project Change Log

## [2026-04-18] Bypassed Login Logic
To facilitate easier development and browsing, the following changes were made to bypass the mandatory authentication:

- **src/utils/supabase/middleware.ts**: Commented out the global redirect to `/login` for unauthenticated users. Refactored to only apply auth-based redirects (like admin protection) if a user is actually present.
- **src/app/applied/page.tsx**: Commented out the `redirect('/login')` call in the `AppliedJobsPage` component.
- **src/app/account/layout.tsx**: Commented out the `redirect('/login')` call in the `AccountLayout` component.
- **src/app/account/profile/page.tsx**: Commented out the `redirect('/login')` call and added a null user guard to prevent runtime errors when accessing profile metadata while not logged in.

## [2026-04-18] Updated Job Feed Pagination and Guest Access
To improve the browsing experience for all users:

- **src/app/actions/jobActions.ts**: Increased `PAGE_SIZE` to 10 and removed the `isPro` check that limited non-paying users to only the first page.
- **src/app/jobs/page.tsx**: Increased `PAGE_SIZE` to 10. Commented out the "You're seeing a preview of jobs" banner and adjusted the top padding to align the content directly with the navbar.
- **src/components/JobFeed.tsx**: 
    - Increased `GUEST_LIMIT` to 10 so unauthenticated users see more jobs initially.
    - Repurposed the "Get started free" guest CTA button to "Show more", allowing guests to load additional jobs directly without signing up.

- **src/app/actions/companyActions.ts**: Increased `PAGE_SIZE` to 10 and removed `isPro` restrictions on pagination.
- **src/app/actions/subscriptionActions.ts**: Forced `getSubscriptionStatus` to always return `{ isPro: true }`. This removes all paywalls and "Upgrade to Pro" prompts across the entire application for both guests and logged-in users.

*Note: These changes effectively open up the full jobs and companies database to all users regardless of their login or subscription status.*

